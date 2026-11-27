import { makeWindow, okReport, errorReport } from "../lib/report.js";

// Reads the same record as the remote path's parser (scripts/quota/host.mjs) and must agree with it.
// The mod is installed on its own, so it cannot import that one.
const SOURCE = "Omarchy collector";
const STALE_AFTER_S = 15 * 60;
const HISTORY_S = 14 * 86_400;
const SESSION = { id: "session", short: "5h", long: "5-hour", durationSec: 5 * 3600 };
const WEEKLY = { id: "weekly_all", short: "wk", long: "Weekly", durationSec: 7 * 86_400 };
const KINDS = new Map([["Session", SESSION], ["Session (5-hour)", SESSION], ["Weekly", WEEKLY], ["Weekly (7-day)", WEEKLY]]);
const PLANS = new Set(["free", "pro", "ultra"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A 0-1 fraction becomes an integer percent that never reads 100 while capacity is left.
function percentOf(value) {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) return null;
  return value >= 1 ? 100 : Math.min(99, Math.floor(value * 100 + 1e-9));
}

// Null means no reset time; undefined means an unreadable one.
function resetOf(value) {
  if (value === "") return null;
  const seconds = typeof value === "string" && ISO_TIME.test(value) ? Math.floor(Date.parse(value) / 1000) : NaN;
  return seconds > 0 ? seconds : undefined;
}

function windowsOf(limits) {
  if (!Array.isArray(limits) || !limits.every(isObject)) return null;
  const windows = [];
  for (const entry of limits) {
    const kind = KINDS.get(entry.label) ?? KINDS.get(entry.title);
    if (!kind) continue;
    const percent = percentOf(entry.percent);
    const resetsAt = resetOf(entry.resetsAt);
    if (percent === null || resetsAt === undefined) return null;
    windows.push(makeWindow({ ...kind, percent, resetsAt }));
  }
  return new Set(windows.map((w) => w.id)).size === windows.length ? windows : null;
}

function planOf(label) {
  if (typeof label !== "string") return null;
  const tier = label.trim().toLowerCase().replace(/\s+\d+x?$/, "");
  return PLANS.has(tier) ? tier : null;
}

function recordOf(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parse(text, now) {
  const failed = (message) => errorReport(SOURCE, message, now);
  const unreadable = () => failed("Couldn't read the Antigravity record");
  const record = recordOf(text);
  if (record?.schemaVersion !== 1 || record.id !== "agy" || typeof record.ready !== "boolean"
    || typeof record.limitsStale !== "boolean") return unreadable();
  const { accounts = [], limitsFetchedAt } = record;
  const windows = windowsOf(record.limits);
  if (!Array.isArray(accounts) || accounts.length || !windows) return unreadable();
  const observedAt = typeof limitsFetchedAt === "number" ? Math.floor(limitsFetchedAt / 1000) : 0;
  if (!windows.length || observedAt <= 0 || observedAt > now || now - observedAt >= HISTORY_S) {
    return failed("No recent Antigravity reading");
  }
  const reading = okReport(SOURCE, now, windows, planOf(record.tierLabel), observedAt);
  const current = record.ready && !record.limitsStale && now - observedAt < STALE_AFTER_S
    && windows.some((w) => w.resetsAt === null || w.resetsAt > now);
  return current ? reading : { ...failed("Antigravity reading is out of date"), fallback: reading };
}

export default {
  id: "agy",
  name: "Antigravity",
  icon: "icons/antigravity.svg",
  optional: true,
  helper: "helpers/agy-record.sh",
  parse,
};
