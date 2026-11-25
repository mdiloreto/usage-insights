import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createQuotaCoordinator, EXEC_TIMEOUT_MS, FLIGHT_MS, LAUNCHER, LEASE_MS,
  REVISION_KEY as OWNER_KEY, REGISTRY_TIMEOUT_MS, TICK_MS } from "../mods/insights/fleet-quota/coordinator.mjs";
import { fingerprintCore, parseMachineRegistry, parseQuotaReply } from "../mods/insights/fleet-quota/protocol.mjs";
import { insightQuotaHosts } from "../mods/insights/quota-projection.mjs";

const T0 = 1_795_410_000;
const A = "b63d6e49d5c57fd6474fef54938abf77";
const B = "e5b9d32b72f1386d5984c3bcbba79f17";
const GENERATION = "1".repeat(32);
const BINDING = "5".repeat(64);
const ACCOUNT = "7".repeat(64);
const RUNTIME = "4993fc1e-eead-4a44-b0c7-7f86b8b071be";
const OLD_RUNTIME = "3e03ddb2-dcc6-4fc3-b654-caa4e90790a5";
const RUNTIME_KEY = Symbol.for("usage-insights.fleet-quota.runtime");
const tickAsync = () => new Promise((resolve) => setImmediate(resolve));
const registryRow = (name = "linux", id = A, state = "connected", host = "Build host") => ({
  name, host, id, state, version: "0.1.20", temporary: false, why: "never expose me",
});
const grant = (route = "linux", id = A, generation = GENERATION, providers = ["codex"]) => ({
  version: 1, route, generation, coreDigest: fingerprintCore(id, generation),
  binding: BINDING, enabled: true, providers,
});
const reply = (value, code = 0) => ({ code, stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "private stderr /home/example token=never-show" });
const win = (id, percent, durationSec, resetsAt) => ({ id, percent, durationSec, resetsAt,
  short: "FORGED LABEL", long: "never expose wire labels" });
const CLAUDE_MONEY = { currency: "$", usedMinor: 53_173, limitMinor: 60_000, resetLabel: "Dec 1" };
function report(now, provider = "codex", patch = {}) {
  return { version: 1, provider, status: "fresh", readAt: now, attemptedAt: now, retryAt: now + 300,
    binding: BINDING, reading: { source: "cli", observedAt: now, account: ACCOUNT,
      plan: provider === "codex" ? "plus" : "max",
      windows: provider === "codex" ?
        [win("codex:primary", 0, 18_000, now + 60), win("codex:secondary", 100, 604_800, now + 3_600)] :
        [win("session", 0, 18_000, now + 120), win("weekly_scoped:Sonnet", 100, 604_800, now + 3_600)],
    }, ...patch };
}

