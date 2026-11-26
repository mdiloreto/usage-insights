import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { epoch, HISTORY, object, resetTime, STALE, usagePlan, validReading } from "./normalize.mjs";
import { ProbeError } from "./runtime.mjs";
import { directory, homeDirectory } from "./state.mjs";

// The record is Omarchy's private collector output. Pin its schema and fail closed on drift.
const SCHEMA_VERSION = 1;
const MAX_RECORD = 64 * 1024;
const MAX_LIMITS = 32;
const MAX_LABEL = 80;
const HOUR = 3_600;
const WEEK = 7 * 24 * HOUR;
const SESSION = /^Session(?: \(5-hour\))?$/;
const WEEKLY = /^Weekly(?: \(7-day\))?$/;
const SCOPED = /^(Opus|Sonnet|Haiku|Fable|Cowork) Weekly$/;
const MONTHLY = /^Monthly allowance$/;

const malformed = () => { throw new ProbeError("malformed"); };
const unreadable = (status) => ({ status, reading: null, current: false });

function classify(entry) {
  for (const text of [entry.label, entry.title]) {
    if (typeof text !== "string") continue;
    if (SESSION.test(text)) return { kind: "session" };
    if (WEEKLY.test(text)) return { kind: "weekly" };
    if (MONTHLY.test(text)) return { kind: "monthly" };
    const scope = SCOPED.exec(text)?.[1];
    if (scope) return { kind: "scoped", scope };
  }
  return null;
}

function windowFor(provider, { kind, scope }, hasSession) {
  if (provider === "codex") {
    if (kind === "session") return ["codex:primary", 5 * HOUR];
    if (kind === "weekly") return [hasSession ? "codex:secondary" : "codex:primary", WEEK];
    return null;
  }
  if (provider === "copilot") return kind === "monthly" ? ["monthly", null] : null;
  if (kind === "session") return ["session", 5 * HOUR];
  if (kind === "weekly") return ["weekly_all", WEEK];
  return provider === "claude" && kind === "scoped" ? [`weekly_scoped:${scope}`, WEEK] : null;
}

// A 0-1 fraction becomes an integer percent that never reads 100 while capacity is left.
function percentOf(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) malformed();
  return value >= 1 ? 100 : Math.min(99, Math.floor(value * 100 + 1e-9));
}

const UNSAFE = /[@\p{Cc}\p{Zl}\p{Zp}]/u;
const unsafeText = (text) => typeof text === "string" && (text.length > MAX_LABEL || UNSAFE.test(text));

function limits(provider, value) {
  if (!Array.isArray(value) || value.length > MAX_LIMITS) malformed();
  const kept = [];
  for (const entry of value) {
    if (!object(entry)) malformed();
    if (unsafeText(entry.label) || unsafeText(entry.title)) continue;
    const match = classify(entry);
    if (match) kept.push({ entry, match });
  }
  const hasSession = kept.some(({ match }) => match.kind === "session");
  const windows = [];
  for (const { entry, match } of kept) {
    const mapped = windowFor(provider, match, hasSession);
    if (!mapped) continue;
    if (typeof entry.resetsAt !== "string") malformed();
    windows.push({ id: mapped[0], percent: percentOf(entry.percent), durationSec: mapped[1],
      resetsAt: entry.resetsAt === "" ? null : resetTime(entry.resetsAt) });
  }
  if (new Set(windows.map((w) => w.id)).size !== windows.length) malformed();
  return windows;
}

const planOf = (provider, label) => {
  if (typeof label !== "string") return null;
  const tier = label.trim().toLowerCase().replace(/\s+\d+x?$/, "").replace(/^pro lite$/, "prolite");
  return usagePlan(provider, tier);
};

/**
 * Pure projection of one record. Returns { status, reading, current }; a status other
 * than "ok" never carries a reading. Time and window failures throw nothing past here.
 */
