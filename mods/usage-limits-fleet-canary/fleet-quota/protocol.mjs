import { createHash } from "crypto";

export const VERSION = 1;
export const PROVIDERS = Object.freeze(["codex", "claude"]);
export const STALE_SECONDS = 900;
export const HISTORY_SECONDS = 14 * 86_400;
const SKEW = 60;
const WEEK = 604_800;
const FRONTIER_MAX_RESET = 62 * 86_400;
const STATUS = new Set(["fresh", "cached", "cooldown", "in-flight", "waiting-reset",
  "stale", "paused", "estimated", "missing-cli", "auth-expired", "unsupported", "malformed",
  "rate-limited", "timeout", "unavailable", "identity-changed"]);
const PLANS = {
  codex: new Set(["free", "go", "plus", "pro", "prolite", "team", "business", "enterprise", "edu"]),
  claude: new Set(["free", "pro", "max", "team", "enterprise"]),
};
const SCOPES = new Set(["Opus", "Sonnet", "Haiku", "Fable", "Cowork"]);
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const RESET_LABEL = new RegExp(`^(${MONTHS.join("|")}) ([1-9]|[12]\\d|3[01])(?:, (\\d{4}))?$`);
const DISPLAY = /^[A-Za-z0-9][A-Za-z0-9 ._·()-]{0,63}$/u;
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9 _.:()-]{0,63}$/;
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CORE_ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const matches = (pattern, value) => typeof value === "string" && !/[\r\n\u2028\u2029]/u.test(value) && pattern.test(value);
const epoch = (v) => Number.isSafeInteger(v) && v > 0 && v <= 253_402_300_799;
const optional = (v, check) => v === null || check(v);
export const safeRoute = (route) => matches(ROUTE, route);

function parseJson(text, max) {
  if (typeof text !== "string" || text.length === 0 || text.length > max) return null;
  // Bound UTF-8 bytes before parsing, not just UTF-16 code units.
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0);
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65_536 ? 3 : 4;
    if (bytes > max) return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

function hash(domain, left, right) {
  const bytes = Uint8Array.from([...domain].map((char) => char.charCodeAt(0))
    .concat((left + right).match(/../g).map((part) => Number.parseInt(part, 16))));
  return createHash("sha256").update(bytes).digest("hex");
}

export function fingerprintCore(id, generation) {
  return matches(CORE_ID, id) && matches(CORE_ID, generation) ?
    hash("quota:core-binding:v1\0", generation, id) : null;
}

export function readGrants(value) {
  if (!Array.isArray(value) || value.length > 128) return null;
  const grants = new Map();
  for (const row of value) {
    if (!object(row) || row.version !== VERSION || !safeRoute(row.route) || grants.has(row.route) ||
      !matches(CORE_ID, row.generation) || !matches(DIGEST, row.coreDigest) ||
      !matches(DIGEST, row.binding) || !Array.isArray(row.providers) || row.providers.length > 2 ||
      new Set(row.providers).size !== row.providers.length || row.providers.some((p) => !PROVIDERS.includes(p))) return null;
    if (row.enabled !== true && row.enabled !== false) return null;
    const invalidated = row.invalidated ?? null;
    if (invalidated !== null && (row.enabled || !["route-removed", "core-replaced",
      "receiver-binding-mismatch"].includes(invalidated))) return null;
    const { route, generation, coreDigest, binding, enabled } = row;
    grants.set(route, { route, generation, coreDigest, binding, enabled, invalidated, providers: [...row.providers].sort() });
  }
  return grants;
}

export function parseMachineRegistry(result) {
  if (result?.code !== 0) return null;
  const data = parseJson(result.stdout, 128 * 1024);
  if (!object(data) || !Array.isArray(data.machines) || data.machines.length > 128) return null;
  const entries = new Map();
  for (const row of data.machines) {
    if (!object(row) || !safeRoute(row.name) || entries.has(row.name) ||
      !optional(row.id ?? null, (id) => matches(CORE_ID, id)) ||
      (row.state === "connected" && !matches(CORE_ID, row.id))) return null;
    const state = ["connected", "unreachable", "needs_login", "needs_update", "connecting"].includes(row.state)
      ? row.state : "unknown";
    entries.set(row.name, { route: row.name, id: row.id ?? null, state,
      label: matches(DISPLAY, row.host) ? row.host : row.name, temporary: row.temporary === true });
  }
  return entries;
}

