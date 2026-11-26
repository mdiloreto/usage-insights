import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  QUOTA_RESUME_AGENTS,
  QUOTA_RESUME_COMMAND_KEY,
  QUOTA_RESUME_MAX_HISTORY,
  QUOTA_RESUME_STATE_KEY,
  buildQuotaResumeView,
  formatCountdownMs,
  formatOutcome,
  formatQueueCountdown,
  formatRelativeAge,
  makeQuotaResumeCommand,
} from "../mods/insights/core/quota-resume-view.mjs";

const BASE_NOW = 1_795_718_000_000;

function baseState(overrides = {}) {
  return {
    version: 1,
    enabled: true,
    updatedAtMs: BASE_NOW,
    lastHandledCommandId: null,
    settings: {
      delaySec: 60,
      agents: { claude: true, codex: true, opencode: true },
      prompt: "The usage limit has reset. Continue from where you left off.",
    },
    queue: [],
    history: [],
    ...overrides,
  };
}

test("quota-resume-view exports contract keys and stays free of host/gpui imports", async () => {
  assert.equal(QUOTA_RESUME_STATE_KEY, "quota-resume.state");
  assert.equal(QUOTA_RESUME_COMMAND_KEY, "quota-resume.command");
  assert.deepEqual(QUOTA_RESUME_AGENTS, ["claude", "codex", "opencode"]);
  assert.equal(QUOTA_RESUME_MAX_HISTORY, 5);

  const source = await readFile(new URL("../mods/insights/core/quota-resume-view.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']herdr["']/);
  assert.doesNotMatch(source, /from\s+["']gpui-kit["']/);
  assert.doesNotMatch(source, /from\s+["']gpui-base["']/);
});

test("missing, null, malformed, or wrong-version state returns null", () => {
  for (const invalid of [undefined, null, false, 123, "state", [], {}, { version: 0 }, { version: 2 }, { version: "1" }]) {
    assert.equal(buildQuotaResumeView(invalid, BASE_NOW), null);
  }
});

test("active idle state summarizes enabled agents cleanly", () => {
  const all = buildQuotaResumeView(baseState(), BASE_NOW);
  assert.ok(all);
  assert.equal(all.enabled, true);
  assert.equal(all.subtitle, "Active · watching Claude, Codex, OpenCode");
  assert.deepEqual(all.agents, [
    { key: "claude", label: "Claude", enabled: true },
    { key: "codex", label: "Codex", enabled: true },
    { key: "opencode", label: "OpenCode", enabled: true },
  ]);
  assert.deepEqual(all.queue, []);
  assert.deepEqual(all.history, []);

  const subset = buildQuotaResumeView(baseState({
    settings: { delaySec: 60, agents: { claude: true, codex: false, opencode: true } },
  }), BASE_NOW);
  assert.equal(subset.subtitle, "Active · watching Claude, OpenCode");
  assert.equal(subset.agents[1].enabled, false);

  const none = buildQuotaResumeView(baseState({
    settings: { delaySec: 60, agents: { claude: false, codex: false, opencode: false } },
  }), BASE_NOW);
  assert.equal(none.subtitle, "Active · no agents enabled");
});

test("active waiting state sorts queue by resumeAtMs ascending and formats local and remote machines", () => {
  const view = buildQuotaResumeView(baseState({
    queue: [
      {
        address: "linux/t3n",
        machine: "linux",
        agent: "claude",
        provider: "claude",
        sessionId: "d322ef60",
        title: "Herdr layout and browser pane options",
        where: "ISW / cdm-ai pr 318 promo",
        detectedAtMs: BASE_NOW - 120_000,
        resetsAtMs: BASE_NOW + 840_000,
        resumeAtMs: BASE_NOW + 900_000, // 15m
        resetSource: "transcript",
        reason: "five_hour rate limit",
        status: "waiting",
        attempts: 0,
      },
      {
        address: "t2c",
        machine: null,
        agent: "codex",
        provider: "openai",
        title: "",
        where: "local / api-worker",
        detectedAtMs: BASE_NOW - 60_000,
        resetsAtMs: BASE_NOW + 240_000,
        resumeAtMs: BASE_NOW + 300_000, // 5m
        resetSource: "quota",
        reason: "rate limit",
        status: "waiting",
        attempts: 1,
      },
      {
        address: "mac-studio/t9a",
        machine: "mac-studio",
        agent: "opencode",
        title: "",
        where: "",
        detectedAtMs: BASE_NOW - 30_000,
        resetsAtMs: null,
        resumeAtMs: null,
        resetSource: "fallback",
        reason: "",
        status: "resuming",
        attempts: 2,
      },
    ],
  }), BASE_NOW);

  assert.equal(view.subtitle, "Active · 3 waiting across 3 machines");
  assert.deepEqual(view.queue.map((item) => item.address), ["t2c", "linux/t3n", "mac-studio/t9a"]);

  assert.equal(view.queue[0].agentLabel, "Codex");
  assert.equal(view.queue[0].machineLabel, "Local");
  assert.equal(view.queue[0].title, "local / api-worker");
  assert.equal(view.queue[0].where, null, "where is not duplicated when used as title fallback");
  assert.equal(view.queue[0].detail, "rate limit · quota");
  assert.equal(view.queue[0].countdown, "in 5m");

  assert.equal(view.queue[1].agentLabel, "Claude");
  assert.equal(view.queue[1].machineLabel, "linux");
  assert.equal(view.queue[1].title, "Herdr layout and browser pane options");
  assert.equal(view.queue[1].where, "ISW / cdm-ai pr 318 promo");
  assert.equal(view.queue[1].detail, "five_hour rate limit · transcript");
  assert.equal(view.queue[1].countdown, "in 15m");

  assert.equal(view.queue[2].agentLabel, "OpenCode");
  assert.equal(view.queue[2].machineLabel, "mac-studio");
  assert.equal(view.queue[2].title, "mac-studio/t9a", "address is the final title fallback");
  assert.equal(view.queue[2].detail, "fallback");
  assert.equal(view.queue[2].countdown, "resuming…");
});

test("single-machine queue omits the multi-machine suffix and paused state formats cleanly", () => {
  const singleLocal = buildQuotaResumeView(baseState({
    enabled: false,
    queue: [
      {
        address: "t1",
        machine: null,
        agent: "claude",
        title: "Refactor",
        resumeAtMs: BASE_NOW + 14 * 60_000,
        status: "waiting",
      },
    ],
  }), BASE_NOW);

  assert.equal(singleLocal.enabled, false);
  assert.equal(singleLocal.subtitle, "Paused · 1 waiting");
  assert.equal(singleLocal.queue[0].countdown, "paused · in 14m");

  const pausedEmpty = buildQuotaResumeView(baseState({ enabled: false, queue: [] }), BASE_NOW);
  assert.equal(pausedEmpty.subtitle, "Paused");

  const pausedItemWhenReady = buildQuotaResumeView(baseState({
    enabled: true,
    queue: [
      {
        address: "t2",
        machine: null,
        agent: "claude",
        title: "Held",
        resumeAtMs: BASE_NOW - 10_000,
        status: "paused",
      },
    ],
  }), BASE_NOW);
  assert.equal(pausedItemWhenReady.queue[0].countdown, "paused");
});

test("countdown formatting handles seconds, minutes, hours, days, ready, and status overrides", () => {
  assert.equal(formatCountdownMs(-5_000), "ready");
  assert.equal(formatCountdownMs(0), "ready");
  assert.equal(formatCountdownMs(500), "in 1s");
  assert.equal(formatCountdownMs(45_000), "in 45s");
  assert.equal(formatCountdownMs(60_000), "in 1m");
  assert.equal(formatCountdownMs(14 * 60_000), "in 14m");
  assert.equal(formatCountdownMs(59 * 60_000 + 59_000), "in 1h");
  assert.equal(formatCountdownMs(90 * 60_000), "in 1h 30m");
  assert.equal(formatCountdownMs(24 * 3_600_000), "in 1d");
  assert.equal(formatCountdownMs(26 * 3_600_000), "in 1d 2h");

  assert.equal(formatQueueCountdown({ status: "resuming", resumeAtMs: BASE_NOW + 60_000 }, BASE_NOW, true), "resuming…");
  assert.equal(formatQueueCountdown({ status: "waiting", resumeAtMs: BASE_NOW - 1 }, BASE_NOW, true), "ready");
  assert.equal(formatQueueCountdown({ status: "waiting", resumeAtMs: null }, BASE_NOW, true), "pending");
  assert.equal(formatQueueCountdown({ status: "paused", resumeAtMs: null }, BASE_NOW, true), "paused");
});

test("history truncates to top 5 most recent entries and maps all outcome labels and relative ages", () => {
  const outcomes = [
    ["resumed", "Resumed", "done"],
    ["skipped-replied", "Skipped · replied", "dim"],
    ["skipped-closed", "Skipped · closed", "dim"],
    ["skipped-busy", "Skipped · busy", "dim"],
    ["skipped-session", "Skipped · session changed", "dim"],
    ["cancelled", "Cancelled", "dim"],
    ["failed", "Failed", "destructive"],
  ];

  for (const [key, label, tone] of outcomes) {
    assert.deepEqual(formatOutcome(key), { label, tone });
  }

  assert.equal(formatRelativeAge(BASE_NOW - 3_000, BASE_NOW), "just now");
  assert.equal(formatRelativeAge(BASE_NOW - 45_000, BASE_NOW), "45s ago");
  assert.equal(formatRelativeAge(BASE_NOW - 12 * 60_000, BASE_NOW), "12m ago");
  assert.equal(formatRelativeAge(BASE_NOW - 3 * 3_600_000, BASE_NOW), "3h ago");
  assert.equal(formatRelativeAge(BASE_NOW - 2 * 86_400_000, BASE_NOW), "2d ago");

  const history = outcomes.map(([outcome], index) => ({
    id: `h-${index}`,
    address: index % 2 === 0 ? `t${index}` : `linux/t${index}`,
    machine: index % 2 === 0 ? null : "linux",
    agent: QUOTA_RESUME_AGENTS[index % 3],
    title: `Task ${index}`,
    outcome,
    detail: `Detail ${index}`,
    // Out-of-order timestamps to verify newest-first sorting before truncation.
    atMs: BASE_NOW - (outcomes.length - index) * 60_000,
  }));

  const view = buildQuotaResumeView(baseState({ history }), BASE_NOW);
  assert.equal(view.totalHistoryCount, 7);
  assert.equal(view.history.length, 5);
  assert.deepEqual(view.history.map((entry) => entry.id), ["h-6", "h-5", "h-4", "h-3", "h-2"]);
  assert.equal(view.history[0].outcomeLabel, "Failed");
  assert.equal(view.history[0].outcomeTone, "destructive");
  assert.equal(view.history[0].machineLabel, "Local");
  assert.equal(view.history[0].age, "1m ago");
  assert.equal(view.history[1].machineLabel, "linux");
  assert.equal(view.history[1].outcomeLabel, "Cancelled");
});

test("command builder produces exact contract payloads for all 5 actions with unique IDs", () => {
  const c1 = makeQuotaResumeCommand("toggle-enabled", { enabled: false }, BASE_NOW, 1);
  assert.deepEqual(c1, {
    version: 1,
    id: `${BASE_NOW}-1`,
    action: "toggle-enabled",
    enabled: false,
    atMs: BASE_NOW,
  });

  const c2 = makeQuotaResumeCommand("toggle-agent", { agent: "codex", enabled: true }, BASE_NOW, 2);
  assert.deepEqual(c2, {
    version: 1,
    id: `${BASE_NOW}-2`,
    action: "toggle-agent",
    agent: "codex",
    enabled: true,
    atMs: BASE_NOW,
  });

  const c3 = makeQuotaResumeCommand("cancel", { address: "linux/t3n" }, BASE_NOW, 3);
  assert.deepEqual(c3, {
    version: 1,
    id: `${BASE_NOW}-3`,
    action: "cancel",
    address: "linux/t3n",
    atMs: BASE_NOW,
  });

  const c4 = makeQuotaResumeCommand("resume-now", { address: "t2c" }, BASE_NOW, 4);
  assert.deepEqual(c4, {
    version: 1,
    id: `${BASE_NOW}-4`,
    action: "resume-now",
    address: "t2c",
    atMs: BASE_NOW,
  });

  const c5 = makeQuotaResumeCommand("clear-history", {}, BASE_NOW, 5);
  assert.deepEqual(c5, {
    version: 1,
    id: `${BASE_NOW}-5`,
    action: "clear-history",
    atMs: BASE_NOW,
  });

  const ids = new Set([c1.id, c2.id, c3.id, c4.id, c5.id]);
  assert.equal(ids.size, 5);

  assert.throws(() => makeQuotaResumeCommand("unknown", {}, BASE_NOW, 6), /Unsupported/);
  assert.throws(() => makeQuotaResumeCommand("toggle-agent", { agent: "pi", enabled: true }, BASE_NOW, 7), /Unsupported/);
  assert.throws(() => makeQuotaResumeCommand("cancel", { address: "   " }, BASE_NOW, 8), /address/);
  assert.throws(() => makeQuotaResumeCommand("resume-now", {}, BASE_NOW, 9), /address/);
});
