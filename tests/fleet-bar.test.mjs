import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseHostRecord } from "../scripts/quota/host.mjs";

const stubUrl = new URL("./helpers/gpui-stub.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "gpui-kit" || specifier === "gpui-base") return { url: stubUrl, shortCircuit: true };
    return next(specifier, context);
  },
});

const root = "../mods/usage-limits-fleet-canary";
const stub = await import(stubUrl);
const { coordinatorProjection } = await import(`${root}/fleet/coordinator-bridge.js`);
const { FLEET_PREFS_KEY, fleetAdapter, sharedFleetPrefs } = await import(`${root}/fleet/adapter.js`);
const { LOCAL_COLLAPSE_KEY } = await import(`${root}/fleet/model.js`);
const { VERSION } = await import(`${root}/fleet-quota/protocol.mjs`);
const { effectivePrefs } = await import(`${root}/lib/prefs.js`);
const { DENSITY } = await import(`${root}/lib/view.js`);
const { fleetBar } = await import(`${root}/fleet/model.js`);
const { ALL_PROVIDERS, PROVIDERS } = await import(`${root}/providers/index.js`);
const { default: agy } = await import(`${root}/providers/agy.js`);
const { NEVER_FETCHED, fetchedState } = await import(`${root}/lib/fetch-state.js`);
const { barModel } = await import(`${root}/lib/view.js`);
const { limitsPanel } = await import(`${root}/ui/panel.js`);
const { statusBar } = await import(`${root}/ui/bar.js`);
const { providerIcon } = await import(`${root}/ui/kit.js`);

const NOW = 1_800_000_000;
const MIN = 60;
const DAY = 86_400;
const win = (id, short, long, percent, resetsAt, durationSec) => ({ id, short, long, percent, resetsAt, durationSec });
const current = (source, observedAt, windows, plan = null) => ({ source, observedAt, plan, windows });
const item = (provider, fields) => ({ provider, status: "ready", reason: null, enrolled: true, refreshable: true,
  current: null, history: null, ...fields });

function linuxHost(overrides = {}) {
  return { route: "arch", label: "mateod-arch", registered: true, enrolled: true, state: "connected", providers: [
    item("claude", { current: current("host", NOW - 2 * MIN, [
      win("session", "5h", "5-hour", 4, NOW + 3600, 18000),
      win("weekly_all", "wk", "Weekly", 8, NOW + 3 * DAY, 604800),
      win("weekly_scoped:Fable", "Fable", "Weekly · Fable", 0, NOW + 3 * DAY, 604800),
    ], "max") }),
    item("codex", { current: current("cli", NOW - MIN, [win("codex:primary", "5h", "5-hour", 20, NOW + 3600, 18000)], "pro") }),
    item("copilot", { current: current("host", NOW - 5 * MIN, [win("monthly", "mo", "Monthly", 100, NOW + 10 * DAY, null)], "enterprise") }),
    item("agy", { status: "stale", reason: "stale", history: current("host", NOW - 15 * DAY, [
      win("session", "5h", "5-hour", 0, NOW - 14 * DAY, 18000),
      win("weekly_all", "wk", "Weekly", 0, NOW - 8 * DAY, 604800),
    ]) }),
  ], ...overrides };
}

const project = (...remotes) => coordinatorProjection({ version: VERSION, remotes }, NOW);

function harness(projection, saved = null) {
  const store = new Map(saved ? [[FLEET_PREFS_KEY, saved]] : []);
  const refreshed = [];
  const adapter = fleetAdapter({
    readProjection: () => projection,
    ...sharedFleetPrefs((key) => store.get(key), (key, value) => store.set(key, value)),
    refresh: (intent) => { refreshed.push(intent); return { status: "accepted" }; },
  });
  const model = (activeMachine = "arch") => adapter.model(projection, activeMachine, effectivePrefs(), { local: {}, now: NOW });
  return { adapter, store, refreshed, model };
}

const group = (host, id) => host.groups.find((g) => g.providerId === id);
const detail = (host, id) => host.panel.groups.find((g) => g.providerId === id);

test("a remote machine shows claude, codex, copilot and antigravity in that order", () => {
  const { model } = harness(project(linuxHost()));
  const { remotes } = model();
  const [arch] = remotes;
  assert.deepEqual(arch.groups.map((g) => g.providerId), ["claude", "codex", "copilot", "agy"]);
  assert.deepEqual(arch.panel.groups.map((g) => g.name), ["Claude", "Codex", "Copilot", "Antigravity"]);
  assert.deepEqual(group(arch, "claude").segments.map((s) => s.short), ["5h", "wk", "Fable"]);
  assert.match(group(arch, "copilot").segments[0].text, /^100%/, "a full Copilot allowance stays numeric");
  assert.equal(group(arch, "agy").mark, "—", "a provider with no current reading keeps the dash");
});

test("details name the source and age of every current reading, and keep stale readings dated", () => {
  const [arch] = harness(project(linuxHost())).model().remotes;
  assert.equal(detail(arch, "claude").source, "Omarchy collector · 2 min ago");
  assert.equal(detail(arch, "codex").source, "CLI · just now");
  assert.equal(detail(arch, "copilot").source, "Omarchy collector · 5 min ago");
  assert.equal(detail(arch, "agy").source, null, "history is not a current source");
  assert.equal(detail(arch, "agy").history, "Past reading (15 d ago): 5h 0% · wk 0%");
  assert.equal(detail(arch, "copilot").plan, "Enterprise");
  assert.equal(detail(arch, "copilot").rows[0].percent, "100%");
});