function windowLabels(provider, id, duration) {
  if (typeof id !== "string" || id.length > 32 || /[\r\n\u2028\u2029]/u.test(id)) return null;
  if (provider === "codex") {
    const parts = /^(codex|spark|bucket-([1-9]\d?)):(primary|secondary)$/.exec(id);
    if (!parts || Number(parts[2]) > 32) return null;
    const [, bucket, n, slot] = parts;
    const hours = duration / 3_600;
    const [short, long] = duration === WEEK ? ["wk", "Weekly"] :
      duration === 18_000 ? ["5h", "5-hour"] :
      duration === null ? (slot === "primary" ? ["1st", "Primary"] : ["2nd", "Secondary"]) :
      Number.isInteger(hours) ? [`${hours}h`, `${hours}-hour`] :
        [`${duration / 60}m`, `${duration / 60}-minute`];
    if (bucket === "codex") return [short, long];
    const prefix = bucket === "spark" ? "Spark" : `Bucket ${n}`;
    return [`${prefix} ${short}`, `${prefix} · ${long}`];
  }
  if (id === "session" && duration === 18_000) return ["5h", "5-hour"];
  if (id === "weekly_all" && duration === WEEK) return ["wk", "Weekly"];
  if (id === "frontier_credit" && duration === null) return ["Frontier credit", "Frontier credit"];
  if (id === "monthly_spend_limit" && duration === null) return ["Monthly usage credits", "Monthly usage credits"];
  const scope = id.startsWith("weekly_scoped:") ? id.slice(14) : null;
  if (duration === WEEK && SCOPES.has(scope)) return [scope, `Weekly · ${scope}`];
  const limit = /^limit-([1-9]\d?)$/.exec(id);
  return limit && Number(limit[1]) <= 32 && (duration === null || duration === WEEK) ?
    [`Limit ${limit[1]}`, `${duration === WEEK ? "Weekly · " : ""}Limit ${limit[1]}`] : null;
}

function parseMoney(value) {
  if (!object(value) || !["$", "USD"].includes(value.currency) ||
    !Number.isSafeInteger(value.usedMinor) || value.usedMinor < 0 || Object.is(value.usedMinor, -0) ||
    !Number.isSafeInteger(value.limitMinor) || value.limitMinor <= 0 ||
    Object.keys(value).some((k) => !["currency", "usedMinor", "limitMinor", "resetLabel"].includes(k))) return null;
  const { currency, usedMinor, limitMinor, resetLabel } = value;
  if (Object.hasOwn(value, "resetLabel")) {
    const match = typeof resetLabel === "string" && RESET_LABEL.exec(resetLabel);
    if (!match || match[0] !== resetLabel) return null;
    const [, month, day, year] = match;
    const leap = year === undefined || (+year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0));
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year === "0000" || +day > days[MONTHS.indexOf(month)]) return null;
  }
  return { currency, usedMinor, limitMinor, ...(resetLabel === undefined ? {} : { resetLabel }) };
}

function parseWindows(provider, value, local) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  const seen = new Set();
  const windows = [];
  for (const w of value) {
    if (!object(w) || seen.has(w.id) || !Number.isInteger(w.percent) || w.percent < 0 || w.percent > 100 ||
      !optional(w.resetsAt, epoch) ||
      !optional(w.durationSec, (n) => Number.isSafeInteger(n) && n > 0 && n <= 31 * 86_400 && n % 60 === 0)) return null;
    if (w.id === "monthly_spend_limit" && (local || w.resetsAt !== null)) return null;
    const labels = local ?
      matches(NATIVE_ID, w.id) && matches(DISPLAY, w.short) && matches(DISPLAY, w.long) && [w.short, w.long] :
      windowLabels(provider, w.id, w.durationSec);
    if (!labels) return null;
    const [short, long] = labels;
    const window = { id: w.id, short, long, percent: w.percent, resetsAt: w.resetsAt, durationSec: w.durationSec };
    if (!local) {
      window.kind = w.id === "frontier_credit" ? "credit" : w.id === "monthly_spend_limit" ? "spend" : "plan";
      if (Object.hasOwn(w, "money")) {
        if (window.kind === "plan") return null;
        window.money = parseMoney(w.money);
        if (!window.money) return null;
      }
    }
    seen.add(w.id);
    windows.push(window);
  }
  return windows;
}

