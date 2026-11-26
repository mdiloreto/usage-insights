import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, isLockBusyError, withStoreLock } from "../../mods/insights/core/util.mjs";
import { epoch, HISTORY, object, STALE, validReading, WIRE_VERSION } from "./normalize.mjs";
import { readHostRecord, refreshExecutable, runRefresh } from "./host.mjs";
import { probe } from "./providers.mjs";
import { cliContext, ProbeError } from "./runtime.mjs";

const NORMAL = 300;
const MISSING = 3_600;
const REFRESH = 30;
const BACKOFF = 900;
const MAX_CLOCK_SKEW = 60;
const HOST_FRESH = 90;
const HOST_READ_GAP = 60;
const HOST_REFRESH_MS = 8_000;
export const PROVIDERS = ["codex", "claude", "copilot", "agy"];
const MAX_STATE = 16 * 1024;
const MONTHLY_WINDOW = "monthly_spend_limit";
const FAILURES = new Set(["missing-cli", "auth-expired", "unsupported", "malformed",
  "rate-limited", "timeout", "unavailable", "identity-changed"]);
const EXTERNAL_AUTH = {
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_BASE_URL"],
};

const nowSec = () => Math.floor(Date.now() / 1_000);
const invalid = () => { throw new ProbeError("malformed"); };
const uid = () => process.geteuid();