export function parseHostRecord(provider, text, now) {
  try {
    let record;
    try { record = JSON.parse(text); } catch { malformed(); }
    if (!object(record)) malformed();
    if (record.schemaVersion !== SCHEMA_VERSION) return unreadable("unsupported-source");
    if (record.id !== provider || typeof record.ready !== "boolean" || typeof record.limitsStale !== "boolean") malformed();
    if (record.accounts !== undefined) {
      if (!Array.isArray(record.accounts)) malformed();
      if (record.accounts.length) return unreadable("unsupported");
    }
    const { limitsFetchedAt } = record;
    if (typeof limitsFetchedAt !== "number" || !Number.isFinite(limitsFetchedAt) || limitsFetchedAt <= 0) {
      return unreadable("unavailable");
    }
    const observedAt = Math.floor(limitsFetchedAt / 1_000);
    if (!epoch(observedAt)) malformed();
    const windows = limits(provider, record.limits);
    if (observedAt > now || now - observedAt >= HISTORY) return unreadable("unavailable");
    if (!windows.length) return unreadable("unsupported");
    const reading = validReading(provider, { observedAt, source: "host", account: null,
      plan: planOf(provider, record.tierLabel), windows });
    if (!reading) malformed();
    const current = record.ready && !record.limitsStale && now - observedAt < STALE &&
      !reading.windows.every((w) => w.resetsAt !== null && w.resetsAt <= now);
    return { status: "ok", reading, current };
  } catch (error) {
    if (error instanceof ProbeError) return unreadable("malformed");
    throw error;
  }
}

async function usageDirectory() {
  const home = await homeDirectory();
  const xdg = process.env.XDG_STATE_HOME;
  let dir = await directory(xdg && path.isAbsolute(xdg) && path.resolve(xdg) === xdg ?
    xdg : path.join(home, ".local", "state"));
  for (const part of ["omarchy", "agents", "usage"]) dir = await directory(path.join(dir, part));
  return dir;
}

/** Reads exactly one allowlisted id; the directory is never listed. */
export async function readHostRecord(provider, now, dir = null) {
  let handle;
  try {
    const file = path.join(dir ?? await usageDirectory(), `${provider}.json`);
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      return unreadable(error.code === "ELOOP" ? "malformed" : "unavailable");
    }
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.geteuid() || (info.mode & 0o022) !== 0 || info.size > MAX_RECORD) {
      return unreadable("malformed");
    }
    const data = Buffer.alloc(MAX_RECORD + 1);
    let read = 0;
    while (read < data.length) {
      const { bytesRead } = await handle.read(data, read, data.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read > MAX_RECORD) return unreadable("malformed");
    return parseHostRecord(provider, data.toString("utf8", 0, read), now);
  } catch (error) {
    if (error instanceof ProbeError) return unreadable("unavailable");
    throw error;
  } finally {
    await handle?.close();
  }
}

/** The host's own bounded refresh for one provider; null when it is absent or unsafe. */
export async function refreshExecutable(file = null) {
  try {
    const target = file ?? path.join(await homeDirectory(), ".local", "bin", "herdr-fleet-quota-refresh");
    const info = await stat(target);
    if (!info.isFile() || info.uid !== process.geteuid() || (info.mode & 0o022) !== 0) return null;
    await access(target, constants.X_OK);
    return target;
  } catch { return null; }
}

/** Runs it once with a fixed argv and no stdio, killing the whole group at the deadline. */
export function runRefresh(executable, provider, context, maxMs) {
  return new Promise((resolve) => {
    const remaining = Math.min(maxMs, context.deadline - performance.now());
    if (context.signal?.aborted || remaining <= 0) return resolve(false);
    const child = spawn(executable, [provider], { cwd: context.cwd, env: context.env, detached: true, stdio: "ignore" });
    const killGroup = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const done = (ok) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", killGroup);
      resolve(ok);
    };
    const timer = setTimeout(killGroup, remaining);
    context.signal?.addEventListener("abort", killGroup, { once: true });
    child.once("error", () => done(false));
    child.once("close", (code) => { killGroup(); done(code === 0); });
  });
}
