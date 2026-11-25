import { ProbeError } from "./runtime.mjs";

export const MAX_WINDOWS = 32;
export const FRONTIER_MAX_RESET = 62 * 86_400;
export class ClaudeWindowsMissing extends ProbeError {}
const HOUR = 3_600;
const WEEK = 7 * 24 * HOUR;
const MAX_EPOCH = 253_402_300_799;
const PLANS = {
  codex: new Set(["free", "go", "plus", "pro", "prolite", "team", "business", "enterprise", "edu"]),
  claude: new Set(["free", "pro", "max", "team", "enterprise"]),
};
const SCOPES = ["Opus", "Sonnet", "Haiku", "Fable", "Cowork"];
export const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const RESET_LABEL = new RegExp(`^(${MONTHS.join("|")}) ([1-9]|[12]\\d|3[01])(?:, (\\d{4}))?$`);

export const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const epoch = (v) => Number.isSafeInteger(v) && v > 0 && v <= MAX_EPOCH;
export const usagePlan = (provider, value) => PLANS[provider].has(value) ? value : null;
const integerIn = (v, max) => Number.isSafeInteger(v) && v > 0 && v <= max;
const invalid = () => { throw new ProbeError("malformed"); };

export function validResetLabel(value) {
  const match = typeof value === "string" && RESET_LABEL.exec(value);
  if (!match || match[0] !== value) return false;
  const [, month, day, year] = match;
  const leap = year === undefined || (+year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0));
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year !== "0000" && +day <= days[MONTHS.indexOf(month)];
}

function validMoney(value) {
  if (!object(value) || !["$", "USD"].includes(value.currency) ||
    !Number.isSafeInteger(value.usedMinor) || value.usedMinor < 0 || Object.is(value.usedMinor, -0) ||
    !Number.isSafeInteger(value.limitMinor) || value.limitMinor <= 0 ||
    Object.keys(value).some((k) => !["currency", "usedMinor", "limitMinor", "resetLabel"].includes(k)) ||
    (Object.hasOwn(value, "resetLabel") && !validResetLabel(value.resetLabel))) return null;
  const { currency, usedMinor, limitMinor, resetLabel } = value;
  return { currency, usedMinor, limitMinor, ...(resetLabel === undefined ? {} : { resetLabel }) };
}

function resetTime(value) {
  if (value == null) return null;
  const time = typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? Math.floor(Date.parse(value) / 1000) : value;
  return epoch(time) ? time : invalid();
}

function labels(provider, id, durationSec) {
  if (provider === "codex") {
    const parts = /^(codex|spark|bucket-([1-9]\d?)):(primary|secondary)$/.exec(id);
    if (!parts || Number(parts[2]) > MAX_WINDOWS) return null;
    const [, bucket, n, slot] = parts;
    const hours = durationSec / HOUR;
    const [short, long] = durationSec === WEEK ? ["wk", "Weekly"] :
      durationSec === 5 * HOUR ? ["5h", "5-hour"] :
      durationSec === null ? (slot === "primary" ? ["1st", "Primary"] : ["2nd", "Secondary"]) :
      Number.isInteger(hours) ? [`${hours}h`, `${hours}-hour`] :
        [`${durationSec / 60}m`, `${durationSec / 60}-minute`];
    if (bucket === "codex") return [short, long];
    const prefix = bucket === "spark" ? "Spark" : `Bucket ${n}`;
    return [`${prefix} ${short}`, `${prefix} · ${long}`];
  }
  if (id === "session" && durationSec === 5 * HOUR) return ["5h", "5-hour"];
  if (id === "weekly_all" && durationSec === WEEK) return ["wk", "Weekly"];
  if (id === "frontier_credit" && durationSec === null) return ["Frontier credit", "Frontier credit"];
  if (id === "monthly_spend_limit" && durationSec === null) return ["Monthly usage credits", "Monthly usage credits"];
  if (id.startsWith("weekly_scoped:") && durationSec === WEEK) {
    const scope = id.slice("weekly_scoped:".length);
    if (SCOPES.includes(scope)) return [scope, `Weekly · ${scope}`];
  }
  const unknown = /^limit-([1-9]\d?)$/.exec(id);
  if (unknown && Number(unknown[1]) <= MAX_WINDOWS &&
    (durationSec === null || durationSec === WEEK)) {
    return [`Limit ${unknown[1]}`, `${durationSec === WEEK ? "Weekly · " : ""}Limit ${unknown[1]}`];
  }
  return null;
}

function window(provider, id, percent, resetsAt, durationSec) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) invalid();
  const display = labels(provider, id, durationSec);
  if (!display) invalid();
  return { id, short: display[0], long: display[1], percent: Math.round(percent),
    resetsAt: resetTime(resetsAt), durationSec };
}

