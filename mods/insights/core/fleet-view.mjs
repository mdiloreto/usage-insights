// The fleet view: the same aggregation the local dashboard gets, applied to
// every machine's rows.
//
// It runs in the Node helper, never in a render frame: the UI fetches the
// remote caches, Node computes, the UI renders the compact result. A machine
// that could not be read keeps its own reason and never becomes a machine that
// used nothing.
import {
  clampRefreshSeconds,
  filterRowsForPeriod,
  periodRange,
  sumTokens,
} from "../analytics.js";

const TOTAL_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total", "messages"];

function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, messages: 0 };
}

/**
 * The fleet for one period and one set of facets.
 *
 * `payload` is `{ machines: [{ label, ok, rows, savedAt, refreshSeconds, reason }], includeCache }`
 * and `options` carries the dashboard's own selections, so the fleet numbers
 * obey the same filters as this computer's.
 */
export function fleetView(payload, options = {}) {
  const range = periodRange(options.period ?? "all", {
    today: options.today,
    weekStartsOn: payload?.weekStartsOn,
    year: options.year,
  });
  const includeCache = payload?.includeCache !== false;
  const machines = [];
  const skipped = [];

  for (const entry of payload?.machines ?? []) {
    const label = String(entry?.label ?? "unknown");
    if (!entry?.ok) {
      skipped.push({ label, reason: String(entry?.reason ?? "no data") });
      continue;
    }
    const rows = filterRowsForPeriod(entry.rows ?? [], options.filters ?? {}, range);
    const sums = sumTokens(rows, includeCache);
    const totals = emptyTotals();
    for (const key of TOTAL_KEYS) totals[key] = sums[key] ?? 0;
    const savedAt = entry.savedAt ?? null;
    const parsed = savedAt ? Date.parse(savedAt) : Number.NaN;
    const ageMs = Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null;
    const refreshSeconds = clampRefreshSeconds(entry.refreshSeconds ?? 60);
    machines.push({
      label,
      totals,
      ageMs,
      stale: ageMs === null || ageMs > refreshSeconds * 1000,
    });
  }

  const fleet = emptyTotals();
  for (const machine of machines) {
    for (const key of TOTAL_KEYS) fleet[key] += machine.totals[key] ?? 0;
  }

  return {
    version: 1,
    kind: "insights-fleet",
    range: range.label,
    machines,
    fleet,
    skipped,
  };
}
