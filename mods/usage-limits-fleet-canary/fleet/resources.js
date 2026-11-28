import { level } from "../lib/format.js";
import { NO_READING } from "../lib/view.js";

// Published by another mod, which may be absent: anything unexpected draws nothing.
export const RESOURCES_KEY = "fleet-resources.readings";
const METRICS = [["cpuPct", "CPU"], ["memPct", "RAM"], ["diskPct", "Disk"]];
const isPercent = (value) => Number.isInteger(value) && value >= 0 && value <= 100;
// A null route is this computer.
const isRoute = (route) => route === null || (typeof route === "string" && route !== "");

// An unknown metric keeps its slot, so the others stay identifiable without labels.
function pillSegments(entry) {
  if (!METRICS.some(([key]) => isPercent(entry[key]))) return [];
  return METRICS.map(([key, short]) => {
    const known = isPercent(entry[key]);
    const percent = known ? entry[key] : 0;
    const text = known ? `${percent}%` : NO_READING;
    return { id: key, short, text, brief: text, level: level(percent), fill: percent / 100, tick: null };
  });
}

// The bar segments of each machine that has a current reading, by route.
export function resourcePills(record, now) {
  const pills = new Map();
  const { version, staleAfterSec, machines } = record ?? {};
  if (version !== 1 || !Number.isInteger(staleAfterSec) || !Array.isArray(machines)) return pills;
  for (const entry of machines) {
    if (!isRoute(entry?.route) || !Number.isFinite(entry.observedAt) || now - entry.observedAt > staleAfterSec) continue;
    const segments = pillSegments(entry);
    if (segments.length) pills.set(entry.route, segments);
  }
  return pills;
}
