import assert from "node:assert/strict";
import test from "node:test";

import { fleetView } from "../mods/insights/core/fleet-view.mjs";

const TODAY = "2026-11-18";

function usageRow(tokens, day = TODAY, overrides = {}) {
  return {
    day,
    session: "codex:session-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-5.6",
    project: "/home/person",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...tokens },
    messages: 1,
    ...overrides,
  };
}

function machine(label, rows, overrides = {}) {
  return {
    label,
    ok: true,
    rows,
    savedAt: new Date().toISOString(),
    refreshSeconds: 300,
    ...overrides,
  };
}

test("the fleet sums the readable machines with analytics' own token rule", () => {
  const payload = {
    includeCache: true,
    machines: [
      machine("This computer", [usageRow({ input: 100, output: 20, cacheRead: 5, cacheWrite: 3, reasoning: 7 })]),
      machine("studio", [usageRow({ input: 50, output: 10, cacheRead: 4, cacheWrite: 0, reasoning: 4 })]),
    ],
  };

  const view = fleetView(payload, { period: "all", today: TODAY });
  assert.equal(view.kind, "insights-fleet");
  assert.deepEqual(view.machines.map((entry) => entry.label), ["This computer", "studio"]);
  assert.deepEqual(view.fleet, {
    input: 150,
    output: 30,
    cacheRead: 9,
    cacheWrite: 3,
    reasoning: 11,
    total: 192,
    messages: 2,
  });
  assert.deepEqual(view.skipped, []);
});

test("cached tokens count only when the config says so", () => {
  const payload = {
    includeCache: false,
    machines: [machine("studio", [usageRow({ input: 10, output: 5, cacheRead: 100, cacheWrite: 50 })])],
  };
  const view = fleetView(payload, { period: "all", today: TODAY });
  assert.equal(view.fleet.cacheRead, 100, "the cached tokens are still reported on their own");
  assert.equal(view.fleet.total, 15, "but they are left out of the total");
});

test("an unreadable machine is skipped, never counted as zero", () => {
  const payload = {
    machines: [
      machine("studio", [usageRow({ input: 10, output: 5 })]),
      { label: "office", ok: false, reason: "could not reach that machine" },
    ],
  };
  const view = fleetView(payload, { period: "all", today: TODAY });
  assert.equal(view.fleet.total, 15, "only the machine that could be read counts");
  assert.deepEqual(view.skipped, [{ label: "office", reason: "could not reach that machine" }]);
});

test("a machine with no usable timestamp is stale, and an old one is too", () => {
  const fresh = fleetView({ machines: [machine("studio", [usageRow({ input: 1 })])] }, { period: "all", today: TODAY });
  assert.equal(fresh.machines[0].stale, false);
  assert.ok(fresh.machines[0].ageMs >= 0);

  const old = fleetView({
    machines: [machine("studio", [usageRow({ input: 1 })], {
      savedAt: new Date(Date.now() - 3_600_000).toISOString(),
      refreshSeconds: 60,
    })],
  }, { period: "all", today: TODAY });
  assert.equal(old.machines[0].stale, true);
  assert.ok(old.machines[0].ageMs >= 3_600_000);

  const untimed = fleetView({
    machines: [machine("studio", [usageRow({ input: 1 })], { savedAt: null })],
  }, { period: "all", today: TODAY });
  assert.equal(untimed.machines[0].stale, true);
  assert.equal(untimed.machines[0].ageMs, null);
});

test("the fleet obeys the same period and facets as the local dashboard", () => {
  const rows = [
    usageRow({ input: 100 }, TODAY, { provider: "openai", model: "gpt-5.6" }),
    usageRow({ input: 50 }, "2026-01-04", { provider: "openai", model: "gpt-5.6" }),
    usageRow({ input: 7 }, TODAY, { provider: "anthropic", model: "claude" }),
  ];
  const payload = { machines: [machine("studio", rows)] };

  const all = fleetView(payload, { period: "all", today: TODAY });
  assert.equal(all.fleet.total, 157, "every day counts in the all-time period");

  const week = fleetView(payload, { period: "week", today: TODAY });
  assert.equal(week.fleet.total, 107, "only this week's rows count");

  const filtered = fleetView(payload, { period: "all", today: TODAY, filters: { provider: "anthropic" } });
  assert.equal(filtered.fleet.total, 7, "the same facets the dashboard applies");
});

test("the range label comes back with the view", () => {
  const view = fleetView({ machines: [machine("studio", [usageRow({ input: 1 })])] }, { period: "week", today: TODAY });
  assert.equal(typeof view.range, "string");
  assert.ok(view.range.length > 0);
});