test("the Fable window comes from host readings and is offered only when reported", () => {
  const withFable = harness(project(linuxHost())).model().remotes[0];
  assert.equal(withFable.fable?.id, "weekly_scoped:Fable");
  const plain = linuxHost();
  plain.providers[0].current.windows.pop();
  assert.equal(harness(project(plain)).model().remotes[0].fable, undefined);
});

test("an unavailable machine shows dashes and the machine reason, never a reading", () => {
  const [arch] = harness(project(linuxHost({ state: "unreachable" }))).model().remotes;
  assert.ok(arch.groups.every((g) => g.mark === "—" && g.segments.length === 0));
  assert.equal(arch.machine.reason, "Machine offline");
});

test("copilot and antigravity appear only for machines that report them", () => {
  const old = linuxHost();
  old.providers = old.providers.slice(0, 2);
  const [arch] = harness(project(old)).model().remotes;
  assert.deepEqual(arch.groups.map((g) => g.providerId), ["claude", "codex"]);
});

test("with no remote machines the model is absent and the local provider list is unchanged", () => {
  const { model } = harness(project());
  assert.equal(model(), null);
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["claude", "codex", "agy", "opencode", "pi"]);
  assert.equal(new Set(ALL_PROVIDERS.map((p) => p.id)).size, ALL_PROVIDERS.length, "no provider is listed twice");
  const local = harness(project(linuxHost())).model(null).local;
  assert.deepEqual(local.groups.map((g) => g.providerId), ["claude", "codex"]);
});

test("copilot is drawn as a one-color glyph and antigravity as a full-color image", () => {
  assert.equal(providerIcon("copilot", "icons/copilot.svg", "#fff").__node.type, "svg");
  assert.equal(providerIcon("agy", "icons/antigravity.svg", "#fff").__node.type, "image");
  assert.equal(providerIcon("claude", "icons/claude.svg", "#fff").__node.type, "image");
});

test("collapsed machines persist per route, keep older records valid and survive other pref writes", () => {
  const older = { mode: "combined", selected: { route: "arch", label: "mateod-arch" } };
  const { adapter, store, model } = harness(project(linuxHost()), older);
  assert.deepEqual(model().remotes[0].collapsed, false);
  assert.deepEqual(adapter.dispatch({ type: "collapse", key: "arch" }), { status: "accepted" });
  assert.deepEqual(store.get(FLEET_PREFS_KEY).collapsed, ["arch"]);
  assert.equal(model().remotes[0].collapsed, true);
  adapter.dispatch({ type: "collapse", key: LOCAL_COLLAPSE_KEY });
  assert.equal(model().local.collapsed, true);
  adapter.dispatch({ type: "mode", mode: "follow" });
  assert.deepEqual(store.get(FLEET_PREFS_KEY), { ...older, mode: "follow", collapsed: ["arch", LOCAL_COLLAPSE_KEY] });
  adapter.dispatch({ type: "collapse", key: "arch" });
  assert.deepEqual(store.get(FLEET_PREFS_KEY).collapsed, [LOCAL_COLLAPSE_KEY]);
  assert.deepEqual(adapter.dispatch({ type: "collapse", key: "" }), { status: "rejected" });
});

test("a malformed collapsed list reads as all expanded", () => {
  const { model } = harness(project(linuxHost()), { mode: "follow", collapsed: "arch" });
  assert.equal(model().remotes[0].collapsed, false);
});

test("refresh covers all four providers and names them", () => {
  const { adapter, refreshed } = harness(project(linuxHost()));
  for (const provider of ["claude", "codex", "copilot", "agy"]) {
    assert.equal(adapter.dispatch({ type: "refresh", route: "arch", provider }).status, "accepted");
  }
  assert.deepEqual(refreshed.map((r) => r.provider), ["claude", "codex", "copilot", "agy"]);
  assert.equal(adapter.dispatch({ type: "refresh", route: "arch", provider: "gemini" }).status, "rejected");
});

function drawPanel(models, { remoteOutcome, onRemoteIntent = () => {} } = {}) {
  const panel = { t: stub.theme, act: {}, prefs: effectivePrefs(), hovered: null, now: NOW, remoteOutcome,
    onRemoteIntent, canRefreshLocal: () => false, refreshLocal() {} };
  return stub.nodeOf(limitsPanel(models.local.panel, null, panel, models));
}

test("expanded details list every provider with its refresh button, source and dated history", () => {
  const models = harness(project(linuxHost())).model();
  const text = stub.textOf(drawPanel(models));
  for (const line of ["mateod-arch", "Refresh mateod-arch · Copilot", "Refresh mateod-arch · Antigravity",
    "Omarchy collector · 2 min ago", "CLI · just now", "Past reading (15 d ago): 5h 0% · wk 0%", "Monthly", "Enterprise"]) {
    assert.ok(text.includes(line), `missing ${line}`);
  }
});

