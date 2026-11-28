import { makeWindow, okReport, errorReport, unavailableReport, jsonLines } from "../lib/report.js";

const SOURCE = "OpenCode server";
const HOUR = 3600;
const DAY = 24 * HOUR;
const UNAVAILABLE = {
  "server-stopped": "OpenCode server isn't running",
  "limits-unavailable": "OpenCode couldn't read the usage limits",
};
// The reply carries no window lengths. The ids match claude.js and are stored in prefs.
// A month has no fixed length, so it gets no pace tick.
const METERS = {
  rolling: { id: "session", short: "5h", long: "5-hour", durationSec: 5 * HOUR },
  weekly: { id: "weekly_all", short: "wk", long: "Weekly", durationSec: 7 * DAY },
  monthly: { id: "monthly", short: "mo", long: "Monthly", durationSec: null },
};

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function windowFrom(meter, shape) {
  const { percent, resetsAt } = meter ?? {};
  if (!isNum(percent) || percent < 0 || percent > 100 || !isNum(resetsAt) || resetsAt <= 0) return null;
  return makeWindow({ ...shape, percent, resetsAt: resetsAt / 1000 });
}

export function parse(text, now) {
  const reply = jsonLines(text).find((m) => Object.hasOwn(UNAVAILABLE, m.herdr) || "data" in m);
  if (Object.hasOwn(UNAVAILABLE, reply?.herdr)) return unavailableReport(SOURCE, UNAVAILABLE[reply.herdr], now);
  const data = reply?.data;
  if (data === null) return unavailableReport(SOURCE, "Not signed in to OpenCode Console", now);
  if (!isObj(data)) return errorReport(SOURCE, "No reply from OpenCode", now);
  if (data.go == null) return unavailableReport(SOURCE, "No OpenCode Go usage for this workspace", now);
  const windows = Object.entries(METERS).map(([key, shape]) => windowFrom(data.go[key], shape));
  if (windows.includes(null)) return errorReport(SOURCE, "Unknown usage reply from OpenCode", now);
  return okReport(SOURCE, now, windows);
}

export default {
  id: "opencode-go",
  name: "OpenCode Go",
  icon: "icons/opencode.svg",
  oneColorGlyph: true,
  helper: "helpers/opencode-go-limits.sh",
  parse,
};