async function inspect(file) {
  try { return await lstat(file); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function directory(dir, { create = false, privateDir = false } = {}) {
  if (create) {
    await mkdir(dir, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const info = await inspect(dir);
  if (!info?.isDirectory() || info.uid !== uid() ||
    (info.mode & (privateDir ? 0o077 : 0o022)) !== 0) throw new ProbeError("unavailable");
  return dir;
}

export async function homeDirectory() {
  const home = process.env.HOME;
  if (!home || home === "/" || !path.isAbsolute(home) || path.resolve(home) !== home) {
    throw new ProbeError("unavailable");
  }
  return directory(home);
}

async function stateFile(provider) {
  const home = await homeDirectory();
  const local = await directory(path.join(home, ".local"), { create: true });
  const state = await directory(path.join(local, "state"), { create: true });
  const quota = await directory(path.join(state, "herdr-quota-v1"), { create: true, privateDir: true });
  return path.join(quota, `${provider}.json`);
}

function isPrivateFile(info, max = MAX_STATE) {
  return info?.isFile() && info.uid === uid() && info.nlink === 1 &&
    (info.mode & 0o077) === 0 && info.size <= max;
}

async function validateLock(file) {
  const lock = `${file}.lock`;
  const info = await inspect(lock);
  if (!info) return;
  if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o077) !== 0) invalid();
  // withStoreLock reads its owner file. Refuse foreign, linked or unbounded nodes.
  const owners = await readdir(lock).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (owners.length > 1) invalid();
  for (const name of owners) {
    if (!/^owner-[\d-]+[0-9a-f]{16}\.json$/.test(name)) invalid();
    const owner = await inspect(path.join(lock, name));
    if (owner && !isPrivateFile(owner, 1_024)) invalid();
  }
}

async function readPrivateJson(file) {
  const info = await inspect(file);
  if (!info) return undefined;
  if (!isPrivateFile(info)) invalid();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value;
  try {
    const current = await handle.stat();
    if (!isPrivateFile(current) || current.ino !== info.ino || current.dev !== info.dev) invalid();
    const data = Buffer.alloc(MAX_STATE + 1);
    let read = 0;
    while (read < data.length) {
      const { bytesRead } = await handle.read(data, read, data.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read > MAX_STATE) invalid();
    try { value = JSON.parse(data.toString("utf8", 0, read)); }
    catch { invalid(); }
  } finally {
    await handle.close();
  }
  return value;
}

async function readState(file, provider, grant) {
  const value = await readPrivateJson(file);
  if (value === undefined) return null;
  if (!object(value) || value.version !== 1 || value.provider !== provider) invalid();
  if (value.grant !== grant) return null;
  if (typeof value.key !== "string" || !/^[0-9a-f]{64}$/.test(value.key) ||
    !epoch(value.attemptedAt) || !(value.status === "fresh" || FAILURES.has(value.status)) ||
    !Number.isInteger(value.failures) || value.failures < 0 || value.failures > 6 ||
    (value.status === "fresh") !== (value.failures === 0)) invalid();
  const reading = value.reading === null ? null : validReading(provider, value.reading);
  if (value.reading !== null && (!reading || reading.observedAt > value.attemptedAt + MAX_CLOCK_SKEW)) invalid();
  if (reading?.windows.some((w) => w.id === MONTHLY_WINDOW)) invalid();
  const monthly = value.reading?.monthlySpendLimit;
  if (provider === "claude" && reading?.windows.length === 1 &&
    reading.windows[0].id === "frontier_credit" && monthly?.id === MONTHLY_WINDOW) {
    const verified = validReading(provider, { ...reading, windows: [monthly] });
    if (verified) reading.windows.push(verified.windows[0]);
  }
  return { version: 1, provider, grant, key: value.key, attemptedAt: value.attemptedAt,
    status: value.status, failures: value.failures, reading };
}

function persistedReading(reading) {
  const monthlySpendLimit = reading?.windows.find((w) => w.id === MONTHLY_WINDOW);
  if (!monthlySpendLimit) return reading;
  // Older helpers accept the baseline array and ignore the optional side field.
  const windows = reading.windows.filter((w) => w.id !== MONTHLY_WINDOW);
  return windows.length ? { ...reading, windows, monthlySpendLimit } : null;
}

function retryTime(state, operation) {
  const gap = operation === "read" ? NORMAL : REFRESH;
  if (state.status === "missing-cli") return state.attemptedAt + MISSING;
  const backoff = state.failures > 0
    ? Math.min(BACKOFF, (state.status === "rate-limited" ? NORMAL : REFRESH) * 2 ** (state.failures - 1))
    : 0;
  return state.attemptedAt + Math.max(gap, backoff);
}

function accountKey(state, identity) {
  return identity ? createHmac("sha256", Buffer.from(state.key, "hex"))
    .update(JSON.stringify([state.provider, ...identity])).digest("hex") : null;
}

function report(provider, binding, status, { state, retryAt = null, reading = null } = {}) {
  return { version: WIRE_VERSION, provider, status, readAt: nowSec(), attemptedAt: state?.attemptedAt ?? null, retryAt, binding, reading };
}

const resetPassed = (reading, now) => reading.windows.every((w) =>
  w.resetsAt !== null && w.resetsAt <= now);

function evidence(reading, now, failure = false) {
  if (!reading || now < reading.observedAt || now - reading.observedAt >= HISTORY) return null;
  if (failure || now - reading.observedAt >= STALE || resetPassed(reading, now)) {
    return { ...reading, source: "history" };
  }
  return reading;
}

async function cliQuota({ file, provider, grant, operation, context, response }) {
  const state = await readState(file, provider, grant);
  const current = nowSec();
  if (state && (state.attemptedAt > current || state.reading?.observedAt > current)) {
    return response("unavailable");
  }
  if (state && current < retryTime(state, operation)) {
    const retryAt = retryTime(state, operation);
    const cached = evidence(state.reading, current, state.status !== "fresh");
    let status = state.status === "fresh" ? (operation === "refresh" ? "cooldown" : "cached") : state.status;
    if (!cached) return response(status === "cached" ? "cooldown" : status, { state, retryAt });
    const verified = await probe(provider, context, { identityOnly: true });
    const account = accountKey(state, verified.identity);
    if (account !== cached.account) {
      await atomicWriteJson(file, { ...state, reading: null });
      return response(verified.status ?? (account ? "identity-changed" : "unavailable"), { state, retryAt });
    }
    const checkedAt = nowSec();
    const reading = evidence(cached, checkedAt, state.status !== "fresh");
    if (status === "cached" && !reading) status = "unavailable";
    if (status === "cached" && reading?.source === "history") {
      status = resetPassed(reading, checkedAt) ? "waiting-reset" : "stale";
    }
    return response(status, { state, retryAt, reading });
  }
  const next = {
    version: 1, provider, grant, key: state?.key ?? randomBytes(32).toString("hex"),
    attemptedAt: current, status: "unavailable",
    failures: Math.min(6, (state?.failures ?? 0) + 1), reading: state?.reading ?? null,
  };
  await atomicWriteJson(file, { ...next, reading: null });
  const result = await probe(provider, context);
  const completed = nowSec();
  if (completed < current || completed - current > MAX_CLOCK_SKEW) return response("unavailable");
  const account = accountKey(next, result.identity);
  next.status = result.status ?? "fresh";
  if (next.status === "fresh") {
    next.failures = 0;
    if (!epoch(result.observedAt) || result.observedAt < current || result.observedAt > completed) {
      return response("unavailable");
    }
    const reading = { observedAt: result.observedAt, source: "cli", account, ...result.usage };
    const expired = resetPassed(reading, completed);
    // Host-scoped readings without an identity are returned once, never persisted.
    next.reading = account ? persistedReading(reading) : null;
    await atomicWriteJson(file, next);
    return response(expired ? "waiting-reset" : "fresh", {
      state: next, retryAt: retryTime(next, operation),
      reading: expired && !account ? null : evidence(reading, completed),
    });
  }
  const sameAccount = account && account === state?.reading?.account;
  const history = sameAccount ? evidence(next.reading, completed, true) : null;
  next.reading = history ? persistedReading(state.reading) : null;
  await atomicWriteJson(file, next);
  return response(next.status, { state: next, retryAt: retryTime(next, operation), reading: history });
}

// The host's own refresh cooldown lives beside the provider state and shares its lock.
async function readHostState(file, provider, grant) {
  const value = await readPrivateJson(file);
  if (value === undefined) return null;
  if (!object(value) || value.version !== 1 || value.provider !== provider || !epoch(value.attemptedAt) ||
    !Number.isInteger(value.failures) || value.failures < 0 || value.failures > 6) invalid();
  return value.grant === grant ? value : null;
}

const hostRetryTime = (state) => state.attemptedAt + Math.max(REFRESH, state.failures > 0
  ? Math.min(BACKOFF, REFRESH * 2 ** (state.failures - 1)) : 0);

async function hostQuota({ file, provider, grant, operation, context, response }) {
  const stateFile = file.replace(/\.json$/, ".host.json");
  let record = await readHostRecord(provider, nowSec());
  if (record.status !== "ok") return response(record.status);
  let attemptedAt = nowSec();
  let retryAt = attemptedAt + HOST_READ_GAP;
  let fresh = record.current && attemptedAt - record.reading.observedAt < HOST_FRESH;
  if (operation === "refresh" && !fresh) {
    const state = await readHostState(stateFile, provider, grant);
    const executable = await refreshExecutable();
    if (state && attemptedAt < hostRetryTime(state)) {
      attemptedAt = state.attemptedAt;
      retryAt = hostRetryTime(state);
    } else if (executable) {
      const next = { version: 1, provider, grant, attemptedAt, failures: Math.min(6, (state?.failures ?? 0) + 1) };
      // Record the attempt first so a killed helper still counts toward the cooldown.
      await atomicWriteJson(stateFile, next);
      await runRefresh(executable, provider, context, HOST_REFRESH_MS);
      const again = await readHostRecord(provider, nowSec());
      if (again.status === "ok" && again.reading.observedAt > record.reading.observedAt) {
        record = again;
        fresh = record.current;
        next.failures = 0;
      }
      await atomicWriteJson(stateFile, next);
      retryAt = hostRetryTime(next);
    } else {
      retryAt = attemptedAt + REFRESH;
    }
  }
  const status = fresh || (operation === "read" && record.current) ? "fresh" : record.current ? "cached" : "stale";
  return response(status, { state: { attemptedAt }, retryAt, reading: record.reading });
}

const currentReading = (r) => r?.reading && ["fresh", "cached", "cooldown"].includes(r.status) &&
  ["cli", "host"].includes(r.reading.source);

export async function runQuota(operation, provider, binding, { signal } = {}) {
  if (!["read", "refresh"].includes(operation) || !PROVIDERS.includes(provider)) {
    throw new TypeError("invalid arguments");
  }
  const response = (status, options) => report(provider, binding, status, options);
  if (process.platform !== "linux") return response("unsupported");
  // Do not strip an alternate auth selector and silently fall back to a different login.
  const cliAllowed = EXTERNAL_AUTH[provider]?.every((key) => !Object.hasOwn(process.env, key)) ?? false;
  // A blocked CLI with no host record has nothing to serve and creates no state.
  if (EXTERNAL_AUTH[provider] && !cliAllowed && (await readHostRecord(provider, nowSec())).status !== "ok") {
    return response("unsupported");
  }
  const grant = createHash("sha256").update("quota:provider-state:v1\0").update(binding, "hex").digest("hex");
  try {
    const file = await stateFile(provider);
    await validateLock(file);
    return await withStoreLock(file, async () => {
      const options = { file, provider, grant, operation, response,
        context: cliContext(path.dirname(file), signal) };
      // Codex asks its CLI first, Claude its host record; host-only providers have no CLI.
      const order = provider === "codex" ? ["cli", "host"] : provider === "claude" ? ["host", "cli"] : ["host"];
      const reports = {};
      for (const source of order) {
        reports[source] = source === "host" ? await hostQuota(options) :
          cliAllowed ? await cliQuota(options) : null;
        // One source per reading: the first current one wins and windows are never merged.
        if (currentReading(reports[source])) return reports[source];
      }
      const dated = [reports.host, reports.cli].filter((r) => r?.reading);
      if (dated.length) return dated.reduce((a, b) => b.reading.observedAt > a.reading.observedAt ? b : a);
      if (reports.host?.status === "unsupported-source") return reports.host;
      return reports.cli ?? reports.host;
    }, { timeoutMs: 180 });
  } catch (error) {
    if (isLockBusyError(error)) return response("in-flight");
    return response(error instanceof ProbeError ? error.status : "unavailable");
  }
}