export function validReading(provider, value) {
  if (!object(value) || value.source !== "cli" || !epoch(value.observedAt) ||
    typeof value.account !== "string" || !/^[0-9a-f]{64}$/.test(value.account) ||
    (value.plan !== null && usagePlan(provider, value.plan) === null) ||
    !Array.isArray(value.windows) || value.windows.length === 0 || value.windows.length > MAX_WINDOWS) {
    return null;
  }
  try {
    const windows = value.windows.map((w) => {
      if (!object(w) || typeof w.id !== "string" || !Number.isInteger(w.percent) ||
        (w.resetsAt !== null && !epoch(w.resetsAt)) ||
        (w.durationSec !== null && (!integerIn(w.durationSec, 31 * 86400) || w.durationSec % 60 !== 0))) {
        invalid();
      }
      if (w.id === "frontier_credit" && (!epoch(w.resetsAt) || w.resetsAt <= value.observedAt ||
        w.resetsAt - value.observedAt > FRONTIER_MAX_RESET)) invalid();
      if (w.id === "monthly_spend_limit" && w.resetsAt !== null) invalid();
      const normalized = window(provider, w.id, w.percent, w.resetsAt, w.durationSec);
      if (Object.hasOwn(w, "money")) {
        if (provider !== "claude" || !["frontier_credit", "monthly_spend_limit"].includes(w.id)) invalid();
        normalized.money = validMoney(w.money);
        if (!normalized.money) invalid();
      }
      return normalized;
    });
    if (new Set(windows.map((w) => w.id)).size !== windows.length) return null;
    return { observedAt: value.observedAt, source: "cli", account: value.account, plan: value.plan, windows };
  } catch {
    return null;
  }
}

export function codexUsage(result) {
  if (!object(result)) invalid();
  const { rateLimits, rateLimitsByLimitId: multi } = result;
  if ((rateLimits != null && !object(rateLimits)) || (multi != null && !object(multi))) invalid();
  if (rateLimits == null && multi == null) invalid();
  const entries = Object.entries(multi ?? {});
  if (!entries.length && rateLimits != null) entries.push([rateLimits.limitId ?? "codex", rateLimits]);
  if (entries.length > MAX_WINDOWS) invalid();
  entries.sort(([a], [b]) => {
    const rank = (key) => key === "codex" ? 0 : key === "spark" ? 1 : 2;
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  let unknown = 0;
  const windows = [];
  for (const [id, bucket] of entries) {
    if (!object(bucket) || (bucket.limitId != null && bucket.limitId !== id)) invalid();
    const key = id === "codex" || id === "spark" ? id : `bucket-${++unknown}`;
    for (const slot of ["primary", "secondary"]) {
      const w = bucket[slot];
      if (w == null) continue;
      if (!object(w)) invalid();
      const mins = w.windowDurationMins;
      if (mins != null && !integerIn(mins, 31 * 24 * 60)) invalid();
      windows.push(window("codex", `${key}:${slot}`, w.usedPercent, w.resetsAt, mins == null ? null : mins * 60));
    }
  }
  if (windows.length > MAX_WINDOWS) invalid();
  const plan = usagePlan("codex", rateLimits?.planType ?? entries[0]?.[1]?.planType);
  return windows.length ? { plan, windows } : null;
}

export function claudeUsage(body) {
  if (!object(body)) invalid();
  const rl = body.rate_limits;
  if (rl == null && body.rate_limits_available === true) throw new ClaudeWindowsMissing("unavailable");
  if (rl == null && body.rate_limits_available === false) return null;
  if (!object(rl)) invalid();
  const windows = [];
  if (rl.limits != null) {
    if (!Array.isArray(rl.limits) || rl.limits.length > MAX_WINDOWS) invalid();
    let unknown = 0;
    for (const limit of rl.limits) {
      if (!object(limit) || typeof limit.kind !== "string") invalid();
      if (limit.percent == null) continue;
      const name = limit.scope?.model?.display_name ?? limit.scope?.surface;
      const kind = limit.kind;
      let id;
      let durationSec = null;
      if (kind === "session") [id, durationSec] = ["session", 5 * HOUR];
      else if (kind === "weekly_all") [id, durationSec] = ["weekly_all", WEEK];
      else if (kind === "weekly_scoped") {
        const allowed = SCOPES.includes(name) && (name !== "Fable" || limit.scope?.model?.display_name === name);
        id = allowed ? `weekly_scoped:${name}` : `limit-${++unknown}`;
        durationSec = WEEK;
      } else continue;
      windows.push(window("claude", id, limit.percent, limit.resets_at, durationSec));
    }
  } else {
    for (const [key, id, durationSec] of [
      ["five_hour", "session", 5 * HOUR], ["seven_day", "weekly_all", WEEK],
      ...["Opus", "Sonnet", "Cowork"].map((scope) => [
        `seven_day_${scope.toLowerCase()}`, `weekly_scoped:${scope}`, WEEK,
      ]),
    ]) {
      const limit = rl[key];
      if (limit == null) continue;
      if (!object(limit)) invalid();
      if (limit.utilization == null) continue;
      windows.push(window("claude", id, limit.utilization, limit.resets_at, durationSec));
    }
  }
  if (new Set(windows.map((w) => w.id)).size !== windows.length) invalid();
  const hasShape = rl.limits != null || ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet",
    "seven_day_cowork"].some((name) => Object.hasOwn(rl, name));
  if (!hasShape && body.rate_limits_available !== false) invalid();
  if (windows.length === 0 && (body.rate_limits_available === true ||
    (hasShape && body.rate_limits_available === undefined))) {
    throw new ClaudeWindowsMissing(body.rate_limits_available ? "unavailable" : "unsupported");
  }
  return windows.length ? { plan: usagePlan("claude", body.subscription_type), windows } : null;
}
