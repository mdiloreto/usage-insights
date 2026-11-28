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
const { RESOURCES_KEY, resourcePills } = await import(`${root}/fleet/resources.js`);
const { ALL_PROVIDERS, PROVIDERS } = await import(`${root}/providers/index.js`);
const { default: agy } = await import(`${root}/providers/agy.js`);
const { NEVER_FETCHED, fetchedState } = await import(`${root}/lib/fetch-state.js`);
const { barModel } = await import(`${root}/lib/view.js`);
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

test("with no remote machines the model is absent, and an unanswered Antigravity stays out of the local host", () => {
  const { model } = harness(project());
  assert.equal(model(), null);
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["claude", "codex", "agy", "opencode-go", "opencode", "pi"]);
  assert.equal(new Set(ALL_PROVIDERS.map((p) => p.id)).size, ALL_PROVIDERS.length, "no provider is listed twice");
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
    ...["a@b", "a\u0007b", "a\u0085b", "a\u2028b", "a\u2029b", "x".repeat(81)].flatMap((unsafe) => [
      [`unsafe title ${JSON.stringify(unsafe)}`, edited({ limits: [{ ...limit("Session", "not read"), title: unsafe },
        limit("Weekly", 0.3)] }), 5],
      [`unsafe label ${JSON.stringify(unsafe)}`, edited({ limits: [{ ...limit(unsafe, 0.9), title: "Session" },
        limit("Weekly", 0.3)] }), 5],
    ]),
    ["longest safe title", edited({ limits: [{ ...limit("Session", 0.1), title: "x".repeat(80) }] }), 5],
    ...["Monthly allowance", ...["Opus", "Sonnet", "Haiku", "Fable", "Cowork"].map((scope) => `${scope} Weekly`)]
      .map((label) => [`label ${label} over its title`,
        edited({ limits: [{ ...limit(label, 0.9), title: "Session" }, limit("Weekly", 0.3)] }), 5]),
    ["title of another kind", edited({ limits: [{ ...limit("Session", 0.1), title: "Monthly allowance" }] }), 5],
    ["label that is not text", edited({ limits: [{ ...limit(["Monthly allowance"], 0.1), title: "Session" }] }), 5],
    ["email labels", JSON.stringify({ ...JSON.parse(await fixture("email-label")), id: "agy" }), 5],
    ["32 limits", edited({ limits: [limit("Session"), ...Array.from({ length: 31 }, () => limit("Daily"))] }), 5],
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
  const crowded = edited({ limits: [limit("Session"), ...Array.from({ length: 32 }, () => limit("Daily"))] });
  assert.equal(parseHostRecord("agy", crowded, fetchedAt + 5).status, "malformed");
  assertNoReading(agy.parse(crowded, fetchedAt + 5), "33 limits");
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
const answered = (stdout, code = 0) => ({ agy: fetchedState(NEVER_FETCHED, agy, { code, stdout }, NOW),
  "opencode-go": { installed: false } });
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
const barTree = (fleet) => stub.nodeOf(statusBar({ fleet, detailsOpen: null, panel: null, border: false,
  onResize() {}, onHover() {}, toggleDetails() {} }, stub.theme));
const agyFrames = (fleet) => stub.findAll(barTree(fleet), (n) => /^ul-fleet-provider-\d+-agy$/.test(n.id));

test("Follow Space in a local space lends a remote machine's current Antigravity reading", () => {
  const models = barFleet([machine("arch", liveAgy(MIN, 30))], { local: noLocalAgy() });
  assert.deepEqual(onBar(models), [[MAC, ["claude", "codex"]], ["Linux · arch", ["agy"]]]);
  assert.deepEqual(lent(models).groups[0].segments.map((s) => [s.short, s.text]), [["5h", "30%"], ["wk", "30%"]]);
  assert.deepEqual(models.local.groups.map((g) => g.providerId), ["claude", "codex"]);
  assert.deepEqual(models.remotes[0].groups.map((g) => g.providerId), ["claude", "codex", "agy"]);
  const fleet = fleetBar(models, 2400, [], true);
  assert.ok(barText(fleet).includes("Linux · arch"));
  assert.equal(agyFrames(fleet).length, 1);
  assert.match(stub.textOf(agyFrames(fleet)[0]), /30%/);
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

test("a stored reading without windows is ignored rather than breaking the bar", () => {
  const odd = { agy: { installed: true, report: null, lastGood: { observedAt: NOW - MIN } } };
  const fleet = barFleet([machine("arch", datedAgy(DAY))], { local: odd });
  assert.deepEqual(onBar(fleet).at(-1), ["Linux · arch", ["agy"]]);
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

test("a lent entry is labelled wherever it is shown, and is left out before the bar loses its numbers", () => {
  const remotes = [machine("arch"), machine("studio", liveAgy(MIN))];
  const models = barFleet(remotes, { local: noLocalAgy(), focused: "arch" });
  const stages = new Set();
  for (let width = 60; width <= 1600; width += 2) {
    const fleet = fleetBar(models, width, [], true);
    if (fleet.labels) {
      stages.add("labels");
      assert.deepEqual(fleet.labels, ["Linux · arch", "Linux · studio"], `width ${width}`);
    } else if (agyFrames(fleet).length) {
      stages.add("lent");
      assert.ok(barText(fleet).includes("Linux · studio"), `width ${width}`);
      assert.match(stub.textOf(agyFrames(fleet)[0]), /10%/, `width ${width}`);
    } else {
      stages.add("left out");
      assert.deepEqual(fleet.groups.map((h) => h.chip), ["Linux · arch"], `width ${width}`);
      assert.match(barText(fleet), /%/, `width ${width}`);
    }
  }
  assert.deepEqual([...stages].sort(), ["labels", "left out", "lent"]);
  // With no other numbers to keep, the lent machine's chip stays at every width.
  const dashes = barFleet([machine("studio", liveAgy(MIN))], { local: noLocalAgy() });
  for (let width = 60; width <= 1600; width += 2) {
    const fleet = fleetBar(dashes, width, [], true);
    const chips = fleet.labels ?? fleet.groups.map((h) => h.chip);
    assert.deepEqual(chips, [MAC, "Linux · studio"], `dashes at width ${width}`);
  }
});

const localWindow = (percent) => ({ installed: true, lastGood: null, report: { status: "ok",
  ...current("test", NOW - MIN, [win("session", "5h", "5-hour", percent, NOW + 3600, 18000)]) } });

test("a lent entry never costs this computer its numbers", () => {
  const local = { claude: localWindow(41), codex: localWindow(52), ...noLocalAgy() };
  const models = barFleet([machine("arch", datedAgy(DAY)), machine("studio", liveAgy(MIN, 30))], { local });
  const alone = { ...models, groups: models.groups.slice(0, 1) };
  const stages = new Set();
  for (let width = 60; width <= 1600; width += 2) {
    const fleet = fleetBar(models, width, [], true);
    const without = fleetBar(alone, width, [], true);
    if (without.labels) {
      stages.add("labels");
      assert.deepEqual(fleet.labels, [MAC, "Linux · studio"], `width ${width}`);
      continue;
    }
    assert.ok(!fleet.labels, `width ${width}: the numbers stay`);
    assert.match(barText(fleet), /41%.*52%/, `width ${width}`);
    if (agyFrames(fleet).length) {
      stages.add("lent");
      assert.match(stub.textOf(agyFrames(fleet)[0]), /30%/, `width ${width}`);
    } else {
      stages.add("left out");
      assert.deepEqual(fleet, without, `width ${width}`);
    }
  }
  assert.deepEqual([...stages].sort(), ["labels", "left out", "lent"]);
});

test("hiding this computer's Antigravity windows does not bring another machine's onto its bar", () => {
  const prefs = effectivePrefs({ hiddenWindows: ["agy:session", "agy:weekly_all"] });
  const remotes = [machine("arch", liveAgy(MIN, 30))];
  assert.equal(lent(barFleet(remotes, { local: noLocalAgy(), prefs })).chip, "Linux · arch", "without a reading here, one is lent");
  const here = barFleet(remotes, { local: localAgy(MIN), prefs });
  assert.deepEqual(here.groups, [here.local]);
  assert.deepEqual(group(here.local, "agy").segments, []);
});

test("a machine lends a current Antigravity reading only when it has a window to show", () => {
  const away = (hiddenWindows, ...others) => barFleet([machine("arch"), ...others],
    { local: localAgy(MIN), focused: "arch", prefs: effectivePrefs({ hiddenWindows }) });
  const part = away(["agy:session"]);
  assert.deepEqual(lent(part).groups[0].segments.map((s) => s.short), ["wk"]);
  const all = ["agy:session", "agy:weekly_all"];
  const none = away(all);
  assert.deepEqual(none.groups, [none.remotes[0]]);
  assert.equal(lent(away(all, machine("studio", liveAgy(10 * MIN)))).chip, "Linux · studio");
  assert.equal(lent(away(all, machine("studio", datedAgy(DAY)))).chip, "Linux · studio");
});

const reading = (route, cpuPct, memPct, diskPct, observedAt = NOW - 5) => ({ route, cpuPct, memPct, diskPct, observedAt });
const published = (...machines) => ({ version: 1, staleAfterSec: 60, machines });
const bothRead = published(reading(null, 12, 61, 27), reading("arch", 71, 33, 90));
const resourceModels = (resources, { remotes = [linuxHost()], local = localStates, focused = null, mode = "follow", selected } = {}) => {
  const projection = project(...remotes);
  const saved = { mode, selected: selected ? { route: selected, label: selected } : null, collapsed: [] };
  return harness(projection, saved).adapter.model(projection, focused, effectivePrefs(), { local, now: NOW, resources });
};
const combinedResources = (resources, options) => resourceModels(resources, { mode: "combined", selected: "arch", ...options });
const pillsOf = (tree) => framesOf(tree, "ul-resources-");
const shownPercents = (pills) => Object.fromEntries(pills.map(({ route, segments }) => [route, segments.map((s) => `${s.short} ${s.text}`)]));
const parsed = (record) => shownPercents([...resourcePills(record, NOW)].map(([route, segments]) => ({ route, segments })));

test("resource readings are parsed by route, with each machine's metrics in order", () => {
  assert.equal(RESOURCES_KEY, "fleet-resources.readings");
  assert.deepEqual(parsed(bothRead), { null: ["CPU 12%", "RAM 61%", "Disk 27%"], arch: ["CPU 71%", "RAM 33%", "Disk 90%"] });
  assert.deepEqual([...resourcePills(bothRead, NOW).keys()], [null, "arch"]);
  assert.deepEqual(parsed(published(reading("arch", 0, 100, 50))), { arch: ["CPU 0%", "RAM 100%", "Disk 50%"] });
});

test("an absent, wrong-version or malformed resource record gives nothing and never throws", () => {
  const good = reading("arch", 1, 2, 3);
  for (const record of [undefined, null, false, 0, 7, "text", [], {}, [good],
    { ...published(good), version: 2 }, { ...published(good), version: "1" }, { staleAfterSec: 60, machines: [good] },
    { ...published(good), staleAfterSec: undefined }, { ...published(good), staleAfterSec: "60" },
    { ...published(good), staleAfterSec: 1.5 }, { ...published(good), machines: undefined },
    { ...published(good), machines: { arch: good } }, published()]) {
    assert.equal(resourcePills(record, NOW).size, 0, JSON.stringify(record));
  }
});

test("a malformed or stale resource entry is skipped without costing the others", () => {
  const good = reading("arch", 1, 2, 3);
  const bad = [null, undefined, 5, "arch", [], {}, { ...good, route: undefined }, { ...good, route: "" },
    { ...good, route: 4 }, { ...good, route: "mini", observedAt: undefined }, { ...good, route: "mini", observedAt: String(NOW) },
    { ...good, route: "mini", observedAt: NOW - 61 }, { ...good, route: "mini", observedAt: NOW + 1 },
    { ...good, route: "mini", observedAt: NOW + 365 * DAY }, { ...good, route: "mini", observedAt: (NOW - 5) * 1000 }];
  for (const entry of bad) {
    assert.deepEqual(Object.keys(parsed(published(entry, reading(null, 4, 5, 6)))), ["null"], JSON.stringify(entry));
  }
  for (const observedAt of [NOW, NOW - 60]) {
    assert.equal(resourcePills(published(reading("arch", 1, 2, 3, observedAt)), NOW).size, 1, `current at ${NOW - observedAt} s old`);
  }
});

test("unknown and out-of-range metrics keep their place as a dash, and a machine with none has no pill", () => {
  for (const unknown of [null, undefined, -1, 101, 12.5, "12", Number.NaN]) {
    assert.deepEqual(parsed(published(reading("arch", unknown, 40, 50))), { arch: ["CPU —", "RAM 40%", "Disk 50%"] }, String(unknown));
    const [cpu] = resourcePills(published(reading("arch", unknown, 40, 50)), NOW).get("arch");
    assert.deepEqual([cpu.text, cpu.brief, cpu.level, cpu.fill, cpu.tick], ["—", "—", "ok", 0, null], String(unknown));
    assert.equal(resourcePills(published(reading("arch", unknown, unknown, unknown)), NOW).size, 0, String(unknown));
  }
});

test("Follow Space shows the resources of the focused space's machine, between its chip and its quotas", () => {
  for (const [focused, id, numbers] of [[null, "claude", /CPU 12% RAM 61% Disk 27%/], ["arch", "claude", /CPU 71% RAM 33% Disk 90%/]]) {
    const tree = drawBar({ fleet: fleetBar(resourceModels(bothRead, { focused }), 2400, [], true) });
    assert.equal(pillsOf(tree).length, 1);
    const [, pill, frame] = stub.findById(tree, "ul-machine-0").kids;
    assert.equal(pill.id, "ul-resources-0");
    assert.equal(frame.id, `ul-fleet-provider-0-${id}`);
    assert.match(stub.textOf(pill).replace(/\s+/g, " "), numbers);
    assertFramed(pill);
    assert.deepEqual(stub.assets(pill), [], "the pill has no icon");
  }
  const other = resourceModels(published(reading("studio", 1, 2, 3)), { focused: "arch" });
  assert.equal(pillsOf(drawBar({ fleet: fleetBar(other, 2400, [], true) })).length, 0, "another route's reading is not borrowed");
});

test("Local + Remote draws one resource pill per machine, each with its own numbers", () => {
  const tree = drawBar({ fleet: fleetBar(combinedResources(bothRead), 3000, [], true) });
  assert.deepEqual(pillsOf(tree).map((p) => p.id), ["ul-resources-0", "ul-resources-1"]);
  for (const [index, numbers] of [[0, /12%.*61%.*27%/], [1, /71%.*33%.*90%/]]) {
    const [chip, pill, frame] = stub.findById(tree, `ul-machine-${index}`).kids;
    assert.equal(called(chip, "border"), undefined);
    assert.equal(pill.id, `ul-resources-${index}`);
    assert.ok(frame.id.startsWith(`ul-fleet-provider-${index}-`));
    assert.match(stub.textOf(pill), numbers);
  }
});

test("a lent Antigravity entry and placeholder machines have no resource pill", () => {
  const readings = published(reading(null, 1, 2, 3), reading("arch", 4, 5, 6), reading("studio", 7, 8, 9));
  const borrowed = resourceModels(readings, { remotes: [machine("arch"), machine("studio", liveAgy(MIN))],
    local: noLocalAgy(), focused: "arch" });
  assert.equal(lent(borrowed).lent, true);
  assert.equal(lent(borrowed).resources, undefined);
  assert.deepEqual(pillsOf(drawBar({ fleet: fleetBar(borrowed, 2400, [], true) })).map((p) => p.id), ["ul-resources-0"]);
  const two = [machine("arch"), machine("studio")];
  for (const [label, remotes, mode, activeMachine, ids] of [
    ["Choose remote", two, "combined", null, ["ul-resources-0"]],
    ["No remote available", [linuxHost({ state: "unreachable" })], "combined", null, ["ul-resources-0"]],
    ["Active machine unknown", two, "follow", undefined, []],
  ]) {
    const projection = project(...remotes);
    const models = harness(projection, { mode, selected: null, collapsed: [] }).adapter
      .model(projection, activeMachine, effectivePrefs(), { local: localStates, now: NOW, resources: readings });
    assert.ok(models.groups.some((host) => host.label === label), label);
    assert.deepEqual(pillsOf(drawBar({ fleet: fleetBar(models, 2400, [], true) })).map((p) => p.id), ids, label);
  }
});

test("resource bars and numbers turn from ok to warn to hot", () => {
  const models = resourceModels(published(reading(null, 69, 70, 90)));
  const tree = drawBar({ fleet: fleetBar(models, 2400, [], true) });
  const colors = stub.findById(tree, "ul-resources-0").kids.map((segmentNode) => {
    const [, track, number] = segmentNode.kids;
    return [called(track.kids[0], "bg")[0], called(number, "text_color")[0], called(track.kids[0], "w")[0]];
  });
  assert.deepEqual(colors, [["ansi2", "ansi2", 21], ["ansi3", "ansi3", 21], ["ansi1", "ansi1", 27]]);
});

test("the resource pill always names its numbers on hover, whatever the provider-name preference", () => {
  const fleet = fleetBar(resourceModels(published(reading(null, 12, null, 27))), 2400, [], true);
  for (const nameOnHover of [true, false]) {
    const pill = stub.findById(drawBar({ fleet, nameOnHover }), "ul-resources-0");
    assert.equal(called(pill, "tooltip")?.[0], "CPU 12% · RAM — · Disk 27%", `nameOnHover ${nameOnHover}`);
  }
});

test("a numbers-only pill shows an unknown metric as a dim dash in its own place", () => {
  const models = resourceModels(published(reading(null, null, 86, 38)));
  const widths = Array.from({ length: 1500 }, (_, i) => 3000 - 2 * i);
  const fleet = widths.map((width) => fleetBar(models, width, [], true)).find((f) => f.resourceDensity === DENSITY.NO_LABELS);
  const pill = stub.findById(drawBar({ fleet, nameOnHover: false }), "ul-resources-0");
  assert.deepEqual(pill.kids.map((segmentNode) => [segmentNode.kids.length, stub.textOf(segmentNode),
    called(segmentNode.kids[0], "text_color")[0]]), [[1, "—", "dim"], [1, "86%", "ansi3"], [1, "38%", "ansi2"]]);
  assert.equal(called(pill, "tooltip")[0], "CPU — · RAM 86% · Disk 38%");
});

const hasBar = (node) => stub.findAll(node, (n) => called(n, "h")?.[0] === 4).length > 0;
const pillStyle = (pill) => `${stub.textOf(pill).includes("CPU") ? "label " : ""}${hasBar(pill) ? "bar " : ""}number`;

test("the resource pill takes its estimated width, then loses its labels, then gives way to the quotas", () => {
  const states = { ...localStates, codex: { installed: false }, "opencode-go": { installed: false } };
  const remote = linuxHost();
  remote.providers = remote.providers.slice(0, 2);
  const models = resourceModels(published(reading(null, 12, 61, 27)), { remotes: [remote], local: states });
  const without = resourceModels(undefined, { remotes: [remote], local: states });
  // Beside the one-machine quota bar (237), a pill of 198 with labels and 109 without.
  const labelled = 237 + 198;
  const bare = 237 + 109;
  for (const [width, style] of [[labelled, "label number"], [labelled - 1, "number"], [bare, "number"], [bare - 1, null], [237, null]]) {
    const fleet = fleetBar(models, width, [], false);
    assert.equal(fleet.labels, undefined, `width ${width}`);
    assert.match(barText(fleet), /5h 4%/, `width ${width}`);
    const pill = stub.findById(drawBar({ fleet }), "ul-resources-0");
    assert.equal(pill && pillStyle(pill), style ?? undefined, `width ${width}`);
    if (!style) assert.deepEqual(fleet, fleetBar(without, width, [], false), `width ${width}`);
  }
  // The room the pill leaves goes back to the quotas, usage bars included.
  const regained = fleetBar(models, bare - 1, [], true);
  assert.equal(regained.density, DENSITY.FULL);
  assert.deepEqual(regained, fleetBar(without, bare - 1, [], true));
  const narrowest = fleetBar(models, 236, [], false);
  assert.deepEqual(narrowest.labels, ["This Computer"]);
  assert.equal(pillsOf(drawBar({ fleet: narrowest })).length, 0);
});

const hasQuotaNumbers = (fleet) => !fleet.labels
  && framesOf(drawBar({ fleet }), "ul-fleet-provider-").some((frame) => /\d%/.test(stub.textOf(frame)));
function resourceStage(fleet) {
  if (fleet.labels) return "labels";
  const pills = pillsOf(drawBar({ fleet }));
  if (!pills.length) return "no pills";
  if (fleet.resourceDensity === DENSITY.NO_LABELS) return "pill numbers";
  if (fleet.density === DENSITY.FULL) return "full";
  return fleet.groups.some((host) => host.groups.some((g) => g.segments.length > 1)) ? "compact" : "tight";
}

test("the fleet bar narrows resources through every step, ending at the bar without resources", () => {
  const models = combinedResources(bothRead);
  const without = combinedResources(undefined);
  for (const [showBars, expected] of [[true, ["labels", "no pills", "pill numbers", "tight", "compact", "full"]],
    [false, ["labels", "no pills", "pill numbers", "tight", "compact"]]]) {
    const stages = new Set();
    let allWindowsWithoutPills = false;
    for (let width = 60; width <= 3000; width += 2) {
      const fleet = fleetBar(models, width, [], showBars);
      const stage = resourceStage(fleet);
      stages.add(stage);
      const style = { full: "label bar number", compact: "label number", tight: "label number", "pill numbers": "number" }[stage];
      const pills = pillsOf(drawBar({ fleet }));
      assert.equal(pills.length, style ? 2 : 0, `width ${width}`);
      for (const pill of pills) assert.equal(pillStyle(pill), style, `width ${width} ${stage}`);
      if (stage === "pill numbers") {
        assert.ok(fleet.groups.every((h) => h.groups.every((g) => g.segments.length <= 1)), `width ${width}`);
      }
      if (stage === "no pills") {
        assert.deepEqual(fleet, fleetBar(without, width, [], showBars), `width ${width}`);
        allWindowsWithoutPills ||= fleet.groups.some((h) => h.groups.some((g) => g.segments.length > 1));
      }
    }
    assert.deepEqual([...stages], expected, `showBars ${showBars}`);
    assert.ok(allWindowsWithoutPills, `showBars ${showBars}`);
  }
});

test("resources never leave the bar with labels only where it would have shown quota numbers", () => {
  const readings = published(reading(null, 100, 100, 100), reading("arch", 100, 100, 100), reading("studio", 100, 100, 100));
  const lending = { remotes: [machine("arch"), machine("studio", liveAgy(MIN))], local: noLocalAgy(), focused: "arch" };
  const costly = { remotes: [machine("arch", datedAgy(DAY)), machine("studio", liveAgy(MIN, 30))],
    local: { claude: localWindow(41), codex: localWindow(52), ...noLocalAgy() } };
  const session = [{ level: "ok", text: "ctx 12%" }];
  for (const options of [{}, { focused: "arch" }, { mode: "combined", selected: "arch" }, lending, costly]) {
    const withResources = resourceModels(readings, options);
    const without = resourceModels(undefined, options);
    for (const showBars of [true, false]) {
      for (const numbers of [[], session]) {
        for (let width = 60; width <= 3000; width += 2) {
          const plain = fleetBar(without, width, numbers, showBars);
          const fleet = fleetBar(withResources, width, numbers, showBars);
          if (hasQuotaNumbers(plain)) assert.ok(hasQuotaNumbers(fleet), `width ${width}`);
          assert.equal(Boolean(fleet.labels), Boolean(plain.labels), `width ${width}`);
          if (!pillsOf(drawBar({ fleet })).length) assert.deepEqual(fleet, plain, `width ${width}`);
          else assert.deepEqual(fleet.groups.map((h) => h.chip), plain.groups.map((h) => h.chip), `width ${width}`);
        }
      }
    }
  }
});

test("without a usable reading the fleet bar is exactly as it was", () => {
  const options = { mode: "combined", selected: "arch" };
  const plain = resourceModels(undefined, options);
  const drawn = (fleet) => JSON.stringify(drawBar({ fleet, nameOnHover: true }));
  for (const record of [null, { ...bothRead, version: 2 }, published(reading("studio", 1, 2, 3)),
    published(reading(null, 1, 2, 3, NOW - 61), reading("arch", null, null, null))]) {
    const models = resourceModels(record, options);
    for (const showBars of [true, false]) {
      for (let width = 60; width <= 2400; width += 20) {
        const fleet = fleetBar(models, width, [], showBars);
        const before = fleetBar(plain, width, [], showBars);
        assert.deepEqual(fleet, before, `width ${width}`);
        assert.ok(!("resourceDensity" in fleet), `width ${width}`);
        assert.equal(drawn(fleet), drawn(before), `width ${width}`);
      }
    }
  }
  assert.ok(plain.groups.every((host) => !("resources" in host)));
});
