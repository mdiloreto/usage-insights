import { execFile } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildModelSeries, clampRefreshSeconds, compactDashboard, deriveDashboard, isDay, normalizeConfig,
} from "../analytics.js";
import { readCommittedSnapshot } from "../collector.mjs";
import {
  fleetMachines, MAX_CACHE_BYTES, readFleetMachine, REASON_NOT_INSIGHTS, REASON_UNREACHABLE, UNREADABLE_EXIT_CODE,
} from "./fleet.mjs";
import { isPlainObject } from "./util.mjs";

const MAX_OPTIONS_BYTES = 16 * 1024;
const MAX_FLEET_CACHE_BYTES = 32 * 1024 * 1024;
// Core's JSON wraps base64 for up to 8 MiB stdout and 1 MiB stderr.
const MAX_CORE_JSON_BYTES = Math.ceil((MAX_CACHE_BYTES + 1024 * 1024) / 3) * 4 + 4096;
const CACHE_TIMEOUT_MS = 6_000;
const FLEET_TIMEOUT_MS = 20_000;
const FLEET_CONCURRENCY = 4;
const MAX_APP_SETTINGS_BYTES = 64 * 1024;

function validName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(name) && name.trim() === name;
}

export function parseMachineOptions(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_OPTIONS_BYTES) return null;
  let input;
  try { input = JSON.parse(raw); } catch { return null; }
  const { scope, remoteNames } = input ?? {};
  if (!isPlainObject(scope) || !["all", "local", "remote"].includes(scope.kind)
    || Object.keys(scope).some((key) => key !== "kind" && key !== "name")
    || (scope.kind === "remote" ? !validName(scope.name) : Object.hasOwn(scope, "name"))
    || !Array.isArray(remoteNames) || !remoteNames.every(validName)
    || (Object.hasOwn(input, "filters") && (!isPlainObject(input.filters)
      || !Object.values(input.filters).every((value) => value === null || typeof value === "string")))) return null;
  return input;
}

function capture(binary, args, limits) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { ...limits, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error && !Number.isInteger(error.code)) reject(error);
      else resolve({ stdout, code: error?.code ?? 0 });
    });
    child.stdin.end();
  });
}

async function coreSettings() {
  const appHome = process.env.HERDR_APP_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "herdr-app");
  if (!path.isAbsolute(appHome)) return null;
  let file;
  try {
    file = await open(path.join(appHome, "settings.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) return null;
    const data = Buffer.alloc(MAX_APP_SETTINGS_BYTES + 1);
    const { bytesRead } = await file.read(data);
    if (bytesRead > MAX_APP_SETTINGS_BYTES) return null;
    const settings = JSON.parse(data.subarray(0, bytesRead));
    return isPlainObject(settings) ? { override: settings.core ?? null } : null;
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

// The presenter inherits the App's environment, so PATH can start with
// directories unrelated to the Core (a GUI app bundle, for example). Every
// absolute PATH entry is scanned for a Core binary. A configured executable
// must live in one of those directories and never falls back to another binary.
async function findCore(signal, override) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry));
  let candidates;
  if (override === null) {
    candidates = dirs.flatMap((dir) => ["herdr-core", "hc"].map((name) => path.join(dir, name)));
  } else {
    if (typeof override !== "string" || /[\u0000-\u001f\u007f]/.test(override)) return null;
    const configured = override.startsWith("~/") ? `${homedir()}/${override.slice(2)}` : override;
    if (!path.isAbsolute(configured) || !dirs.includes(path.resolve(path.dirname(configured)))) return null;
    candidates = [configured];
  }
  for (const binary of candidates) {
    signal.throwIfAborted();
    try {
      const { stdout, code } = await capture(binary, ["--version"], {
        signal, timeout: 1_000, maxBuffer: 4096,
      });
      if (code === 0 && /^hc \d+\.\d+\.\d+\b/.test(stdout)) return binary;
    } catch { /* unavailable candidate */ }
  }
  return null;
}

function coreExec(binary, signal) {
  let remaining = MAX_FLEET_CACHE_BYTES;
  return async (command, args, { on, timeout }) => {
    signal.throwIfAborted();
    let stdout;
    try {
      ({ stdout } = await capture(binary, [
        "exec", "--json", `--on=${on}`, "--timeout", String(timeout / 1000), "--", command, ...args,
      ], { signal, timeout: timeout + 3_000, maxBuffer: MAX_CORE_JSON_BYTES }));
    } catch (error) {
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { code: UNREADABLE_EXIT_CODE };
      throw error;
    }
    const result = JSON.parse(stdout);
    if (!isPlainObject(result) || Object.hasOwn(result, "error") || result.timed_out !== false
      || typeof result.truncated !== "boolean" || !Number.isInteger(result.code)
      || typeof result.stdout !== "string") throw new Error("invalid Core exec result");
    const decoded = Buffer.from(result.stdout, "base64");
    if (result.truncated || decoded.length > MAX_CACHE_BYTES || decoded.length > remaining
      || !isUtf8(decoded) || decoded.toString("base64") !== result.stdout) {
      return { code: UNREADABLE_EXIT_CODE, stdout: "" };
    }
    remaining -= decoded.length;
    return { code: result.code, stdout: decoded.toString("utf8") };
  };
}