// The only returned diagnostic values are fixed codes, never stderr or rejection text.
export function parseQuotaReply(result, { provider, binding, now, sentAt }) {
  if (!PROVIDERS.includes(provider) || !matches(DIGEST, binding) || !epoch(now) || !epoch(sentAt)) {
    return { reason: "malformed" };
  }
  if ((result?.stdout === "" || result?.stdout == null) && result?.code === 64) return { reason: "malformed" };
  if ((result?.stdout === "" || result?.stdout == null) && result?.code === 73) return { reason: "helper-missing" };
  if ((result?.stdout === "" || result?.stdout == null) && result?.code === 74) return { reason: "helper-unsafe" };
  if (result?.code !== 0) return { reason: "transport-unknown" };
  const data = parseJson(result.stdout, 32 * 1024);
  if (!object(data) || data.version !== VERSION || data.provider !== provider) return { reason: "malformed" };
  const { status, readAt, attemptedAt, retryAt } = data;
  if (data.binding === null && (status === "not-enrolled" || status === "unavailable") &&
    attemptedAt === null && retryAt === null && data.reading === null &&
    epoch(readAt) && readAt >= sentAt - SKEW && readAt <= now + SKEW) {
    return { reason: status === "not-enrolled" ? "receiver-not-enrolled" : "receiver-unavailable" };
  }
  if (data.binding !== binding) return { reason: "binding-mismatch" };
  if (!STATUS.has(status) || !epoch(readAt) || readAt < sentAt - SKEW || readAt > now + SKEW ||
    !optional(attemptedAt, (t) => epoch(t) && t <= readAt) ||
    !optional(retryAt, (t) => epoch(t) && attemptedAt !== null && t > attemptedAt && t <= readAt + 3_600)) {
    return { reason: "malformed" };
  }
  if (data.reading === null) {
    return status === "fresh" || status === "cached" ? { reason: "malformed" } :
      { data: { status, readAt, attemptedAt, retryAt, reading: null } };
  }
  const r = data.reading;
  if (!object(r) || !epoch(r.observedAt) || attemptedAt === null || r.observedAt > readAt ||
    !["cli", "history"].includes(r.source) ||
    !optional(r.account, (v) => matches(DIGEST, v)) ||
    (r.account === null && (status !== "fresh" || r.source !== "cli")) ||
    (status === "fresh" && (r.source !== "cli" || r.observedAt < attemptedAt ||
      attemptedAt < sentAt - SKEW || readAt - attemptedAt > SKEW)) ||
    (r.source === "cli" && !["fresh", "cached", "cooldown"].includes(status)) ||
    ["identity-changed", "in-flight", "paused", "estimated"].includes(status) ||
    !optional(r.plan, (p) => PLANS[provider].has(p))) return { reason: "malformed" };
  const windows = parseWindows(provider, r.windows, false);
  if (!windows || windows.some((w) =>
    (w.id === "monthly_spend_limit" && r.account === null) ||
    (w.id === "frontier_credit" && (r.account === null || !epoch(w.resetsAt) ||
      w.resetsAt <= r.observedAt || w.resetsAt - r.observedAt > FRONTIER_MAX_RESET)))) return { reason: "malformed" };
  return { data: { status, readAt, attemptedAt, retryAt,
    reading: { observedAt: r.observedAt, source: r.source, historyEligible: r.account !== null, plan: r.plan, windows } } };
}

export function projectReading(reading, now, current) {
  const age = reading && now - reading.observedAt;
  if (!reading || age < 0 || age >= HISTORY_SECONDS) return { current: null, history: null };
  const view = (windows) => ({ observedAt: reading.observedAt, source: reading.source,
    plan: reading.plan, windows: windows.map((w) => ({ ...w, ...(w.money ? { money: { ...w.money } } : {}) })) });
  const inline = current && reading.source === "cli" && age < STALE_SECONDS ?
    reading.windows.filter((w) => w.resetsAt === null || w.resetsAt > now) : [];
  const past = reading.historyEligible ? reading.windows.filter((w) => !inline.includes(w)) : [];
  return { current: inline.length ? view(inline) : null,
    history: past.length ? { ...view(past), source: "history" } : null };
}

export function projectLocal(state, now) {
  return PROVIDERS.map((provider) => {
    const local = state?.[provider];
    const native = local?.report?.status === "ok" ? local.report : local?.lastGood;
    const source = provider === "codex" ? "codex app-server" : "claude CLI";
    const windows = parseWindows(provider, native?.windows, true);
    const reading = native?.status === "ok" && epoch(native.observedAt) && windows &&
      (native.source === source || (provider === "codex" && native.source === "Codex session log")) ?
      { source: native.source === source ? "cli" : "history", observedAt: native.observedAt,
        plan: PLANS[provider].has(native.plan) ? native.plan : null, historyEligible: true, windows } : null;
    const evidence = projectReading(reading, now, local?.installed !== false && local?.report === native);
    return { provider, status: evidence.current ? "ready" : evidence.history ? "stale" : "unavailable",
      reason: local?.installed === false ? "missing-cli" : null, ...evidence };
  });
}
