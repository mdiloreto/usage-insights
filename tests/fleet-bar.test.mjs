import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stubUrl = new URL("./helpers/gpui-stub.mjs", import.meta.url).href;
const herdrUrl = `data:text/javascript,${encodeURIComponent(`const store = new Map();
export const shared = (key) => store.get(key);
export const setShared = (key, value) => store.set(key, value);`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "gpui-kit" || specifier === "gpui-base") return { url: stubUrl, shortCircuit: true };
    if (specifier === "herdr") return { url: herdrUrl, shortCircuit: true };
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
const { DENSITY, barModel: buildBarModel, groupWidth, segmentView } = await import(`${root}/lib/view.js`);
const { fleetBar } = await import(`${root}/fleet/model.js`);
const { PROVIDERS } = await import(`${root}/providers/index.js`);
const { limitsPanel } = await import(`${root}/ui/panel.js`);
const { statusBar } = await import(`${root}/ui/bar.js`);
const { providerIcon } = await import(`${root}/ui/kit.js`);
const { settingsPanel } = await import(`${root}/ui/settings.js`);
const { KEY_PREFS, viewActions } = await import(`${root}/actions.js`);
const { shared } = await import("herdr");
const { createIdentity, cleanName, osFromUname } = await import(`${root}/fleet/identity.js`);

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
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["claude", "codex", "opencode-go", "opencode", "pi"]);
  const local = harness(project(linuxHost())).model(null).local;
  assert.deepEqual(local.groups.map((g) => g.providerId), ["claude", "codex", "opencode-go"]);
});

const called = (node, method) => node.calls.find(([name]) => name === method)?.[1];
const mutedTexts = (tree) => stub.findAll(tree, (n) => called(n, "text_color")?.[0] === "muted").map(stub.textOf);

test("each known provider has a Herdr App icon, tinted only when it is one color", () => {
  for (const [id, type, path] of [["claude", "image", "claude"], ["codex", "image", "codex"], ["copilot", "svg", "copilot"],
    ["agy", "image", "antigravity"], ["opencode", "svg", "opencode"], ["pi", "svg", "pi"]]) {
    const node = stub.nodeOf(providerIcon(id, "Any name", "#fff"));
    assert.equal(node.type, type, id);
    assert.deepEqual(called(node, "asset"), [`icons/${path}.svg`], id);
    assert.deepEqual(called(node, "size"), [14], id);
    assert.deepEqual(called(node, "text_color"), type === "svg" ? ["#fff"] : undefined, id);
  }
});

test("an unknown provider gets a boxed monogram of its initials", () => {
  for (const [id, name, text] of [["made-up", "Made Up", "MU"], ["made-up", undefined, "MU"],
    ["gemini", "Gemini", "G"], ["a_b_c", "", "AB"], ["constructor", undefined, "C"]]) {
    const node = stub.nodeOf(providerIcon(id, name, "#fff"));
    assert.equal(stub.textOf(node), text, id);
    assert.deepEqual(stub.assets(node), [], id);
    for (const [method, value] of [["h", 14], ["min_w", 14], ["border", 1], ["border_color", "#fff"], ["text_color", "#fff"]]) {
      assert.deepEqual(called(node, method), [value], `${id} ${method}`);
    }
  }
});

test("OpenCode Go is the OpenCode glyph with a tag, so it differs from OpenCode", () => {
  const plain = stub.nodeOf(providerIcon("opencode", "OpenCode", "#fff"));
  const go = stub.nodeOf(providerIcon("opencode-go", "OpenCode Go", "#fff"));
  assert.equal(stub.textOf(plain).trim(), "");
  assert.equal(stub.textOf(go).trim(), "Go");
  const [glyph, tag] = go.kids;
  assert.equal(glyph.type, "svg");
  assert.deepEqual(stub.assets(go), stub.assets(plain));
  assert.deepEqual(called(glyph, "text_color"), ["#fff"]);
  assert.deepEqual(called(tag, "text_color"), ["#fff"]);
  assert.ok(called(go, "gap")[0] <= 2);
});

const goWindows = [win("session", "5h", "5-hour", 4, NOW + 3600, 18000), win("weekly", "wk", "Weekly", 100, NOW + 3 * DAY, 604800),
  win("monthly", "mo", "Monthly", 8, NOW + 10 * DAY, null)];
const barGroup = (providerId, name, windows) => ({ providerId, name, mark: null, dim: false,
  segments: windows.map((w) => segmentView(w, NOW)) });

test("a frame with the OpenCode Go tag is estimated wider than the same one without it", () => {
  const go = barGroup("opencode-go", "OpenCode Go", goWindows);
  for (const density of Object.values(DENSITY)) {
    assert.ok(groupWidth(go, density) > groupWidth({ ...go, providerId: "opencode" }, density), `density ${density}`);
  }
});

test("a second machine holding one provider keeps its chip right before it at every width", () => {
  const remote = linuxHost();
  remote.providers[3] = item("agy", { current: current("host", NOW - MIN, goWindows.slice(0, 2)) });
  const [arch] = harness(project(remote)).model().remotes;
  const first = { ...arch, chip: "Mac · mini", groups: arch.groups.filter((g) => g.providerId !== "agy") };
  const second = { ...arch, chip: "Linux · mateod-arch", groups: [group(arch, "agy")] };
  const stages = new Set();
  for (let width = 60; width <= 1600; width += 4) {
    const fleet = fleetBar({ groups: [first, second] }, width, [], true);
    const tree = drawBar({ fleet });
    if (fleet.labels) {
      stages.add("labels");
      assert.deepEqual(fleet.labels, [first.chip, second.chip]);
      assert.equal(framesOf(tree, "ul-fleet-provider-").length, 0);
      continue;
    }
    stages.add(`${fleet.density}-${fleet.groups[0].groups[0].segments.length}`);
    const [, separator, machine] = stub.findById(tree, "ul-content").kids;
    assert.deepEqual([called(separator, "w"), called(separator, "h")], [[1], [14]], `width ${width}`);
    assert.equal(machine.id, "ul-machine-1");
    const [chip, frame, ...rest] = machine.kids;
    assert.equal(stub.textOf(chip), second.chip, `width ${width}`);
    assert.equal(called(chip, "border"), undefined, "a machine label is not framed like a provider");
    assert.equal(frame.id, "ul-fleet-provider-1-agy");
    assert.equal(rest.length, 0);
    assert.match(stub.textOf(frame), /\d+%/);
  }
  assert.equal(stages.size, 4);
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

function drawPanel(models, { remoteOutcome, onRemoteIntent = () => {}, prefs = effectivePrefs(), t = stub.theme } = {}) {
  const panel = { t, act: {}, prefs, hovered: null, now: NOW, remoteOutcome,
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

test("every collapsed summary labels its window, however long the row", () => {
  const remote = linuxHost();
  remote.providers[3] = item("agy", { current: current("host", NOW - MIN, goWindows.slice(0, 2)) });
  const { adapter, model } = harness(project(remote));
  adapter.dispatch({ type: "collapse", key: "arch" });
  const tree = drawPanel(model());
  for (const [id, short] of [["claude", "wk"], ["codex", "5h"], ["copilot", "mo"], ["agy", "wk"]]) {
    const frame = stub.findById(tree, `ul-sum-arch-${id}`);
    assert.ok(stub.findAll(frame, (n) => n.texts.includes(short)).length, `${id} ${short}`);
  }
});

test("a one-machine bar keeps its numbers down to the width its estimate needs", () => {
  // Only Claude here and no Antigravity anywhere, so exactly one group can reach the bar.
  const states = { ...localStates, codex: { installed: false }, "opencode-go": { installed: false } };
  const remote = linuxHost();
  remote.providers = remote.providers.slice(0, 2);
  const models = harness(project(remote)).adapter.model(project(remote), null, effectivePrefs(), { local: states, now: NOW });
  assert.deepEqual(models.groups.map((h) => [h.chip, h.groups.map((g) => g.providerId)]), [["This Computer", ["claude"]]]);
  // Chip 106, frame 36, label 21 and number 22, beside the bar's padding and details button (52).
  const width = 106 + 36 + 21 + 22 + 52;
  const fleet = fleetBar(models, width, [], true);
  assert.equal(fleet.labels, undefined);
  assert.match(barText(fleet), /5h 4%/);
  assert.deepEqual(fleetBar(models, width - 1, [], true).labels, ["This Computer"]);
});

test("eight providers on two machines still show numbers at 1152px", () => {
  const spend = (today) => ({ report: { status: "ok", observedAt: NOW, windows: [], spend: { today, week: 2 * today } } });
  const limits = (...windows) => ({ report: { status: "ok", observedAt: NOW, windows } });
  const local = { claude: limits(win("weekly_all", "wk", "Weekly", 82, NOW + 3 * DAY, 604800)),
    codex: limits(win("codex:primary", "5h", "5-hour", 20, NOW + 3600, 18000)), opencode: spend(1_200_000), pi: spend(48_000),
    "opencode-go": { installed: false } };
  const remote = linuxHost({ label: "t87" });
  remote.providers[3] = item("agy", { current: current("host", NOW - MIN, goWindows.slice(0, 1)) });
  const projection = project(remote);
  const prefs = effectivePrefs({ spendOnBar: { opencode: true, pi: true } });
  const { adapter } = harness(projection, { mode: "combined", selected: { route: "arch", label: "t87" }, collapsed: [] });
  const models = adapter.model(projection, null, prefs, { local, now: NOW }, chipsFor("mbp", "Linux"));
  assert.deepEqual(models.groups.map((h) => [h.chip, h.groups.length]), [["Mac · mbp", 4], ["Linux · t87", 4]]);
  const fleet = fleetBar(models, 1152, [], true);
  assert.equal(fleet.labels, undefined);
  const text = barText(fleet);
  for (const number of ["82% · 3d 0h", "20%", "1.2M", "48k", "100% · 10d 0h", "4%"]) assert.ok(text.includes(number), number);
});

test("the refresh outcome names the provider", () => {
  const remoteOutcome = { status: "accepted", route: "arch", label: "mateod-arch", provider: "agy" };
  const text = stub.textOf(drawPanel(harness(project(linuxHost())).model(), { remoteOutcome }));
  assert.ok(text.includes("mateod-arch · Antigravity: Refresh queued"));
});

test("Follow Space in a remote space shows the machine label and every provider's reading", () => {
  const models = harness(project(linuxHost())).model();
  const fleet = fleetBar(models, 1400, [], true);
  assert.equal(fleet.density, DENSITY.FULL);
  const text = stub.textOf(drawBar({ fleet }));
  assert.ok(text.includes("mateod-arch"));
  assert.match(text, /100%/);
});

const NAMES = ["Claude", "Codex", "Copilot", "Antigravity"];
// Theme colors read as their own names, so a test can tell them apart.
const namedTheme = new Proxy({}, { get: (_target, key) => key });
const drawBar = (fields) => stub.nodeOf(statusBar({ detailsOpen: null, panel: null, border: false, onResize() {}, onHover() {},
  toggleDetails() {}, ...fields }, namedTheme));
const framesOf = (tree, prefix) => stub.findAll(tree, (n) => typeof n.id === "string" && n.id.startsWith(prefix));
const localStates = { claude: { report: { status: "ok", observedAt: NOW, windows: [
  win("session", "5h", "5-hour", 4, NOW + 3600, 18000)] } } };
const localBar = (density, fields = {}) => drawBar({ model: buildBarModel(localStates, effectivePrefs(), NOW), numbers: [], density, ...fields });

function assertFramed(frame) {
  for (const [method, value] of [["h", 20], ["px", 6], ["rounded", 5], ["border", 1], ["border_color", "border"], ["bg", "raised"]]) {
    assert.deepEqual(called(frame, method), [value], `${frame.id} ${method}`);
  }
  for (const name of NAMES) assert.ok(!stub.textOf(frame).includes(name), `${frame.id} ${name}`);
}

test("each provider group is a frame led by its icon, with no name text, in both bars and the summaries", () => {
  const { adapter, model } = harness(project(linuxHost()));
  const fleet = framesOf(drawBar({ fleet: fleetBar(model(), 1400, [], true) }), "ul-fleet-provider-0-");
  assert.equal(fleet.length, 4);
  const local = framesOf(localBar(DENSITY.FULL), "ul-claude");
  assert.equal(local.length, 1);
  adapter.dispatch({ type: "collapse", key: "arch" });
  const summary = framesOf(drawPanel(model(), { t: namedTheme }), "ul-sum-arch-");
  assert.equal(summary.length, 4);
  const groups = [barGroup("agy", "Antigravity", goWindows), barGroup("opencode-go", "OpenCode Go", goWindows)];
  const tree = drawBar({ model: { groups, empty: false }, numbers: [], density: DENSITY.FULL });
  const added = groups.map((g) => stub.findById(tree, `ul-${g.providerId}`));
  for (const frame of added) {
    for (const text of ["5h", "wk", "mo", "4%", "100%", "8%"]) assert.ok(stub.textOf(frame).includes(text), `${frame.id} ${text}`);
    assert.ok(!stub.textOf(frame).includes("OpenCode"), frame.id);
  }
  for (const frame of [...fleet, ...local, ...summary, ...added]) {
    assertFramed(frame);
    assert.equal(stub.assets(frame.kids[0]).length, 1, frame.id);
  }
});

test("a stale provider dims its whole frame", () => {
  const [arch] = harness(project(linuxHost())).model().remotes;
  const frames = framesOf(drawBar({ fleet: fleetBar({ groups: [{ ...arch, groups: arch.groups.map((g) => ({ ...g, dim: true })) }] }, 1400, [], true) }),
    "ul-fleet-provider-0-");
  for (const frame of frames) assert.deepEqual(called(frame, "opacity"), [0.55], frame.id);
});

test("the provider name shows on hover in the fleet bar and summaries, never in the local bar", () => {
  const { adapter, model } = harness(project(linuxHost()));
  const fleet = fleetBar(model(), 1400, [], true);
  const tips = (tree, prefix) => framesOf(tree, prefix).map((frame) => called(frame, "tooltip")?.[0]);
  assert.deepEqual(tips(drawBar({ fleet, nameOnHover: true }), "ul-fleet-provider-0-"), NAMES);
  assert.deepEqual(tips(drawBar({ fleet, nameOnHover: false }), "ul-fleet-provider-0-"), NAMES.map(() => undefined));
  assert.deepEqual(tips(localBar(DENSITY.FULL, { nameOnHover: true }), "ul-claude"), [undefined]);
  adapter.dispatch({ type: "collapse", key: "arch" });
  assert.deepEqual(tips(drawPanel(model()), "ul-sum-arch-"), NAMES);
  assert.deepEqual(tips(drawPanel(model(), { prefs: effectivePrefs({ nameOnHover: false }) }), "ul-sum-arch-"), NAMES.map(() => undefined));
});

test("only frames separate local providers, and a divider separates machines", () => {
  const dividers = (tree) => stub.findAll(tree, (n) => called(n, "w")?.[0] === 1 && called(n, "h")?.[0] === 14).length;
  const states = { ...localStates, codex: localStates.claude };
  const model = buildBarModel(states, effectivePrefs(), NOW);
  assert.equal(dividers(drawBar({ model, numbers: [], density: DENSITY.FULL })), 0);
  assert.equal(dividers(drawBar({ model, numbers: [{ level: "ok", text: "12%" }], density: DENSITY.FULL })), 1);
  assert.equal(dividers(drawBar({ fleet: fleetBar(harness(project(linuxHost())).model(), 1400, [], true) })), 0);
  assert.equal(dividers(drawBar({ fleet: fleetBar(combinedModel(), 2400, [], true) })), 1);
});

test("the fleet bar drops usage bars, then all but the tightest window, then falls back to labels only", () => {
  const models = harness(project(linuxHost())).model();
  const stageOf = (fleet) => fleet.labels ? "labels" : fleet.density === DENSITY.FULL ? "full"
    : fleet.groups[0].groups[0].segments.length > 1 ? "compact" : "tight";
  const widths = [];
  for (let width = 100; width <= 1400; width += 2) widths.push([width, stageOf(fleetBar(models, width, [], true))]);
  assert.deepEqual([...new Set(widths.map(([, stage]) => stage))], ["labels", "tight", "compact", "full"]);
  for (const [stage, shorts] of [["compact", ["5h", "wk", "Fable", "mo"]], ["tight", ["5h", "mo"]]]) {
    const [width] = widths.find(([, found]) => found === stage);
    const fleet = fleetBar(models, width, [], true);
    assert.equal(fleet.density, DENSITY.NO_BARS);
    assert.deepEqual(fleet.groups[0].groups.map((g) => g.providerId), ["claude", "codex", "copilot", "agy"]);
    if (stage === "tight") assert.ok(fleet.groups[0].groups.every((g) => g.segments.length <= 1));
    const tree = drawBar({ fleet });
    for (const short of shorts) assert.ok(stub.findAll(tree, (n) => n.texts.includes(short)).length, `${stage} ${short}`);
  }
});

test("window labels and 'today' are muted, and the narrowest local densities drop the window label", () => {
  assert.ok(mutedTexts(localBar(DENSITY.NO_BARS)).includes("5h"));
  assert.ok(!stub.textOf(localBar(DENSITY.NO_LABELS)).includes("5h"));
  const states = { pi: { report: { status: "ok", observedAt: NOW, windows: [], spend: { today: 1200, week: 5000 } } } };
  const model = buildBarModel(states, effectivePrefs({ spendOnBar: { pi: true } }), NOW);
  assert.ok(mutedTexts(drawBar({ model, numbers: [], density: DENSITY.FULL })).includes("today"));
});

test("the settings checkbox toggles the provider name on hover, on by default", () => {
  const act = viewActions({ prefs: () => effectivePrefs(shared(KEY_PREFS)) });
  const click = () => {
    const prefs = effectivePrefs(shared(KEY_PREFS));
    const tree = stub.nodeOf(settingsPanel(false, {}, { t: stub.theme, act, prefs }));
    const box = stub.findById(tree, "opt-name-on-hover");
    assert.ok(stub.textOf(box).includes("Provider name on hover"));
    box.handlers.on_click({}, { notify() {} });
    return effectivePrefs(shared(KEY_PREFS)).nameOnHover;
  };
  assert.equal(effectivePrefs().nameOnHover, true);
  assert.equal(click(), false);
  assert.equal(click(), true);
});

const barText = (fleet) => stub.textOf(drawBar({ fleet }));
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
    stages.add(fleet.labels ? "labels" : "wide");
    if (fleet.labels) assert.deepEqual(fleet.labels, ["Mac · mateos-macbook-pro", "Linux · mateod-arch"]);
    else assert.deepEqual(fleet.groups.map((h) => h.chip), ["Mac · mateos-macbook-pro", "Linux · mateod-arch"]);
    const text = fleet.labels ? fleet.labels.join(" ") : barText(fleet);
    assert.ok(text.includes("Mac · mateos-macbook-pro") && text.includes("Linux · mateod-arch"), `width ${width}`);
  }
  assert.ok(stages.has("labels") && stages.has("wide"));
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