function usableRow(row) {
  return isPlainObject(row) && typeof row.day === "string" && isDay(row.day)
    && ["session", "harness", "provider", "model", "project"].every((key) => typeof row[key] === "string")
    && isPlainObject(row.tokens)
    && ["input", "output", "cacheRead", "cacheWrite", "total"].some((key) => Object.hasOwn(row.tokens, key))
    && ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"].every((key) =>
      !Object.hasOwn(row.tokens, key) || (Number.isSafeInteger(row.tokens[key]) && row.tokens[key] >= 0))
    && ["messages", "activeMs", "longestTaskMs"].every((key) =>
      !Object.hasOwn(row, key) || (Number.isSafeInteger(row[key]) && row[key] >= 0));
}

async function readRemotes(names, exec) {
  if (!names.length) return [];
  if (!exec) {
    const signal = AbortSignal.timeout(FLEET_TIMEOUT_MS);
    const settings = await coreSettings();
    if (!settings) return names.map((name) => ({ name, reason: "could not verify Herdr Core settings" }));
    const binary = await findCore(signal, settings.override);
    if (!binary) {
      const reason = settings.override === null ? REASON_UNREACHABLE : "configured Herdr Core unavailable";
      return names.map((name) => ({ name, reason }));
    }
    exec = coreExec(binary, signal);
  }
  const entries = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(names.length, FLEET_CONCURRENCY) }, async () => {
    while (index < names.length) {
      const position = index++;
      const result = await readFleetMachine({ name: names[position] }, { exec, timeout: CACHE_TIMEOUT_MS });
      entries[position] = result.ok && !result.rows.every(usableRow)
        ? { name: result.name, reason: REASON_NOT_INSIGHTS }
        : result;
    }
  }));
  return entries;
}

async function readLocal(store) {
  try {
    return await readCommittedSnapshot(store);
  } catch {
    return null;
  }
}

function coverageFor(entry, now) {
  const { name, reason } = entry;
  if (reason) return { name, status: "unavailable", ageMs: null, reason };
  const saved = typeof entry.savedAt === "string" ? Date.parse(entry.savedAt) : Number.NaN;
  const ageMs = Number.isFinite(saved) ? Math.max(0, now - saved) : null;
  const refresh = entry.config?.refreshSeconds;
  const refreshSeconds = clampRefreshSeconds(typeof refresh === "number" ? refresh : undefined);
  const status = ageMs === null || ageMs > refreshSeconds * 1000 ? "stale" : "fresh";
  return { name, status, ageMs, reason: null };
}

function* rowsByMachine(rows) {
  for (const { day, tokens, machine } of rows) {
    // Quoted route keys bypass the model helper's "unknown" normalization.
    yield { day, tokens, model: JSON.stringify(machine) };
  }
}

function machineHistory({ periodRows, modelSeries }, config, hostCount) {
  const { models, weeks, ...series } = buildModelSeries(rowsByMachine(periodRows), {
    weeks: modelSeries.weeks.length,
    endDay: modelSeries.range.end,
    weekStartsOn: config.weekStartsOn,
    includeCache: config.includeCache,
    limit: hostCount,
  });
  return {
    ...series,
    machines: models.map((key) => JSON.parse(key)),
    weeks: weeks.map((week) => ({
      ...week,
      segments: week.segments.map(({ name, tokens }) => ({ name: JSON.parse(name), tokens })),
    })),
  };
}

export async function machineDashboard(store, { scope, remoteNames, ...options }, exec) {
  const names = scope.kind === "all"
    ? fleetMachines([...new Set(remoteNames)].map((name) => ({ name }))).map(({ name }) => name)
    : scope.kind === "remote" && remoteNames.includes(scope.name) ? [scope.name] : [];
  const wantsLocal = scope.kind !== "remote";
  const needsViewerConfig = names.length && (typeof options.includeCache !== "boolean" || ![0, 1].includes(options.weekStartsOn));
  const [local, remotes] = await Promise.all([
    wantsLocal || needsViewerConfig ? readLocal(store) : null,
    readRemotes(names, exec),
  ]);
  const entries = !wantsLocal
    ? remotes.length ? remotes : [{ name: scope.name, reason: "machine is not registered" }]
    : [
      local?.savedAt || local?.rows.length
        ? { ...local, name: null }
        : { name: null, reason: local ? "no cache on that machine" : "cache unreadable" },
      ...remotes,
    ];

  const now = Date.now();
  const machines = entries.map((entry) => coverageFor(entry, now));
  const readable = machines.filter(({ status }) => status !== "unavailable").length;
  const coverage = {
    total: machines.length,
    readable,
    stale: machines.filter(({ status }) => status === "stale").length,
    partial: readable < machines.length,
    machines,
  };

  let dashboard = null;
  if (readable > 0) {
    const viewer = normalizeConfig(local?.config);
    const config = {
      includeCache: typeof options.includeCache === "boolean" ? options.includeCache : viewer.includeCache,
      weekStartsOn: [0, 1].includes(options.weekStartsOn) ? options.weekStartsOn : viewer.weekStartsOn,
    };
    const rows = [];
    for (const entry of entries) {
      if (entry.reason) continue;
      for (const row of entry.rows) {
        const session = scope.kind === "all" && row.session ? JSON.stringify([entry.name, row.session]) : row.session;
        rows.push({ ...row, machine: entry.name, session });
      }
    }
    const derived = deriveDashboard({ config, rows }, options);
    dashboard = compactDashboard(derived);
    if (scope.kind === "all") dashboard.machineSeries = machineHistory(derived, config, readable);
    dashboard.config = config;
  }
  return { version: 1, kind: "insights-machine-dashboard", scope, coverage, dashboard };
}