test("a collapsed machine keeps a one-line summary and drops its provider blocks", () => {
  const { adapter, model } = harness(project(linuxHost()));
  adapter.dispatch({ type: "collapse", key: "arch" });
  const intents = [];
  const tree = drawPanel(model(), { onRemoteIntent: (intent) => intents.push(intent) });
  const text = stub.textOf(tree);
  assert.ok(text.includes("mateod-arch"));
  assert.ok(!text.includes("Refresh mateod-arch"), "provider blocks are hidden");
  assert.ok(!text.includes("Omarchy collector"));
  const summary = stub.findAll(tree, (n) => typeof n.id === "string" && n.id.startsWith("ul-sum-arch-"));
  assert.deepEqual(summary.map((n) => n.id), ["ul-sum-arch-claude", "ul-sum-arch-codex", "ul-sum-arch-copilot", "ul-sum-arch-agy"]);
  assert.match(stub.textOf(stub.findById(tree, "ul-sum-arch-copilot")), /100%/);
  assert.match(stub.textOf(stub.findById(tree, "ul-sum-arch-agy")), /—/);
  assert.ok(stub.assets(stub.findById(tree, "ul-host-toggle-arch")).some((p) => p.endsWith("chevron-right.svg")));
  stub.findById(tree, "ul-host-toggle-arch").handlers.on_click({}, {});
  assert.deepEqual(intents, [{ type: "collapse", key: "arch" }]);
});

test("This Computer collapses too and still lists its compact quotas", () => {
  const { adapter, model } = harness(project(linuxHost()));
  adapter.dispatch({ type: "collapse", key: LOCAL_COLLAPSE_KEY });
  const tree = drawPanel(model());
  assert.ok(stub.assets(stub.findById(tree, `ul-host-toggle-${LOCAL_COLLAPSE_KEY}`)).some((p) => p.endsWith("chevron-right.svg")));
  assert.ok(stub.findById(tree, `ul-sum-${LOCAL_COLLAPSE_KEY}-claude`));
  assert.ok(!stub.findById(tree, "ul-local-refresh-claude"), "local blocks are hidden");
  assert.ok(stub.findById(tree, "ul-remote-refresh-arch-copilot"), "remote machines are unaffected");
});

test("the refresh outcome names the provider", () => {
  const remoteOutcome = { status: "accepted", route: "arch", label: "mateod-arch", provider: "agy" };
  const text = stub.textOf(drawPanel(harness(project(linuxHost())).model(), { remoteOutcome }));
  assert.ok(text.includes("mateod-arch · Antigravity: Refresh queued"));
});

test("Follow Space in a remote space shows the machine label and every provider's compact reading", () => {
  const models = harness(project(linuxHost())).model();
  const fleet = fleetBar(models, 1400, [], true);
  assert.equal(fleet.density, DENSITY.FULL);
  const bar = { fleet, detailsOpen: null, panel: null, border: false, onResize() {}, onHover() {}, toggleDetails() {} };
  const text = stub.textOf(stub.nodeOf(statusBar(bar, stub.theme)));
  assert.ok(text.includes("mateod-arch"));
  for (const name of ["Claude", "Codex", "Copilot", "Antigravity"]) assert.ok(text.includes(name), name);
  assert.match(text, /100%/);
});

test("the bar drops provider names, keeping icons and segments, before it falls back to labels only", () => {
  const models = harness(project(linuxHost())).model();
  const widths = [];
  for (let width = 100; width <= 1400; width += 2) {
    const fleet = fleetBar(models, width, [], true);
    widths.push([width, fleet.labels ? "labels" : fleet.named === false ? "icons" : fleet.groups[0].groups[0].segments.length > 1 ? "full" : "tight"]);
  }
  const stages = [...new Set(widths.map(([, stage]) => stage))];
  assert.deepEqual(stages, ["labels", "icons", "tight", "full"]);
  const [width] = widths.find(([, stage]) => stage === "icons");
  const fleet = fleetBar(models, width, [], true);
  assert.equal(fleet.density, DENSITY.NO_BARS);
  assert.deepEqual(fleet.groups[0].groups.map((g) => g.providerId), ["claude", "codex", "copilot", "agy"]);
  assert.ok(fleet.groups[0].groups.every((g) => g.segments.length <= 1));
  const bar = { fleet, detailsOpen: null, panel: null, border: false, onResize() {}, onHover() {}, toggleDetails() {} };
  const text = stub.textOf(stub.nodeOf(statusBar(bar, stub.theme)));
  assert.ok(text.includes("mateod-arch") && /100%/.test(text));
  for (const name of ["Claude", "Codex", "Copilot", "Antigravity"]) assert.ok(!text.includes(name), name);
});

const { createIdentity, cleanName, osFromUname } = await import(`${root}/fleet/identity.js`);

const barText = (fleet) => stub.textOf(stub.nodeOf(statusBar({ fleet, detailsOpen: null, panel: null, border: false,
  onResize() {}, onHover() {}, toggleDetails() {} }, stub.theme)));
const chipsFor = (local, remote) => ({ localOs: "Mac", localName: local, remoteOs: () => remote });
const combinedModel = (identity) => {
  const projection = project(linuxHost());
  const adapter = harness(projection, { mode: "combined", selected: { route: "arch", label: "mateod-arch" }, collapsed: [] }).adapter;
  return adapter.model(projection, null, effectivePrefs(), { local: {}, now: NOW }, identity);
};

test("each machine starts with an '<OS> · <name>' chip, local and remote", () => {
  const models = combinedModel(chipsFor("mateos-macbook-pro", "Linux"));
  assert.deepEqual(models.groups.map((h) => h.chip), ["Mac · mateos-macbook-pro", "Linux · mateod-arch"]);
  const text = barText(fleetBar(models, 1600, [], true));
  assert.ok(text.includes("Mac · mateos-macbook-pro") && text.includes("Linux · mateod-arch"));
  assert.ok(!text.includes("This Computer"));
  const panelText = stub.textOf(drawPanel(models));
  assert.ok(panelText.includes("Mac · mateos-macbook-pro") && panelText.includes("Linux · mateod-arch"));
});