function fixture() {
  let elapsed = 0;
  const shared = new Map();
  const calls = [];
  const writes = [];
  const invalidations = [];
  let scans = 0;
  let nonce = 0;
  let runtimeGlobal = {};
  const f = { calls, writes, invalidations, shared, rows: [registryRow()], enrollment: [grant()], registry: null,
    checkMode: false, hints: [{ name: null, layout: "ready" }, { name: "linux", layout: "unavailable" }],
    quota: (_, provider) => reply(report(f.now(), provider)), now: () => T0 + Math.floor(elapsed / 1000),
    rotateRuntime: () => { runtimeGlobal = {}; }, scans: () => scans };
  f.runtime = () => runtimeGlobal;
  const exec = (cmd, args, options) => {
    if (cmd === "hc") {
      scans++;
      assert.deepEqual(args, ["machine", "ls", "--json"]);
      assert.deepEqual(options, { timeout: REGISTRY_TIMEOUT_MS });
      return f.registry ? f.registry() : reply({ machines: f.rows });
    }
    const [flag, script, zero, operation, provider, binding] = args;
    assert.deepEqual([cmd, flag, script, zero], ["sh", "-c", LAUNCHER, "herdr-quota-v1"]);
    assert.equal(options.timeout, EXEC_TIMEOUT_MS);
    assert.ok(/^[0-9a-f]{32}$/.test(options.on));
    assert.equal(binding, BINDING);
    calls.push({ operation, provider, id: options.on });
    return f.quota(operation, provider, options.on);
  };
  f.copy = (opts) => createQuotaCoordinator({
    shared: (key) => structuredClone(shared.get(key)),
    setShared: (key, value) => { writes.push([key, value]); shared.set(key, structuredClone(value)); },
    exec, machines: () => f.hints, checking: () => f.checkMode, readEnrollments: () => f.enrollment,
    invalidateEnrollment: (intent) => {
      invalidations.push(intent);
      f.enrollment = f.enrollment.map((row) => row.route === intent.route && row.generation === intent.generation ?
        { ...row, enabled: false, invalidated: intent.reason } : row);
      return true;
    },
    now: f.now, monotonic: () => elapsed, randomUUID: () => nonce++ === 0 ? RUNTIME : OLD_RUNTIME,
    runtimeGlobal, ...opts,
  });
  f.advance = (ms) => { elapsed += ms; };
  f.boot = async (...copies) => {
    copies.forEach((copy) => { assert.equal(copy.mount(), true); copy.tick(); });
    await tickAsync();
    f.advance(FLIGHT_MS);
    copies.forEach((copy) => copy.tick());
    await tickAsync();
  };
  f.step = async (ms, ...copies) => {
    f.advance(ms);
    copies.forEach((copy) => copy.tick());
    await tickAsync();
  };
  return f;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const remote = (coordinator, provider = "codex", route = "linux") =>
  coordinator.snapshot().remotes.find((host) => host.route === route).providers.find((row) => row.provider === provider);

test("the fixed launcher matches the helper source when together in the integration tree", async (t) => {
  try {
    assert.equal(LAUNCHER, await readFile(new URL("../scripts/quota/launch.sh", import.meta.url), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    t.skip("helper lane is not integrated in this worktree");
  }
});

test("parser enforces the fixed wire, checks times/bounds/statuses and projects only canonical labels", () => {
  assert.equal(fingerprintCore(A, GENERATION), createHash("sha256").update("quota:core-binding:v1\0")
    .update(Buffer.from(GENERATION + A, "hex")).digest("hex"));
  const parse = (r) => parseQuotaReply(r, { provider: "codex", binding: BINDING, now: T0, sentAt: T0 });
  const good = report(T0);
  const valid = parse(reply(good)).data;
  assert.deepEqual(valid.reading.windows.map(({ short, percent }) => [short, percent]), [["5h", 0], ["wk", 100]]);
  assert.equal(parse(reply({ ...good, binding: "a".repeat(64) })).reason, "binding-mismatch");
  assert.equal(parse(reply({ ...good, binding: null })).reason, "binding-mismatch");
  assert.equal(parse(reply({ ...good, version: 2 })).reason, "malformed");
  assert.equal(parse(reply({ ...good, provider: "claude" })).reason, "malformed");
  assert.equal(parse(reply({ ...good, readAt: T0 + 61 })).reason, "malformed");
  assert.equal(parse(reply({ ...good, retryAt: T0 + 3_601 })).reason, "malformed");
  assert.equal(parse(reply({ ...good, attemptedAt: T0 + 1 })).reason, "malformed");
  assert.equal(parse(reply({ ...good, attemptedAt: T0 - 61 })).reason, "malformed");
  assert.equal(parse(reply({ ...good, reading: { ...good.reading, account: `raw@example` } })).reason, "malformed");
  assert.equal(parse(reply({ ...good, reading: { ...good.reading, plan: "account: raw@example" } })).reason, "malformed");
  for (const change of [{ id: "codex:primary\n" }, { percent: "0" }, { percent: 101 },
    { resetsAt: T0 + 0.1 }, { durationSec: 1 }]) {
    const reading = { ...good.reading, windows: [{ ...good.reading.windows[0], ...change }] };
    assert.equal(parse(reply({ ...good, reading })).reason, "malformed");
  }
  assert.equal(parse(reply({ ...good, reading: { ...good.reading,
    windows: Array(2).fill(good.reading.windows[0]) } })).reason, "malformed");
  assert.equal(parse(reply({ ...good, unknown: "㊙".repeat(12_000) })).reason, "malformed");
  assert.equal(parse(reply("", 73)).reason, "helper-missing");
  assert.equal(parse(reply("", 74)).reason, "helper-unsafe");
  assert.equal(parse(reply("not a launcher result", 73)).reason, "transport-unknown");
  assert.equal(parse(null).reason, "transport-unknown");
  const denied = { ...good, binding: null, attemptedAt: null, retryAt: null, reading: null };
  assert.equal(parse(reply({ ...denied, status: "not-enrolled" })).reason, "receiver-not-enrolled");
  assert.equal(parse(reply({ ...denied, status: "unavailable" })).reason, "receiver-unavailable");
  assert.equal(parse(reply({ ...denied, status: "not-enrolled", reading: good.reading })).reason, "binding-mismatch");
  assert.equal(parseMachineRegistry(reply({ machines: [registryRow("bad\n")] })), null);
  assert.equal(parseMachineRegistry(reply({ machines: [registryRow(), registryRow()] })), null);
  assert.equal(parseMachineRegistry(reply({ machines: [registryRow("linux", A, "connected", "`touch foo`")] }))
    .get("linux").label, "linux");
});

test("Claude v1 types follow fixed IDs and verified account evidence, not labels or guessed percentages", () => {
  const parse = (r) => parseQuotaReply(reply(r), { provider: "claude", binding: BINDING, now: T0, sentAt: T0 });
  const frontier = { ...win("frontier_credit", 0, null, T0 + 300), short: "Fable/Opus", long: "Fable/Opus credit", kind: "plan" };
  const monthly = { ...win("monthly_spend_limit", 100, null, null), short: "Monthly limit", long: "Monthly spend limit" };
  const plan = { ...win("weekly_scoped:Fable", 42, 604_800, T0 + 200), kind: "credit" };
  const baseline = report(T0, "claude");
  const reading = { ...baseline.reading, windows: [plan, frontier, monthly] };
  const input = { ...baseline, reading };
  const old = parse(input).data.reading.windows;
  assert.deepEqual(old.map((w) => [w.kind, w.long, w.percent, w.money]), [
    ["plan", "Weekly · Fable", 42, undefined], ["credit", "Frontier credit", 0, undefined],
    ["spend", "Monthly usage credits", 100, undefined],
  ]);
  assert.deepEqual(parse({ ...input, reading: { ...reading, account: null } }), { reason: "malformed" });
  assert.deepEqual(parse({ ...input, status: "identity-changed", reading: { ...reading, source: "history" } }), { reason: "malformed" });
  assert.deepEqual(parse({ ...input, status: "estimated", reading: { ...reading, source: "history" } }), { reason: "malformed" });
  assert.deepEqual(parse({ ...input, binding: "6".repeat(64) }), { reason: "binding-mismatch" });

  const patch = (w) => ({ ...input, reading: { ...reading, windows: [w] } });
  for (const currency of ["$", "USD"]) {
    const money = { ...CLAUDE_MONEY, currency };
    assert.deepEqual(parse(patch({ ...monthly, money })).data.reading.windows[0].money, money);
  }
  for (const override of [
    { currency: "CAD" }, { usedMinor: "-1" }, { usedMinor: 0.01 }, { usedMinor: -1 },
    { limitMinor: 0 }, { limitMinor: Number.MAX_SAFE_INTEGER + 1 },
    { resetLabel: "Dec 1\n" }, { resetLabel: "Dec 1, 00:00" }, { resetLabel: "Feb 30" },
    { resetLabel: "Feb 29, 2027" }, { resetLabel: null }, { raw: "do not relay" },
  ]) {
    assert.deepEqual(parse(patch({ ...monthly, money: { ...CLAUDE_MONEY, ...override } })), { reason: "malformed" });
  }
  assert.deepEqual(parse(patch({ ...plan, money: CLAUDE_MONEY })), { reason: "malformed" });
  assert.deepEqual(parse(patch({ ...monthly, percent: "88", money: CLAUDE_MONEY })), { reason: "malformed" });
});

test("Claude projection replaces single observations, preserves dated spend and fences a late reply", async () => {
  const f = fixture();
  f.enrollment = [grant("linux", A, GENERATION, ["claude"])];
  const a = f.copy();
  const b = f.copy();
  await f.boot(a, b);
  const held = deferred();
  f.quota = () => held.promise;
  await f.step(300_000, a, b);
  a.dispose();
  await f.step(TICK_MS, b);
  const monthlyReply = () => {
    const payload = report(f.now(), "claude");
    payload.reading.windows = [{ ...win("monthly_spend_limit", 88, null, null), money: CLAUDE_MONEY }];
    return payload;
  };
  f.quota = () => reply(monthlyReply());
  await f.step(FLIGHT_MS, b);
  const current = remote(b, "claude").current;
  assert.deepEqual(current.windows.map(({ kind }) => kind), ["spend"]);
  assert.equal(remote(b, "claude").history, null);
  held.resolve(reply(report(f.now(), "claude")));
  await tickAsync();
  assert.deepEqual(remote(b, "claude").current, current);

  const display = () => insightQuotaHosts(b.snapshot(), "This Computer", f.now() * 1_000)[1].providers
    .find((row) => row.provider === "claude");
  assert.equal(display().planUnavailable, true);
  const projected = { kind: "spend", label: "Monthly usage credits", usedPercent: 88,
    resetAtMs: null, pacePercent: null, money: CLAUDE_MONEY };
  assert.deepEqual(display().windows, [projected]);
  f.advance(900_000);
  assert.equal(display().status, "stale");
  assert.deepEqual(display().windows, []);
  assert.deepEqual(display().historyWindows, [projected]);
  assert.equal(display().observedAtMs, current.observedAt * 1_000);
});

test("check, no mounted views, incompatible ownership and missing enrollment cannot start quota work", async () => {
  const f = fixture();
  const neverMounted = f.copy();
  neverMounted.tick();
  await tickAsync();
  assert.deepEqual([f.scans(), f.writes.length], [0, 0]);
  f.checkMode = true;
  assert.equal(neverMounted.mount(), false);
  assert.equal(neverMounted.snapshot().owner, "unavailable");
  neverMounted.tick();
  assert.deepEqual([f.scans(), f.writes.length], [0, 0]);
  f.checkMode = false;
  const unsupported = f.copy({ version: 77 });
  assert.equal(unsupported.mount(), false);
  const noClock = f.copy({ monotonic: () => { throw new Error("clock unsupported"); } });
  assert.equal(noClock.mount(), false);
  assert.equal(noClock.snapshot().owner, "unavailable");
  f.shared.set(OWNER_KEY, { version: 77, keep: "foreign" });
  assert.equal(f.copy().mount(), false);
  assert.deepEqual(f.shared.get(OWNER_KEY), { version: 77, keep: "foreign" });
  f.shared.delete(OWNER_KEY);
  f.enrollment = [];
  const active = f.copy();
  await f.boot(active);
  assert.equal(remote(active).reason, "not-enrolled");
  assert.deepEqual(f.calls, []);
  active.dispose();
  const scans = f.scans();
  await f.step(300_000, active);
  assert.equal(f.scans(), scans);
});

test("one process owner shares data; uses Core ID in on, not route, labels or missing layout", async () => {
  const f = fixture();
  const first = f.copy();
  const second = f.copy();
  await f.boot(first, second);
  assert.deepEqual(f.calls, [{ operation: "read", provider: "codex", id: A }]);
  const snapshot = second.snapshot();
  assert.deepEqual(first.snapshot(), snapshot);
  assert.deepEqual([snapshot.owner, snapshot.remotes[0].route, snapshot.remotes[0].label],
    ["ready", "linux", "Build host"]);
  assert.equal(snapshot.remotes[0].registered, true);
  assert.equal(snapshot.remotes[0].enrolled, true);
  assert.deepEqual(remote(second).current.windows.map((w) => w.percent), [0, 100]);
  assert.equal(remote(second, "claude").reason, "paused");
  assert.equal(remote(second, "claude").refreshable, false);
  const display = JSON.stringify([snapshot, f.writes]);
  for (const forbidden of [A, ACCOUNT, BINDING, "FORGED LABEL", "private stderr", "never expose me"]) {
    assert.equal(display.includes(forbidden), false, forbidden);
  }
  for (let i = 0; i < 15; i++) await f.step(TICK_MS, first, second);
  assert.equal(f.calls.length, 1);
});

test("refresh only targets one provider and joins same-pair requests without confusing cache with freshness", async () => {
  const f = fixture();
  f.rows.push(registryRow("other", B));
  f.enrollment.push(grant("other", B, "2".repeat(32), ["claude"]));
  const a = f.copy();
  const b = f.copy();
  await f.boot(a, b);
  assert.equal(f.calls.length, 2);
  assert.equal(remote(b).refreshable, false);
  assert.equal(b.refresh("linux", "codex").status, "deferred");
  assert.equal(b.refresh("linux", "claude").reason, "paused");
  const held = deferred();
  f.quota = () => held.promise;
  await f.step(31_000, a, b);
  assert.equal(remote(b).refreshable, true);
  assert.equal(b.refresh("linux", "codex").status, "queued");
  assert.equal(remote(b).refreshable, false);
  await f.step(TICK_MS, a, b);
  assert.deepEqual(f.calls.slice(2), [{ operation: "refresh", provider: "codex", id: A }]);
  assert.equal(b.refresh("linux", "codex").status, "in-flight");
  assert.equal(remote(b).status, "in-flight");
  assert.equal(remote(b).refreshable, false);
  held.resolve(reply(report(f.now(), "codex", { status: "cooldown" })));
  await tickAsync();
  assert.equal(remote(b).refresh.status, "deferred");
  assert.equal(f.calls.length, 3);
});

test("lease handoff guards a still-running flight and startup rejects a persisted read and lease", async () => {
  const f = fixture();
  const held = deferred();
  f.quota = () => held.promise;
  const a = f.copy();
  const b = f.copy();
  await f.boot(a, b);
  assert.equal(f.calls.length, 1);
  a.dispose();
  await f.step(TICK_MS, b);
  assert.equal(f.calls.length, 1);
  assert.equal(remote(b).current, null);
  held.resolve(reply(report(f.now())));
  await tickAsync();
  assert.equal(remote(b).current, null);
  f.quota = (_, p) => reply(report(f.now(), p));
  await f.step(TICK_MS, b);
  assert.equal(f.calls.length, 2);
  assert.ok(remote(b).current);
  f.shared.set(OWNER_KEY, { version: 1, runtime: RUNTIME, term: 99, lease: { copy: 99, until: 999_999 },
    projection: b.snapshot() });
  f.rotateRuntime();
  const restarted = f.copy();
  assert.equal(restarted.mount(), true);
  restarted.tick();
  assert.equal(remote(restarted).current, null);
  assert.equal(f.runtime()[RUNTIME_KEY].token, OLD_RUNTIME);
  await f.step(LEASE_MS + 1, restarted);
  assert.deepEqual(Object.keys(f.shared.get(OWNER_KEY)).sort(), ["revision", "version"]);
  assert.equal(f.calls.length, 2);
  await f.step(FLIGHT_MS, restarted);
  assert.equal(f.calls.length, 3);
});

test("local-only ticking renews a runtime lease without writes or recurring registry work; a hint wakes discovery", async () => {
  const f = fixture();
  f.enrollment = [];
  f.rows = [];
  f.hints = [{ name: null, layout: "ready" }];
  const first = f.copy();
  const second = f.copy();
  assert.equal(first.mount(), true);
  assert.equal(second.mount(), true);
  for (let i = 0; i < 200; i++) await f.step(TICK_MS, first, second);
  assert.equal(first.snapshot().owner, "ready");
  assert.equal(first.snapshot().nextUpdateAt, null);
  assert.equal(f.scans(), 1);
  assert.deepEqual(f.writes, [[OWNER_KEY, { version: 1, revision: 1 }]]);
  f.rows = [registryRow()];
  f.hints.push({ name: "linux", layout: "unavailable" });
  await f.step(TICK_MS, first, second);
  assert.equal(f.scans(), 2);
  assert.equal(remote(second).reason, "not-enrolled");
  const before = f.writes.length;
  for (let i = 0; i < 40; i++) await f.step(TICK_MS, first, second);
  assert.equal(f.writes.length, before, "unchanged registry + renewals must not notify");
  assert.deepEqual(f.calls, []);
  first.dispose();
  await tickAsync();
  assert.equal(f.writes.length, before + 1);
  await f.step(TICK_MS, second);
  assert.equal(f.writes.length, before + 2);
});

test("initial registry discovery sees a registration missing from App hints", async () => {
  const f = fixture();
  f.hints = [{ name: null, layout: "ready" }];
  f.enrollment = [];
  const copy = f.copy();
  assert.equal(copy.mount(), true);
  await f.step(TICK_MS, copy);
  assert.equal(copy.snapshot().remotes[0].route, "linux");
  assert.equal(f.scans(), 1);
  assert.equal(f.calls.length, 0);
});

test("only Core-valid hints appear; unverified hints do not confer registration or refresh permission", async () => {
  const f = fixture();
  f.rows = [];
  f.enrollment = [];
  f.hints = [null, "", "Upper", "-bad", "t7", "t1b", "t9zzzzzzzzzz", "with/slash", "line\n", "a".repeat(33),
    "t3po", "t0", "w_2.b", A].map((name) => ({ name }));
  const copy = f.copy();
  await f.boot(copy);
  const remotes = copy.snapshot().remotes;
  assert.deepEqual(remotes.map((row) => row.route), [A, "t0", "t3po", "w_2.b"]);
  assert.ok(remotes.every((row) => !row.registered && !row.enrolled && row.providers.every((p) => !p.refreshable)));
  assert.equal(copy.refresh("t7", "codex").reason, "invalid-pair");
});

test("unrecognized coordination state fails closed before work and during a flight", async () => {
  const f = fixture();
  f.runtime()[RUNTIME_KEY] = { version: 1, unexpected: true };
  assert.equal(f.copy().mount(), false);
  assert.equal(f.writes.length, 0);
  delete f.runtime()[RUNTIME_KEY];
  f.shared.set(OWNER_KEY, { version: 1, unexpected: true });
  assert.equal(f.copy().mount(), false);
  assert.equal(f.writes.length, 0);
  f.shared.delete(OWNER_KEY);
  const held = deferred();
  const copy = f.copy();
  f.quota = () => held.promise;
  await f.boot(copy);
  const scans = f.scans();
  f.shared.set(OWNER_KEY, { version: 8, foreign: true });
  held.resolve(reply(report(f.now())));
  await tickAsync();
  assert.equal(f.scans(), scans);
  assert.equal(copy.snapshot().owner, "unavailable");
  assert.equal(remote(copy).current, null);
  assert.deepEqual(f.shared.get(OWNER_KEY), { version: 8, foreign: true });
});

test("snapshot exposes the next reset, cooldown and expiry boundary without scheduling any work", async () => {
  const f = fixture();
  const copy = f.copy();
  await f.boot(copy);
  const readAt = f.now();
  assert.equal(copy.snapshot().nextUpdateAt, readAt + 30, "refresh cooldown");
  assert.equal(remote(copy).refreshAvailableAt, readAt + 30);
  for (let i = 0; i < 120; i++) await f.step(TICK_MS, copy);
  assert.equal(copy.snapshot().nextUpdateAt, readAt + 60, "first reset");
  assert.equal(remote(copy).refreshAvailableAt, null);
  assert.equal(remote(copy).current.windows.length, 2);
  const writes = f.writes.length;
  for (let i = 0; i < 120; i++) await f.step(TICK_MS, copy);
  assert.deepEqual(remote(copy).current.windows.map((row) => row.percent), [100]);
  assert.equal(copy.snapshot().nextUpdateAt, readAt + 300, "retry timestamp ages out");
  assert.equal(f.writes.length, writes, "reading and resets do not write a revision");
});

test("expired leases discard old provider results; the successor waits through the bound", async () => {
  const f = fixture();
  const held = deferred();
  const first = f.copy();
  const second = f.copy();
  f.quota = () => held.promise;
  await f.boot(first, second);
  await f.step(LEASE_MS + 1, second);
  assert.equal(f.calls.length, 1);
  assert.equal(remote(second).current, null);
  f.quota = (_, provider) => reply(report(f.now(), provider));
  await f.step(FLIGHT_MS, second);
  assert.equal(f.calls.length, 2);
  const next = remote(second).current;
  held.resolve(reply(report(f.now(), "codex", { reading: null })));
  await tickAsync();
  assert.deepEqual(remote(second).current, next);
});

test("post-check rejects a replaced or removed route and sticky revocation survives same-route re-add", async () => {
  for (const change of [[], [registryRow("linux", B)]]) {
    const f = fixture();
    const a = f.copy();
    const held = deferred();
    f.quota = () => held.promise;
    await f.boot(a);
    f.rows = change;
    held.resolve(reply(report(f.now())));
    await tickAsync();
    assert.equal(remote(a).reason, "reenrollment-required");
    assert.equal(remote(a).current, null);
    assert.equal(remote(a).refreshable, false);
    assert.equal(a.snapshot().remotes[0].registered, change.length > 0);
    assert.equal(a.snapshot().remotes[0].enrolled, false);
    assert.deepEqual(f.invalidations, [{ route: "linux", generation: GENERATION,
      reason: change.length ? "core-replaced" : "route-removed" }]);
    f.rows = [registryRow()];
    await f.step(300_000, a);
    assert.equal(f.calls.length, 1);
    assert.equal(remote(a).current, null);
    a.dispose();
    f.rotateRuntime();
    const restarted = f.copy();
    await f.boot(restarted);
    assert.equal(remote(restarted).reason, "reenrollment-required");
    assert.equal(f.calls.length, 1);
  }
});

test("observed ambiguity or offline does not revoke; unobservable identical change preserves the grant", async () => {
  const f = fixture();
  const held = deferred();
  f.quota = () => held.promise;
  const a = f.copy();
  await f.boot(a);
  f.rows = [];
  f.rows = [registryRow()];
  held.resolve(reply(report(f.now())));
  await tickAsync();
  assert.ok(remote(a).current);
  assert.deepEqual(f.invalidations, []);
  f.rows.push(registryRow(A, B));
  await f.step(5_000, a);
  assert.equal(remote(a).reason, "route-ambiguous");
  assert.equal(remote(a).current, null);
  f.rows = [registryRow("linux", A, "unreachable")];
  await f.step(5_000, a);
  assert.equal(remote(a).reason, "offline");
  assert.equal(remote(a).refreshable, false);
  assert.equal(a.snapshot().remotes[0].enrolled, true);
  assert.equal(a.snapshot().remotes[0].registered, true);
  assert.deepEqual(f.invalidations, []);
});

test("late provider replies do not survive explicit local re-enrollment", async () => {
  const f = fixture();
  const held = deferred();
  f.quota = () => held.promise;
  const a = f.copy();
  await f.boot(a);
  f.enrollment = [grant("linux", A, "2".repeat(32))];
  held.resolve(reply(report(f.now())));
  await tickAsync();
  assert.equal(remote(a).current, null);
  f.quota = (_, p) => reply(report(f.now(), p));
  await f.step(TICK_MS, a);
  assert.equal(f.calls.length, 2);
  assert.ok(remote(a).current);
});

test("receiver denial revokes and transport outcomes never borrow prior numerical evidence", async () => {
  for (const [response, reason] of [
    [() => reply("", 73), "helper-missing"],
    [() => reply("", 74), "helper-unsafe"],
    [() => Promise.reject(new Error("secret: file not found")), "transport-unknown"],
    [(time) => reply(report(time, "codex", { status: "unavailable", binding: null,
      attemptedAt: null, retryAt: null, reading: null })), "receiver-unavailable"],
    [(time) => reply(report(time, "codex", { status: "not-enrolled", binding: null,
      attemptedAt: null, retryAt: null, reading: null })), "reenrollment-required"],
    [(time) => reply(report(time, "codex", { binding: "6".repeat(64) })), "binding-mismatch"],
  ]) {
    const f = fixture();
    const a = f.copy();
    await f.boot(a);
    assert.ok(remote(a).current);
    f.quota = () => response(f.now());
    await f.step(300_000, a);
    const view = remote(a);
    assert.equal(view.reason, reason);
    assert.equal(view.current, null);
    assert.equal(view.history, null);
    assert.equal(JSON.stringify(view).includes("secret"), false);
    assert.equal(f.invalidations.length, Number(reason === "reenrollment-required"));
  }
});

test("a hanging pair does not block a separate manual refresh; host lock outcome is deferred", async () => {
  const f = fixture();
  f.rows.push(registryRow("other", B));
  f.enrollment.push(grant("other", B, "2".repeat(32), ["claude"]));
  const a = f.copy();
  const held = deferred();
  f.quota = (_, provider) => provider === "codex" ? held.promise :
    reply({ ...report(f.now(), provider), attemptedAt: f.now() - 30 });
  await f.boot(a);
  f.quota = (_, provider) => reply(report(f.now(), provider, {
    status: "in-flight", attemptedAt: null, retryAt: null, reading: null,
  }));
  assert.equal(a.refresh("other", "claude").status, "queued");
  await f.step(TICK_MS, a);
  const view = remote(a, "claude", "other");
  assert.equal(view.status, "in-flight");
  assert.equal(view.refresh.status, "deferred");
  assert.deepEqual(f.calls.slice(2), [{ id: B, operation: "refresh", provider: "claude" }]);
});

test("an unavailable registry cannot dispatch or revoke; boot requires an actual durable invalidator", async () => {
  const f = fixture();
  let readCount = 0;
  f.registry = () => {
    readCount++;
    return reply("malformed registry");
  };
  const noWriter = f.copy({ invalidateEnrollment: undefined });
  await f.boot(noWriter);
  for (let i = 0; i < 10; i++) await f.step(TICK_MS, noWriter);
  assert.equal(readCount, 2);
  assert.equal(remote(noWriter).reason, "enrollments-unavailable");
  assert.deepEqual([f.calls, f.invalidations], [[], []]);
  noWriter.dispose();
  const active = f.copy();
  assert.equal(active.mount(), true);
  await f.step(5_000, active);
  assert.equal(remote(active).reason, "registry-unavailable");
  assert.deepEqual(f.invalidations, []);
});

test("numeric evidence is per-window, ages by observation and is withheld when identity is not verified", async () => {
  const f = fixture();
  const a = f.copy();
  await f.boot(a);
  f.advance(60_000);
  // Reestablish lease after a simulated suspension, then receive an identity-verified cached read.
  assert.equal(remote(a).status, "stale");
  const old = report(f.now() - 60);
  f.quota = () => reply({ ...old, status: "cached", readAt: f.now(), retryAt: f.now() + 300 });
  await f.step(240_000, a);
  const view = remote(a);
  assert.deepEqual(view.current.windows.map((w) => w.percent), [100]);
  assert.deepEqual(view.history.windows.map((w) => w.percent), [0]);
  assert.equal(view.history.observedAt, old.reading.observedAt);
  f.advance(900_000);
  assert.equal(remote(a).current, null);
  assert.deepEqual(remote(a).history.windows.map((w) => w.percent), [0, 100]);
  f.advance(14 * 86_400_000);
  assert.equal(remote(a).history, null);
  const g = fixture();
  g.quota = () => {
    const data = report(g.now());
    return reply({ ...data, status: "cached", reading: { ...data.reading, account: null } });
  };
  const b = g.copy();
  await g.boot(b);
  assert.equal(remote(b).reason, "malformed");
  assert.equal(remote(b).current, null);
});

test("local projection consumes existing native state without launching probes or leaking local diagnostics", async () => {
  const f = fixture();
  f.enrollment = [];
  const localWindow = { id: "session", short: "5h", long: "5-hour", percent: 100, durationSec: 18_000, resetsAt: T0 + 600 };
  f.shared.set("usage-limits.state", { claude: { report: { status: "ok", source: "claude CLI",
    windows: [localWindow], observedAt: T0, plan: "max", message: "don't publish" } },
  pi: { report: { status: "ok", spend: { week: 100 } } } });
  const a = f.copy();
  await f.boot(a);
  assert.deepEqual(a.snapshot().local.map((p) => [p.provider, p.status]), [["codex", "unavailable"], ["claude", "ready"]]);
  assert.deepEqual(a.snapshot().local[1].current.windows, [localWindow]);
  assert.equal(JSON.stringify(a.snapshot()).includes("don't publish"), false);
  assert.deepEqual(f.calls, []);
});
