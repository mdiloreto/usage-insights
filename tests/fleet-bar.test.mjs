import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

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
const { PROVIDERS } = await import(`${root}/providers/index.js`);
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
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["claude", "codex", "opencode", "pi"]);
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