test("chips fall back to the bare name, or 'This Computer', while the lookups are unknown", () => {
  const unknown = combinedModel({ localOs: "Mac", localName: null, remoteOs: () => null });
  assert.deepEqual(unknown.groups.map((h) => h.chip), ["This Computer", "mateod-arch"]);
  assert.deepEqual(combinedModel(undefined).groups.map((h) => h.chip), ["This Computer", "mateod-arch"]);
});

test("the chip is present at every density, including the labels-only fallback", () => {
  const models = combinedModel(chipsFor("mateos-macbook-pro", "Linux"));
  const stages = new Set();
  for (let width = 60; width <= 2400; width += 4) {
    const fleet = fleetBar(models, width, [], true);
    stages.add(fleet.labels ? "labels" : fleet.named === false ? "icons" : "wide");
    if (fleet.labels) assert.deepEqual(fleet.labels, ["Mac · mateos-macbook-pro", "Linux · mateod-arch"]);
    else assert.deepEqual(fleet.groups.map((h) => h.chip), ["Mac · mateos-macbook-pro", "Linux · mateod-arch"]);
    const text = fleet.labels ? fleet.labels.join(" ") : barText(fleet);
    assert.ok(text.includes("Mac · mateos-macbook-pro") && text.includes("Linux · mateod-arch"), `width ${width}`);
  }
  assert.ok(stages.has("labels") && stages.has("icons") && stages.has("wide"));
});

test("chip names are sanitised", () => {
  assert.equal(cleanName("  mac-mini \n"), "mac-mini");
  for (const bad of ["", "   ", "a@b", "bad\u0007name", "x".repeat(33), null, 5]) assert.equal(cleanName(bad), null, String(bad));
  for (const [platform, os] of [["darwin", "Mac"], ["macos", "Mac"], ["linux", "Linux"], ["win32", "Windows"], ["windows", "Windows"], ["plan9", null]]) {
    assert.equal(createIdentity({ exec: async () => null, platform }).snapshot().localOs, os, platform);
  }
  assert.equal(osFromUname("Darwin\n"), "Mac");
  assert.equal(osFromUname("Linux"), "Linux");
  assert.equal(osFromUname("MINGW64_NT-10.0"), "Windows");
  assert.equal(osFromUname("Plan9"), null);
});

test("OS and hostname lookups run once per machine and feed the next snapshot", async () => {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push([command, ...args, options.on ?? "local"]);
    if (command === "uname") return { code: 0, stdout: "Linux\n", stderr: "" };
    return { code: 0, stdout: "mateos-macbook-pro\n", stderr: "" };
  };
  const identity = createIdentity({ exec, platform: "darwin" });
  assert.deepEqual(calls, []);
  assert.equal(identity.snapshot().localOs, "Mac");
  assert.equal(identity.snapshot().localName, null);
  let changes = 0;
  identity.lookup(["arch"], () => { changes += 1; });
  identity.lookup(["arch"], () => { changes += 1; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  identity.lookup(["arch"], () => { changes += 1; });
  assert.deepEqual(calls.map((c) => c.join(" ")).sort(), ["scutil --get LocalHostName local", "uname -s arch"]);
  assert.equal(identity.snapshot().localName, "mateos-macbook-pro");
  assert.equal(identity.snapshot().remoteOs("arch"), "Linux");
  assert.equal(changes, 2);
  const fleet = fleetBar(combinedModel(identity.snapshot()), 1600, [], true);
  assert.deepEqual(fleet.groups.map((h) => h.chip), ["Mac · mateos-macbook-pro", "Linux · mateod-arch"]);
  assert.equal(calls.length, 2, "building and drawing the bar runs no commands");
});

test("failed lookups are not retried and leave the fallbacks", async () => {
  let calls = 0;
  const exec = async () => { calls += 1; throw new Error("unreachable"); };
  const identity = createIdentity({ exec, platform: "linux" });
  identity.lookup(["arch"], () => assert.fail("nothing learned"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  identity.lookup(["arch"], () => assert.fail("nothing learned"));
  assert.equal(calls, 2);
  assert.deepEqual([identity.snapshot().localName, identity.snapshot().remoteOs("arch")], [null, null]);
});

test("local lookups send no 'on' key, and the local name still resolves", async () => {
  const exec = async (command, args, options) => {
    if ("on" in options) throw new Error(`unexpected on key for ${command}`);
    return { code: 0, stdout: "Mateos-MacBook-Pro\n", stderr: "" };
  };
  const identity = createIdentity({ exec, platform: "darwin" });
  identity.lookup([], () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(identity.snapshot().localName, "Mateos-MacBook-Pro");
});

test("on macos the local name comes from scutil first", async () => {
  const calls = [];
  const exec = async (command) => {
    calls.push(command);
    return { code: 0, stdout: command === "scutil" ? "Mateos-MacBook-Pro\n" : "other\n", stderr: "" };
  };
  const identity = createIdentity({ exec, platform: "macos" });
  identity.lookup([], () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ["scutil"]);
  assert.equal(identity.snapshot().localName, "Mateos-MacBook-Pro");
  assert.equal(identity.snapshot().localOs, "Mac");
});

const fixture = (name) => readFile(new URL(`./fixtures/omarchy/${name}.json`, import.meta.url), "utf8");
const agyText = await fixture("agy");
const agyRecord = JSON.parse(agyText);
const fetchedAt = Math.floor(agyRecord.limitsFetchedAt / 1000);
const edited = (change) => JSON.stringify({ ...agyRecord, ...change });
const limit = (label, percent = 0, resetsAt = "") => ({ label, percent, resetsAt });
const iso = (seconds) => new Date(seconds * 1000).toISOString();

function assertNoReading(report, why) {
  assert.ok(["error", "unavailable"].includes(report.status), why);
  assert.ok(!report.fallback, `${why}: no fallback`);
  assert.deepEqual(report.windows, [], why);
  assert.ok(typeof report.message === "string" && report.message.length > 0, `${why}: message`);
}

test("the local Antigravity parser reads a fresh Omarchy record", () => {
  assert.equal(agy.helper, "helpers/agy-record.sh");
  assert.equal(agy.optional, true);
  assert.deepEqual(agy.parse(agyText, fetchedAt + 5), { status: "ok", message: null, plan: "pro", observedAt: fetchedAt,
    source: "Omarchy collector", windows: [
      win("session", "5h", "5-hour", 0, null, 18000),
      win("weekly_all", "wk", "Weekly", 0, null, 604800),
    ] });
});

test("the local and remote Antigravity parsers agree on windows, percent, reset, time and plan", async () => {
  const oldText = await fixture("agy-old");
  const percents = [0, 0.004, 0.29, 0.57, 0.999, 1];
  const cases = [
    ["fixture", agyText, 5],
    ["old fixture", oldText, 5 * DAY],
    ...percents.map((p) => [`percent ${p}`, edited({ limits: [limit("Session", p), limit("Weekly", p)] }), 5]),
    ["reset times", edited({ limits: [limit("Session", 0.4, "2026-12-01T10:00:00+02:00"),
      limit("Weekly", 0.2, "2026-12-03T10:00:00.5Z")] }), 5],
    ["title only", edited({ limits: [{ title: "Session", percent: 0.1, resetsAt: "" },
      { label: "other", title: "Weekly", percent: 0.2, resetsAt: "" }] }), 5],
    ["other labels dropped", edited({ limits: [limit("Monthly allowance", 0.9), limit("Opus Weekly", 0.9),
      limit("Daily", 0.9), limit("Weekly (7-day)", 0.3)] }), 5],
    ["empty accounts", edited({ accounts: [] }), 5],
    ...["Free", " ULTRA ", "pro", "Pro 5x", "ultra 20x", "Enterprise", "", 7, undefined]
      .map((tierLabel) => [`tier ${tierLabel}`, edited({ tierLabel }), 5]),
  ];
  for (const [name, text, age] of cases) {
    const now = Math.floor(JSON.parse(text).limitsFetchedAt / 1000) + age;
    const remote = parseHostRecord("agy", text, now);
    assert.equal(remote.status, "ok", name);
    const report = agy.parse(text, now);
    assert.equal(report.status === "ok", remote.current, `${name}: current`);
    const reading = remote.current ? report : report.fallback;
    assert.equal(reading.status, "ok", name);
    assert.equal(reading.source, "Omarchy collector", name);
    assert.deepEqual(reading.windows, remote.reading.windows, name);
    assert.equal(reading.observedAt, remote.reading.observedAt, name);
    assert.equal(reading.plan, remote.reading.plan, name);
  }
});

test("a not-current Antigravity record is a failed report with a dated fallback", () => {
  assert.equal(agy.parse(agyText, fetchedAt + 899).status, "ok");
  const cases = [
    ["limitsStale", edited({ limitsStale: true }), 5],
    ["not ready", edited({ ready: false }), 5],
    ["900 s old", agyText, 900],
    ["just under 14 days", agyText, 14 * DAY - 1],
    ["every window reset", edited({ limits: [limit("Session", 0.5, iso(fetchedAt - 1)),
      limit("Weekly", 0.5, iso(fetchedAt + 5))] }), 5],
  ];
  for (const [name, text, age] of cases) {
    const report = agy.parse(text, fetchedAt + age);
    assert.equal(report.status, "error", name);
    assert.equal(report.source, "Omarchy collector", name);
    assert.ok(typeof report.message === "string" && report.message.length > 0, `${name}: message`);
    assert.deepEqual(report.windows, [], name);
    assert.equal(report.fallback?.status, "ok", name);
    assert.equal(report.fallback.source, "Omarchy collector", name);
    assert.equal(report.fallback.observedAt, fetchedAt, name);
    assert.equal(report.fallback.windows.length, 2, name);
  }
});

test("an unusable Antigravity record gives no reading, never throws and never echoes the record", () => {
  const marker = "record-text-marker";
  const one = (entry) => edited({ limits: [{ ...limit("Session"), ...entry }] });
  const cases = [
    ["empty input", ""],
    ["broken JSON", `{"id":"agy","name":"${marker}"`],
    ["null", "null"],
    ["array", "[]"],
    ["text", JSON.stringify(marker)],
    ["wrong schemaVersion", edited({ schemaVersion: 2, name: marker })],
    ["wrong id", edited({ id: marker })],
    ["ready not boolean", edited({ ready: marker })],
    ["limitsStale not boolean", edited({ limitsStale: marker })],
    ["non-empty accounts", edited({ accounts: [{ name: marker }] })],
    ["accounts not a list", edited({ accounts: marker })],
    ["limits not a list", edited({ limits: marker })],
    ["limit not an object", edited({ limits: [null] })],
    ["no limits", edited({ limits: [] })],
    ["only other labels", edited({ limits: [limit(marker)] })],
    ["duplicate window", edited({ limits: [limit("Session"), limit("Session (5-hour)")] })],
    ["percent above 1", one({ percent: 1.01 })],
    ["percent below 0", one({ percent: -0.01 })],
    ["percent not a number", one({ percent: marker })],
    ["percent missing", one({ percent: undefined })],
    ["reset not a date", one({ resetsAt: marker })],
    ["reset not ISO", one({ resetsAt: "Dec 1 2026 10:00" })],
    ["reset missing", one({ resetsAt: undefined })],
    ["fetch time missing", edited({ limitsFetchedAt: undefined })],
    ["fetch time zero", edited({ limitsFetchedAt: 0 })],
    ["fetch time not a number", edited({ limitsFetchedAt: marker })],
    ["fetch time in the future", agyText, -1],
    ["14 days old", agyText, 14 * DAY],
  ];
  for (const [name, text, age = 5] of cases) {
    const report = agy.parse(text, fetchedAt + age);
    assertNoReading(report, name);
    assert.ok(!JSON.stringify(report).includes(marker), `${name}: record text in the report`);
  }
});

const helper = fileURLToPath(new URL(`${root}/helpers/agy-record.sh`, import.meta.url));

async function helperSandbox(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-record-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const xdg = path.join(dir, "state");
  const recordIn = (state) => path.join(state, "omarchy", "agents", "usage", "agy.json");
  const write = async (state, text) => {
    await mkdir(path.dirname(recordIn(state)), { recursive: true });
    await writeFile(recordIn(state), text);
  };
  // The environment is built from scratch so the real home is never read.
  const run = (env = { XDG_STATE_HOME: xdg }) => spawnSync("sh", [helper],
    { cwd: dir, env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: "utf8", timeout: 10_000 });
  const homeState = path.join(home, ".local", "state");
  return { dir, xdg, homeState, recordIn, write, run };
}

test("the Antigravity helper prints the record from XDG_STATE_HOME", async (t) => {
  const { xdg, homeState, write, run } = await helperSandbox(t);
  await write(xdg, agyText);
  await write(homeState, "home record\n");
  const got = run();
  assert.equal(got.status, 0, got.stderr);
  assert.equal(got.stdout, agyText);
});

test("the Antigravity helper falls back to $HOME/.local/state", async (t) => {
  const { homeState, write, run } = await helperSandbox(t);
  await write(homeState, agyText);
  for (const env of [{}, { XDG_STATE_HOME: "" }]) {
    const got = run(env);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(got.stdout, agyText);
  }
});

test("the Antigravity helper prints at most 65536 bytes", async (t) => {
  const { xdg, write, run } = await helperSandbox(t);
  await write(xdg, "x".repeat(70_000));
  const got = run();
  assert.equal(got.status, 0, got.stderr);
  assert.equal(got.stdout, "x".repeat(65_536));
});

test("the Antigravity helper exits 127 for a missing file, a symlink or a directory", async (t) => {
  const { dir, xdg, recordIn, write, run } = await helperSandbox(t);
  // A missing script also exits 127, so first show that this one runs.
  await write(xdg, agyText);
  assert.equal(run().status, 0, "a present record is read");
  const refused = (why) => {
    const got = run();
    assert.deepEqual([got.status, got.stdout], [127, ""], why);
  };
  await rm(recordIn(xdg));
  refused("missing file");
  const target = path.join(dir, "target.json");
  await writeFile(target, agyText);
  await symlink(target, recordIn(xdg));
  refused("symlink");
  await rm(recordIn(xdg));
  await mkdir(recordIn(xdg));
  refused("directory");
});

const localRecord = (change = {}) => edited({ limitsFetchedAt: (NOW - MIN) * 1000, limits: [
  limit("Session (5-hour)", 0.4, iso(NOW + 3600)), limit("Weekly (7-day)", 0.25, iso(NOW + 3 * DAY)),
], ...change });
const answered = (stdout, code = 0) => ({ agy: fetchedState(NEVER_FETCHED, agy, { code, stdout }, NOW) });
const NOT_INSTALLED = 127;

function localHost(local) {
  const projection = project(linuxHost());
  return harness(projection).adapter.model(projection, null, effectivePrefs(), { local, now: NOW });
}

test("a local Antigravity record shows in the bar and in this computer's fleet segment", () => {
  const local = answered(localRecord());
  const bar = group(barModel(local, effectivePrefs(), NOW), "agy");
  assert.ok(bar, "agy is in the local bar");
  assert.equal(bar.mark, null);
  assert.equal(bar.dim, false);
  assert.deepEqual(bar.segments.map((s) => [s.short, s.text]), [["5h", "40%"], ["wk", "25%"]]);
  const models = localHost(local);
  assert.deepEqual(models.local.groups.map((g) => g.providerId), ["claude", "codex", "agy"]);
  assert.deepEqual(group(models.local, "agy").segments.map((s) => s.short), ["5h", "wk"]);
  assert.equal(detail(models.local, "agy").source, "Omarchy collector");
  assert.equal(detail(models.local, "agy").plan, "Pro");
  assert.ok(stub.findById(drawPanel(models), "ul-local-refresh-agy"));
});

test("a stale local Antigravity record is marked failed and keeps its dimmed last values", () => {
  const local = answered(localRecord({ limitsStale: true }));
  const bar = group(barModel(local, effectivePrefs(), NOW), "agy");
  assert.ok(bar, "agy is in the local bar");
  assert.equal(bar.mark, "!");
  assert.equal(bar.dim, true);
  assert.deepEqual(bar.segments.map((s) => [s.short, s.text]), [["5h", "40%"], ["wk", "25%"]]);
  assert.ok(group(localHost(local).local, "agy"), "a stale record still counts as installed");
});

test("this computer's fleet segment omits Antigravity until a record is found", () => {
  assert.ok(group(localHost(answered(localRecord())).local, "agy"), "a record is shown");
  const missing = answered("", NOT_INSTALLED);
  assert.equal(group(barModel(missing, effectivePrefs(), NOW), "agy"), undefined, "no record, no bar group");
  for (const [name, local] of [["no record", missing], ["not answered yet", {}], ["never fetched", { agy: NEVER_FETCHED }]]) {
    const models = localHost(local);
    assert.equal(group(models.local, "agy"), undefined, `${name}: compact`);
    assert.equal(group({ groups: models.local.summary }, "agy"), undefined, `${name}: summary`);
    assert.equal(detail(models.local, "agy"), undefined, `${name}: details`);
    const tree = drawPanel(models);
    assert.ok(!stub.findById(tree, "ul-local-refresh-agy"), `${name}: panel`);
    assert.ok(stub.findById(tree, "ul-local-refresh-claude"), `${name}: other local providers stay`);
    assert.ok(stub.findById(tree, "ul-remote-refresh-arch-agy"), `${name}: the remote machine keeps it`);
  }
});

const agyWindows = (percent) => [win("session", "5h", "5-hour", percent, NOW + 3600, 18000),
  win("weekly_all", "wk", "Weekly", percent, NOW + 3 * DAY, 604800)];
const liveAgy = (age, percent = 10) => item("agy", { current: current("host", NOW - age, agyWindows(percent)) });
const datedAgy = (age) => item("agy", { status: "stale", reason: "stale", history: current("host", NOW - age, agyWindows(5)) });
const unreadAgy = item("agy", { status: "failed", reason: "failed" });
const machine = (route, agyItem) => linuxHost({ route, label: route,
  providers: [linuxHost().providers[0], ...(agyItem ? [agyItem] : [])] });
const localAgy = (age, change = {}) => answered(localRecord({ limitsFetchedAt: (NOW - age) * 1000, ...change }));
const datedLocalAgy = (age) => localAgy(age, { limitsStale: true });
const noLocalAgy = () => answered("", NOT_INSTALLED);

function barFleet(remotes, { local = {}, focused = null, mode = "follow", selected, prefs = effectivePrefs() } = {}) {
  const projection = project(...remotes);
  const saved = { mode, selected: selected ? { route: selected, label: selected } : null, collapsed: [] };
  return harness(projection, saved).adapter.model(projection, focused, prefs, { local, now: NOW }, chipsFor("laptop", "Linux"));
}

const onBar = (models) => models.groups.map((h) => [h.chip ?? h.label, h.groups.map((g) => g.providerId)]);
const lent = (models) => models.groups.at(-1);
const MAC = "Mac · laptop";

test("Follow Space in a local space lends a remote machine's current Antigravity reading", () => {
  const models = barFleet([machine("arch", liveAgy(MIN, 30))], { local: noLocalAgy() });
  assert.deepEqual(onBar(models), [[MAC, ["claude", "codex"]], ["Linux · arch", ["agy"]]]);
  assert.deepEqual(lent(models).groups[0].segments.map((s) => [s.short, s.text]), [["5h", "30%"], ["wk", "30%"]]);
  assert.deepEqual(models.local.groups.map((g) => g.providerId), ["claude", "codex"]);
  assert.deepEqual(models.remotes[0].groups.map((g) => g.providerId), ["claude", "codex", "agy"]);
  const text = barText(fleetBar(models, 2400, [], true));
  assert.ok(text.includes("Linux · arch") && text.includes("Antigravity") && text.includes("30%"));
});

test("Follow Space in a remote space lends this computer's reading and leaves the details alone", () => {
  const models = barFleet([machine("arch", datedAgy(DAY))], { local: localAgy(MIN), focused: "arch" });
  assert.deepEqual(onBar(models), [["Linux · arch", ["claude", "codex"]], [MAC, ["agy"]]]);
  assert.deepEqual(lent(models).groups[0].segments.map((s) => s.text), ["40%", "25%"]);
  assert.deepEqual(models.local.groups.map((g) => g.providerId), ["claude", "codex", "agy"]);
  assert.deepEqual(models.remotes[0].groups.map((g) => g.providerId), ["claude", "codex", "agy"]);
  assert.ok(detail(models.local, "agy") && detail(models.remotes[0], "agy"));
});

test("nothing is lent while a machine on the bar has a current Antigravity reading", () => {
  const remotes = [machine("arch", liveAgy(MIN)), machine("studio", liveAgy(5))];
  const without = barFleet(remotes, { local: noLocalAgy() });
  assert.deepEqual(lent(without).groups.map((g) => g.providerId), ["agy"], "a bar without a reading borrows one");
  const local = barFleet(remotes, { local: localAgy(10 * MIN) });
  assert.deepEqual(local.groups, [local.local], "an older reading on the bar still wins");
  const focused = barFleet(remotes, { local: localAgy(0), focused: "arch" });
  assert.deepEqual(focused.groups, [focused.remotes[0]]);
  const combined = barFleet(remotes, { local: noLocalAgy(), mode: "combined", selected: "arch" });
  assert.deepEqual(combined.groups, [combined.local, combined.remotes[0]]);
});

test("the freshest current reading is lent, ahead of any newer dated one", () => {
  const shown = machine("arch");
  const pick = (remotes, local) => barFleet([shown, ...remotes], { local, focused: "arch" });
  const three = [machine("studio", liveAgy(10 * MIN, 11)), machine("mini", liveAgy(30, 22))];
  assert.deepEqual(onBar(pick(three, localAgy(5 * MIN))), [["Linux · arch", ["claude", "codex"]], ["Linux · mini", ["agy"]]]);
  assert.equal(lent(pick(three, localAgy(10))).chip, MAC);
  const mixed = [machine("studio", liveAgy(10 * MIN)), machine("mini", datedAgy(5))];
  assert.equal(lent(pick(mixed, datedLocalAgy(1))).chip, "Linux · studio");
});

test("a dated Antigravity reading is lent only when no machine on the bar holds one", () => {
  const remotes = [machine("arch", datedAgy(15 * DAY)), machine("studio", datedAgy(DAY))];
  const borrowed = barFleet(remotes, { local: noLocalAgy() });
  assert.deepEqual(onBar(borrowed), [[MAC, ["claude", "codex"]], ["Linux · studio", ["agy"]]]);
  assert.deepEqual([lent(borrowed).groups[0].mark, lent(borrowed).groups[0].segments], ["—", []]);
  const heldHere = barFleet(remotes, { local: datedLocalAgy(10 * DAY) });
  assert.deepEqual(heldHere.groups, [heldHere.local]);
  const heldThere = barFleet(remotes, { local: datedLocalAgy(MIN), focused: "arch" });
  assert.deepEqual(heldThere.groups, [heldThere.remotes[0]]);
  const fromHere = barFleet([machine("arch")], { local: datedLocalAgy(MIN), focused: "arch" });
  assert.deepEqual(onBar(fromHere), [["Linux · arch", ["claude", "codex"]], [MAC, ["agy"]]]);
  assert.equal(lent(fromHere).groups[0].mark, "—");
});

test("a machine that never had an Antigravity reading neither lends one nor keeps one off the bar", () => {
  const neverRead = answered("{}");
  const borrowed = barFleet([machine("arch", datedAgy(DAY))], { local: neverRead });
  assert.deepEqual(onBar(borrowed), [[MAC, ["claude", "codex"]], ["Linux · arch", ["agy"]]]);
  const nothing = barFleet([machine("arch", unreadAgy)], { local: neverRead });
  assert.deepEqual(nothing.groups, [nothing.local]);
  assert.equal(group(nothing.local, "agy").mark, "—");
});

test("Local + Remote lends Antigravity from a machine that is not on the bar", () => {
  const remotes = [machine("arch", datedAgy(DAY)), machine("studio", liveAgy(MIN))];
  const picked = barFleet(remotes, { local: noLocalAgy(), mode: "combined", selected: "arch" });
  assert.deepEqual(onBar(picked), [[MAC, ["claude", "codex"]], ["Linux · arch", ["claude", "codex"]], ["Linux · studio", ["agy"]]]);
  const unpicked = barFleet(remotes, { local: noLocalAgy(), mode: "combined" });
  assert.deepEqual(onBar(unpicked), [[MAC, ["claude", "codex"]], ["Choose remote", []], ["Linux · studio", ["agy"]]]);
});

test("a hidden Antigravity is neither lent nor removed", () => {
  const remotes = [machine("arch", datedAgy(DAY)), machine("studio", liveAgy(MIN))];
  const options = { local: noLocalAgy(), focused: "arch" };
  assert.equal(lent(barFleet(remotes, options)).chip, "Linux · studio", "shown Antigravity is lent");
  const hidden = barFleet(remotes, { ...options, prefs: effectivePrefs({ hidden: ["agy"] }) });
  assert.deepEqual(hidden.groups, [hidden.remotes[0]]);
  assert.deepEqual(onBar(hidden), [["Linux · arch", ["claude", "codex", "agy"]]]);
});

test("session numbers follow this computer's own segment, never a lent entry", () => {
  const numbers = [{ level: "ok", text: "ctx 12%" }];
  const trimmed = barFleet([machine("arch"), machine("studio", liveAgy(MIN))],
    { local: datedLocalAgy(DAY), mode: "combined", selected: "arch" });
  assert.deepEqual(onBar(trimmed), [[MAC, ["claude", "codex"]], ["Linux · arch", ["claude", "codex"]], ["Linux · studio", ["agy"]]]);
  const borrowed = barFleet([machine("arch")], { local: localAgy(MIN), focused: "arch" });
  assert.equal(lent(borrowed).chip, MAC);
  for (const width of [2400, 600]) {
    assert.deepEqual(fleetBar(trimmed, width, numbers, true).numbers, numbers, `own segment at ${width}`);
    assert.deepEqual(fleetBar(borrowed, width, numbers, true).numbers, [], `lent only at ${width}`);
  }
  assert.ok(barText(fleetBar(trimmed, 2400, numbers, true)).includes("ctx 12%"));
});

test("a lent entry keeps its machine chip at every width, including the labels-only fallback", () => {
  const models = barFleet([machine("arch"), machine("studio", liveAgy(MIN))], { local: noLocalAgy(), focused: "arch" });
  const stages = new Set();
  for (let width = 60; width <= 1600; width += 4) {
    const fleet = fleetBar(models, width, [], true);
    stages.add(fleet.labels ? "labels" : "groups");
    if (fleet.labels) assert.deepEqual(fleet.labels, ["Linux · arch", "Linux · studio"], `width ${width}`);
    else assert.ok(barText(fleet).includes("Linux · studio") && barText(fleet).includes("10%"), `width ${width}`);
  }
  assert.deepEqual([...stages].sort(), ["groups", "labels"]);
});
