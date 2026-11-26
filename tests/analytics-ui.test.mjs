import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mainSource = await readFile(new URL("../mods/insights/main.js", import.meta.url), "utf8");
const analyticsSource = await readFile(new URL("../mods/insights/analytics.js", import.meta.url), "utf8");
const uiSource = await readFile(new URL("../mods/insights/ui.js", import.meta.url), "utf8");
const fleetSource = await readFile(new URL("../mods/insights/core/fleet.mjs", import.meta.url), "utf8");
const quotaSource = await readFile(new URL("../mods/insights/quota-view.js", import.meta.url), "utf8");
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const analyticsUrl = dataUrl(analyticsSource);
const analytics = await import(analyticsUrl);
const analyticsNames = Object.keys(analytics).join(", ");
const { buildHeatmap, compactDashboard, deriveDashboard } = analytics;

function fakeNativeElement() {
  const node = { calls: [], childNodes: [], style: {} };
  let element;
  const methods = {
    child(value) {
      if (globalThis.__insightsTestNative.strictChildren
        && (value === null || !["string", "object"].includes(typeof value))) {
        throw new TypeError("child(value) expects an element, a string, or an entity");
      }
      node.childNodes.push(value);
      return element;
    },
    children(values) { node.childNodes.push(...values); return element; },
    when(condition, branch) { if (condition) branch(element); return element; },
    w(value) { node.style.width = value; return element; },
    whitespace_nowrap() { node.style.whitespace = "nowrap"; return element; },
    items_start() { node.style.alignItems = "start"; return element; },
    flex_wrap() { node.style.flexWrap = "wrap"; return element; },
    min_w(value) { node.style.minWidth = value; return element; },
    flex_basis(value) { node.style.flexBasis = value; return element; },
    flex_grow(value) { node.style.flexGrow = value; return element; },
  };
  element = new Proxy(node, {
    get(target, property) {
      if (property in methods) return methods[property];
      if (property in target) return target[property];
      if (typeof property === "symbol") return undefined;
      return (...args) => {
        node.calls.push([property, args]);
        return element;
      };
    },
  });
  return element;
}

globalThis.__insightsTestNative = { create: fakeNativeElement };

globalThis.__insightsTestHostCalls = { inputStates: 0, editorStates: 0 };

globalThis.__insightsTestInputState = {
  new(options = {}) {
    globalThis.__insightsTestHostCalls.inputStates += 1;
    const state = {
      text: String(options.value ?? ""),
      released: false,
      handlers: new Map(),
      value() { return state.text; },
      set_value(value) { state.text = String(value); },
      on(name, handler) { state.handlers.set(name, handler); },
      release() { state.released = true; },
    };
    return state;
  },
};

globalThis.__insightsTestEditorState = {
  new(options = {}) {
    globalThis.__insightsTestHostCalls.editorStates += 1;
    const state = {
      text: String(options.value ?? "{}"),
      released: false,
      value() { return state.text; },
      set_value(value) { state.text = String(value); },
      on() {},
      release() { state.released = true; },
    };
    return state;
  },
};

const transformedUi = uiSource
  .replace(/^import \{ div \} from "gpui-kit";$/m, `const div = () => globalThis.__insightsTestNative.create("div");`)
  .replace(
    /^import \{[^}]*\} from "gpui-base";$/m,
    `const v_flex = () => globalThis.__insightsTestNative.create("v_flex");
const h_flex = () => globalThis.__insightsTestNative.create("h_flex");
const Button = { new: (id) => globalThis.__insightsTestNative.create("Button") };
const Toggle = { new: (id) => globalThis.__insightsTestNative.create("Toggle") };
const Popover = {
  new(id) {
    const node = globalThis.__insightsTestNative.create("Popover");
    node.id = id;
    const builder = {
      get openState() { return node.openState; },
      get contentEl() { return node.contentEl; },
      get triggerEl() { return node.triggerEl; },
      trigger(element) { node.triggerEl = element; return builder; },
      open(value) { node.openState = value; return builder; },
      on_open_change(handler) { node.onOpenChange = handler; return builder; },
      content(element) { node.contentEl = element; return builder; },
    };
    return builder;
  },
};`,
  );
const uiUrl = dataUrl(transformedUi);
const ui = await import(uiUrl);
const uiNames = Object.keys(ui).join(", ");
const fleetUrl = dataUrl(fleetSource);
const fleet = await import(fleetUrl);
const fleetNames = Object.keys(fleet).join(", ");
const quotaUrl = dataUrl(quotaSource
  .replace(/^import \{ div, svg \} from "gpui-kit";$/m, `const div = () => globalThis.__insightsTestNative.create("div");
const svg = (path) => globalThis.__insightsTestNative.create("svg").asset(path);`)
  .replace(/^import \{ h_flex, v_flex \} from "gpui-base";$/m, `const h_flex = div; const v_flex = div;`)
  .replace(/^import \{ formatDuration, formatTimestamp \} from "\.\/analytics\.js";$/m, `const { formatDuration, formatTimestamp } = await import("${analyticsUrl}");`)
  .replace(/^import \{ G, card, cardHeader, fieldLabel, mutedText \} from "\.\/ui\.js";$/m, `const { G, card, cardHeader, fieldLabel, mutedText } = await import("${uiUrl}");`));
const { renderQuota } = await import(quotaUrl);
const projectionUrl = new URL("../mods/insights/quota-projection.mjs", import.meta.url).href;
const { insightQuotaHosts, mountQuotaView } = await import(projectionUrl);

const transformedMain = mainSource
  .replace(/^import \{ View, div, svg \} from "gpui-kit";$/m, `const View = class View {};
const div = () => globalThis.__insightsTestNative.create("div");
const svg = () => globalThis.__insightsTestNative.create("svg");`)
  .replace(
    /^import \{[^}]*\} from "gpui-base";$/m,
    `const InputState = globalThis.__insightsTestInputState;
const EditorState = globalThis.__insightsTestEditorState;
const v_flex = () => globalThis.__insightsTestNative.create("v_flex");
const h_flex = () => globalThis.__insightsTestNative.create("h_flex");
const Button = { new: (id) => globalThis.__insightsTestNative.create("Button") };
const Popover = {
  new(id) {
    const node = globalThis.__insightsTestNative.create("Popover");
    node.id = id;
    const builder = {
      get openState() { return node.openState; },
      get contentEl() { return node.contentEl; },
      get triggerEl() { return node.triggerEl; },
      trigger(element) { node.triggerEl = element; return builder; },
      open(value) { node.openState = value; return builder; },
      on_open_change(handler) { node.onOpenChange = handler; return builder; },
      content(element) { node.contentEl = element; return builder; },
    };
    return builder;
  },
};`,
  )
  .replace(
    /^import \{[^}]*\} from "herdr";$/m,
    `const appHome = () => "/app";
const home = () => "/home";
const checking = () => globalThis.__insightsTestHerdr?.checking?.() ?? false;
const theme = () => ({});
const settings = () => globalThis.__insightsTestSettings ?? ({});
const shared = (key) => globalThis.__insightsTestHerdr?.shared?.(key);
const setShared = (...args) => globalThis.__insightsTestHerdr?.setShared?.(...args);
const nextCommand = () => globalThis.__insightsTestHerdr.nextCommand();
const exec = (...args) => globalThis.__insightsTestHerdr.exec(...args);
const readTextFile = (...args) => globalThis.__insightsTestHerdr.readTextFile(...args);
const writeTextFile = (...args) => globalThis.__insightsTestHerdr.writeTextFile(...args);
const pickFolder = (...args) => globalThis.__insightsTestHerdr.pickFolder(...args);
const notify = (...args) => globalThis.__insightsTestHerdr.notify(...args);
const panes = () => globalThis.__insightsTestHerdr.panes();
const props = () => globalThis.__insightsTestHerdr.props();
const run = (...args) => globalThis.__insightsTestHerdr.run(...args);
const spaces = () => globalThis.__insightsTestHerdr.spaces();
const machines = () => globalThis.__insightsTestHerdr?.machines?.() ?? [];`,
  )
  .replace(
    /^import \{[\s\S]*?\} from "\.\/analytics\.js";$/m,
    `const { ${analyticsNames} } = await import("${analyticsUrl}");`,
  )
  .replace(
    /^import \{[\s\S]*?\} from "\.\/core\/fleet\.mjs";$/m,
    `const { ${fleetNames} } = await import("${fleetUrl}");`,
  )
  .replace(/^import \{ renderQuota \} from "\.\/quota-view\.js";$/m, `const { renderQuota } = await import("${quotaUrl}");`)
  .replace(/^import \{ insightQuotaHosts, mountQuotaView \} from "\.\/quota-projection\.mjs";$/m,
    `const { insightQuotaHosts, mountQuotaView } = await import("${projectionUrl}");`)
  .replace(/^import \{ createQuotaCoordinator, REVISION_KEY, TICK_MS \} from "\.\/fleet-quota\/coordinator\.mjs";$/m,
    `const REVISION_KEY = "fleet-quota.owner"; const TICK_MS = 250;
const createQuotaCoordinator = (bindings) => globalThis.__insightsTestHerdr?.quotaCoordinator?.(bindings) ??
  { mount: () => false, snapshot: () => null, dispose() {} };`)
  .replace(/^import \{ createQuotaEnrollmentStore, ENROLLMENT_OBSERVE_MS \} from "\.\/fleet-quota\/enrollments\.mjs";$/m,
    `const ENROLLMENT_OBSERVE_MS = 5000;
const createQuotaEnrollmentStore = (bindings) => globalThis.__insightsTestHerdr?.quotaEnrollment?.(bindings) ??
  { observe: async () => true, readEnrollments: () => [], invalidateEnrollment: async () => false };`)
  .replace(
    /^import \{[\s\S]*?\} from "\.\/ui\.js";$/m,
    `const { ${uiNames} } = await import("${uiUrl}");`,
  );
const { default: Insights, fitHeatmapWeeks, heatmapMetrics, modelLogo, presentationKey, providerLogo, usageLogo } = await import(dataUrl(transformedMain));

function optionArgument(args) {
  const index = args.indexOf("--options");
  return index >= 0 ? JSON.parse(args[index + 1]) : {};
}

function compactSnapshotFor(snapshot) {
  const { rows, ...rest } = snapshot;
  return { ...rest, rowCount: rows.length };
}

function presentationFor(snapshot, options, command = "snapshot") {
  return {
    version: 1,
    kind: "insights-presentation",
    command,
    options,
    snapshot: compactSnapshotFor(snapshot),
    dashboard: compactDashboard(deriveDashboard(snapshot, options)),
    error: null,
  };
}

function useHerdr({ readTextFile, execResult } = {}) {
  const state = {
    commands: [], execCalls: [], panes: [], props: {}, runtimeReads: [], spaces: [], machines: [],
    exportFolder: "/exports", exportWrites: [], notifications: [], checking: false, quotaSignals: [],
  };
  state.herdr = {
    appHome: () => "/app",
    home: () => "/home",
    checking: () => state.checking,
    shared: (key) => { state.quotaSignals.push(key); return null; },
    setShared() {},
    theme: () => ({}),
    settings: () => ({}),
    nextCommand: () => new Promise(() => {}),
    panes: () => state.panes,
    props: () => state.props,
    machines: () => state.machines,
    run: (...args) => state.commands.push(args),
    spaces: () => state.spaces,
    readTextFile: async (path) => {
      state.runtimeReads.push(path);
      return readTextFile ? readTextFile(path) : null;
    },
    writeTextFile: async (path, text, expected) => {
      state.exportWrites.push({ path, text, expected });
      return null;
    },
    pickFolder: async () => state.exportFolder,
    notify: (notification) => {
      state.notifications.push(notification);
      return "toast-1";
    },
    exec: async (command, args) => {
      state.execCalls.push({ command, args });
      if (execResult) return execResult(command, args, state);
      const options = optionArgument(args);
      const payload = presentationFor(savedSnapshot(), options, args[1] ?? "snapshot");
      return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
    },
  };
  globalThis.__insightsTestHerdr = state.herdr;
  return state;
}

function liveCx() {
  const calls = { notify: 0, spawn: 0, timers: [], after: [] };
  const cx = {
    calls,
    notify() { calls.notify += 1; },
    spawn(fn) {
      calls.spawn += 1;
      let cancelled = false;
      const done = Promise.resolve().then(() => (cancelled ? undefined : fn(cx)));
      return { cancel() { cancelled = true; return done; }, done };
    },
    timer: {
      every(ms, fn) {
        const timer = { ms, fn, cancelled: false, cancel() { timer.cancelled = true; } };
        calls.timers.push(timer);
        return timer;
      },
      after(ms, fn) {
        const timer = {
          ms,
          fn: () => fn(cx),
          cancelled: false,
          cancel() { timer.cancelled = true; },
        };
        calls.after.push(timer);
        return timer;
      },
    },
  };
  calls.runAfter = async () => {
    const pending = calls.after.splice(0);
    for (const timer of pending) {
      if (!timer.cancelled) timer.fn();
    }
    await flush();
  };
  return { cx, calls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeCx() {
  const calls = { notify: 0, spawn: 0, after: [] };
  return {
    calls,
    notify() { calls.notify += 1; },
    spawn() { calls.spawn += 1; return { cancel() {} }; },
    timer: {
      every() { return { cancel() {} }; },
      after() {
        const timer = { cancel() {} };
        calls.after.push(timer);
        return timer;
      },
    },
  };
}

function blankInstance() {
  const instance = Object.create(Insights.prototype);
  instance.loading = false;
  instance.saving = false;
  instance.error = null;
  instance.snapshot = null;
  instance.runtimeReady = true;
  instance.runtimeError = null;
  instance.nodeBinary = "/test/node";
  instance.year = 2024;
  instance.selectedDay = "2024-01-10";
  instance.period = "all";
  instance.filters = { provider: "all", model: "all" };
  instance.heatmapMode = "daily";
  instance.years = [2024];
  instance.dashboard = null;
  instance.machineScope = { kind: "local" };
  instance.machineView = null;
  instance.dashboardKey = null;
  instance.exporting = false;
  instance.exportTask = null;
  instance.closed = false;
  instance.dashboardPending = null;
  instance.dashboardError = null;
  instance.dashboardTimer = null;
  instance.dashboardTask = null;
  instance.dashboardQueued = false;
  instance.dashboardGeneration = 0;
  instance.refreshWatchdog = null;
  instance.saveWatchdog = null;
  instance.presenterPath = () => "/app/mods/insights/presenter.mjs";
  instance.storePath = () => "/app/data/insights/insights.json";
  return instance;
}

function savedSnapshot() {
  return {
    version: 1,
    generatedAt: "2024-01-10T12:00:00Z",
    lastScanAt: "2024-01-10T12:00:00Z",
    config: {
      profile: { name: "Saved", handle: "saved", avatar: "" },
      includeCache: true,
      weekStartsOn: 0,
      refreshSeconds: 60,
      sources: [{ id: "saved", label: "Saved", adapter: "saved", enabled: true, roots: ["~/saved"] }],
    },
    rows: [],
    stats: { files: 0, filesRead: 0, bytesRead: 0, unchangedFiles: 0, errors: 0 },
    warnings: [],
  };
}

function configDraft() {
  return {
    profile: { name: "Draft", handle: "draft", avatar: "mods/insights/draft.png" },
    includeCache: false,
    weekStartsOn: 1,
    refreshSeconds: 120,
    customTopLevel: { keep: true },
    sources: [{
      id: "custom",
      label: "Custom",
      adapter: "custom",
      enabled: true,
      roots: ["~/custom"],
      mapping: { input: "usage.input" },
      extra: { keep: true },
    }],
  };
}

test("native mod keeps timers and shell use inside the Herdr contract", () => {
  assert.doesNotMatch(mainSource, /\bsetTimeout\b/);
  assert.doesNotMatch(mainSource, /\bsetInterval\b/);
  assert.doesNotMatch(mainSource, /this\.cx\b/);
  assert.doesNotMatch(mainSource, /\bsh\s*,\s*\[/);
  assert.doesNotMatch(mainSource, /--rebuild/);
  assert.match(mainSource, /readTextFile\(this\.runtimePath\(\)\)/);
  assert.match(mainSource, /mods\/insights\/runtime\.json/);
  assert.equal((mainSource.match(/this\.execNode\(\[/g) ?? []).length, 3);
  assert.equal((mainSource.match(/\bexec\((?:node|DEFAULT_NODE), args, options\)/g) ?? []).length, 2);
  assert.match(mainSource, /presenter\.mjs/);
  assert.match(mainSource, /"prepare"/);
  assert.match(mainSource, /"machine-dashboard"/);
  assert.doesNotMatch(mainSource, /readFleetMachine|readFleet\b/);
  assert.match(mainSource, /timer\.after\(0/);
  assert.match(mainSource, /configure/);
  assert.match(mainSource, /--config/);
  assert.match(mainSource, /on_size_change/);
  assert.match(mainSource, /overflow_hidden/);
  assert.match(mainSource, /nextCommand/);
  assert.match(mainSource, /name === "refresh"/);
  assert.match(mainSource, /name === "settings"/);
  assert.match(mainSource, /name === "dashboard"/);
  assert.match(mainSource, /sourceStats/);
  assert.match(mainSource, /EditorState\.new/);
  assert.match(mainSource, /result\.code !== 0/);
  assert.match(mainSource, /\.release\(\)/);
  assert.match(mainSource, /from "\.\/ui\.js"/);
  assert.doesNotMatch(mainSource, /smallButton|detailStat|togglePill|shadow_md/);
  assert.doesNotMatch(mainSource, /rounded\([12][0-9]\)/);
});

test("export writes the current dashboard as Markdown without running the collector", async () => {
  const state = useHerdr();
  const instance = blankInstance();
  const snapshot = savedSnapshot();
  const rows = [{
    day: "2024-01-10",
    session: "s1",
    harness: "pi",
    provider: "openai",
    model: "gpt-test",
    project: "/repo/insights",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    messages: 1,
    activeMs: 1000,
    longestTaskMs: 1000,
  }];
  instance.snapshot = { ...snapshot, rows, rowCount: rows.length };
  instance.dashboard = compactDashboard(deriveDashboard({ ...snapshot, rows }, {
    filters: instance.filters,
    period: "all",
    year: 2024,
    heatmapMode: "daily",
    selectedDay: "2024-01-10",
    today: "2024-01-10",
  }));
  instance.dashboardKey = presentationKey(instance.snapshot, instance.dashboardOptions());
  const { cx } = liveCx();

  instance.exportMarkdown(cx);
  assert.equal(instance.exporting, true, "the button disables while the picker is open");
  await flush();
  await flush();

  assert.equal(state.exportWrites.length, 1);
  assert.match(state.exportWrites[0].path, /^\/exports\/insights-\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
  assert.equal(state.exportWrites[0].expected, null);
  assert.match(state.exportWrites[0].text, /^# Insights — All time/m);
  assert.match(state.exportWrites[0].text, /\| Tokens \| 15 \|/);
  assert.deepEqual(state.execCalls, [], "export must reuse the prepared dashboard, not rescan");
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].level, "success");
  assert.equal(instance.exporting, false);

  state.exportFolder = null;
  instance.exportMarkdown(cx);
  await flush();
  await flush();
  assert.equal(state.exportWrites.length, 1, "cancelling the picker writes nothing");
  assert.equal(state.notifications.length, 1, "cancelling the picker is silent");
  assert.equal(instance.exporting, false);

  let chooseFolder;
  state.herdr.pickFolder = ({ prompt }) => {
    assert.equal(prompt, "Export This Computer");
    return new Promise((resolve) => { chooseFolder = resolve; });
  };
  instance.exportMarkdown(cx);
  await flush();
  instance.setMachine("all", cx);
  chooseFolder("/exports");
  await flush();
  assert.equal(state.exportWrites.length, 1, "switching out of This Computer while picking a folder cancels export");
  instance.setMachine("local", cx);

  instance.filters.provider = "stale";
  instance.exportMarkdown(cx);
  await flush();
  assert.equal(state.exportWrites.length, 1, "a stale dashboard is never exported");
  assert.equal(instance.exporting, false);
});

test("export is a single toolbar button that starts a Markdown export", () => {
  const instance = blankInstance();
  instance.dashboardCurrent = () => true;
  let exported = false;
  instance.exportMarkdown = () => { exported = true; };

  const findExportButton = (node) => {
    if (!node || typeof node !== "object") return null;
    const label = Array.isArray(node.calls)
      ? node.calls.find(([name]) => name === "accessibility_label")
      : null;
    if (label?.[1]?.[0] === "Export This Computer") return node;
    for (const child of node.childNodes ?? []) {
      const found = findExportButton(child);
      if (found) return found;
    }
    return null;
  };

  const exportButton = findExportButton(instance.header({}));
  assert.ok(exportButton, "the header renders an Export button");
  const click = exportButton.calls.find(([name]) => name === "on_click")[1][0];
  click({}, { notify() {} });
  assert.equal(exported, true);
});

test("analytics stays host-free and the UI keeps configuration JSON editable", () => {
  assert.doesNotMatch(analyticsSource, /from\s+["']herdr["']/);
  assert.doesNotMatch(analyticsSource, /from\s+["']gpui-kit["']/);
  assert.doesNotMatch(analyticsSource, /from\s+["']gpui-base["']/);
  assert.match(mainSource, /Configuration JSON/);
  assert.match(mainSource, /Save configuration/);
  assert.doesNotMatch(mainSource, /(^|[^.\w])localStorage\b/);
});

test("toolbar init returns before runtime, collector, command, timer or editor setup", async () => {
  const state = useHerdr();
  globalThis.__insightsTestHostCalls.inputStates = 0;
  globalThis.__insightsTestHostCalls.editorStates = 0;
  const { cx, calls } = liveCx();
  const instance = new Insights();
  state.props = { mode: "toolbar" };
  instance.init(undefined, cx);

  assert.equal(instance.toolbarMode, true);
  assert.deepEqual(state.runtimeReads, []);
  assert.deepEqual(state.execCalls, []);
  assert.deepEqual(calls.timers, []);
  assert.equal(calls.spawn, 0);
  assert.equal(globalThis.__insightsTestHostCalls.inputStates, 0);
  assert.equal(globalThis.__insightsTestHostCalls.editorStates, 0);
  assert.equal(instance.commandTask, undefined);
  assert.equal(instance.runtimeTask, undefined);
  assert.equal(instance.dashboard, undefined);
  assert.doesNotThrow(() => instance.close());
  assert.equal(instance.closed, true);
});

test("toolbar render is only the native Insights button and has no side effects", () => {
  const state = useHerdr();
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }] }];
  state.panes = [];
  const instance = new Insights();
  state.props = { mode: "toolbar" };
  instance.init({}, fakeCx());
  const root = instance.render();
  const button = root.childNodes[0];

  assert.equal(button.childNodes[1], "Insights");
  assert.equal(button.calls.find(([name]) => name === "id")[1][0], "insights-open");
  for (const [method, value] of [["h", 26], ["px", 8], ["gap", 5], ["rounded", 6], ["text_size", 12]]) {
    assert.ok(button.calls.some(([name, args]) => name === method && args[0] === value),
      `${method} matches Herdr's native toolbar control`);
  }
  assert.deepEqual(state.commands, [], "render must have no side effects");

  let stopped = false;
  button.calls.find(([name]) => name === "on_mouse_down")[1][1]({}, {
    stop_propagation() { stopped = true; },
  });
  assert.equal(stopped, true);
  assert.doesNotMatch(mainSource, /mods\/insights-launcher/);
  assert.doesNotMatch(mainSource, /\blayout\(/);
});

test("toolbar reuses the active space's dashboard and reveals it behind another pane's zoom", () => {
  const state = useHerdr();
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }, { id: "t2" }] }];
  state.panes = [
    { pane: "terminal", mod: "terminal", tab: "t2", zoomed: true },
    { pane: "dashboard", mod: "insights", tab: "t2", focused: false, zoomed: false },
  ];
  const instance = new Insights();
  state.props = { mode: "toolbar" };
  instance.init({}, fakeCx());
  const button = instance.render().childNodes[0];
  const click = button.calls.find(([name]) => name === "on_click")[1][0];

  click();
  click();
  assert.deepEqual(state.commands, [
    ["pane.zoom", { pane: "terminal" }],
    ["pane.focus", { pane: "dashboard" }],
    ["pane.zoom", { pane: "terminal" }],
    ["pane.focus", { pane: "dashboard" }],
  ]);
});

test("toolbar keeps an already zoomed dashboard and opens a tab only when the space has none", () => {
  const state = useHerdr();
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }] }];
  state.panes = [{ pane: "dashboard", mod: "insights", tab: "t1", zoomed: true }];
  const instance = new Insights();
  state.props = { mode: "toolbar" };
  instance.init({}, fakeCx());
  const click = instance.render().childNodes[0].calls.find(([name]) => name === "on_click")[1][0];

  click();
  assert.deepEqual(state.commands, [["pane.focus", { pane: "dashboard" }]]);

  state.panes = [];
  state.commands.length = 0;
  click();
  assert.deepEqual(state.commands, [["tab.new", { name: "Insights", mod: "insights" }]]);

  state.spaces = [
    { id: "s1", active: true, tabs: [{ id: "t1" }] },
    { id: "s2", active: false, tabs: [{ id: "t2" }] },
  ];
  state.panes = [{ mod: "insights", tab: "t2" }];
  state.commands.length = 0;
  click();
  assert.deepEqual(state.commands, [["tab.new", { name: "Insights", mod: "insights" }]],
    "an Insights tab in another space never satisfies the current space");
});

test("init reads the runtime config once and waits before the first snapshot", async () => {
  let finishRead;
  const pendingRead = new Promise((resolve) => { finishRead = resolve; });
  const state = useHerdr({ readTextFile: () => pendingRead });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  assert.deepEqual(state.runtimeReads, ["/app/mods/insights/runtime.json"]);
  assert.equal(state.execCalls.length, 0, "no collector may start before runtime.json resolves");
  assert.equal(calls.timers.length, 0, "no poll may start before runtime.json resolves");

  instance.refresh(cx);
  await flush();
  assert.equal(state.execCalls.length, 0, "a manual refresh must also wait for runtime resolution");

  finishRead(null);
  await flush();
  await flush();
  assert.equal(instance.nodeBinary, "node", "manual-copy installs fall back to node on PATH");
  assert.equal(state.execCalls.length, 1);
  assert.equal(state.execCalls[0].command, "node");
  assert.equal(state.execCalls[0].args[1], "snapshot");
  assert.equal(calls.timers.length, 2, "the refresh interval plus the scan progress poll");

  instance.refresh(cx);
  await flush();
  await flush();
  assert.equal(state.runtimeReads.length, 1, "refresh must not reread runtime.json");
  assert.equal(state.execCalls.length, 2);
  assert.equal(state.execCalls[1].command, "node");
  instance.close();
});

test("snapshot and configure both launch the installed Node executable", async () => {
  const node = "/opt/homebrew/opt/node@24/bin/node";
  const state = useHerdr({ readTextFile: () => JSON.stringify({ node }) });
  const { cx } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  await flush();
  assert.equal(instance.nodeBinary, node);
  assert.equal(state.execCalls.length, 1);

  instance.saveConfig(cx);
  await flush();
  await flush();
  await flush();
  assert.deepEqual(state.execCalls.map((call) => call.command), [node, node]);
  assert.equal(state.execCalls[0].args[1], "snapshot");
  assert.equal(state.execCalls[1].args[1], "configure");
  instance.close();
});

test("invalid runtime config fails clearly without launching the collector", async () => {
  const cases = [
    ['{"node":"https://example.test/node"}', /URL/],
    ['{"node":"/usr/local/bin/node\\u0000"}', /control/],
    ['{"node":"   "}', /empty/],
    ["[]", /JSON object/],
    ['{"node":123}', /node string/],
    ["not json", /not valid JSON/],
  ];

  for (const [raw, reason] of cases) {
    const state = useHerdr({ readTextFile: () => raw });
    const { cx, calls } = liveCx();
    const instance = new Insights();
    instance.init({}, cx);

    await flush();
    await flush();
    assert.equal(state.execCalls.length, 0, raw);
    assert.equal(instance.nodeBinary, null, raw);
    assert.equal(instance.runtimeReady, true, raw);
    assert.match(instance.error, /runtime\.json/, raw);
    assert.match(instance.error, reason, raw);
    assert.equal(calls.timers.length, 0, raw);
    instance.close();
  }
});

test("refresh and configure share one single-flight guard", () => {
  const instance = blankInstance();
  const cx = fakeCx();

  instance.refresh(cx);
  assert.equal(instance.loading, true);
  assert.equal(instance.busy(), true);
  // Local uses only the existing snapshot task.
  assert.equal(cx.calls.spawn, 1);
  assert.equal(cx.calls.notify, 1);

  instance.refresh(cx);
  instance.saveConfig(cx);
  assert.equal(cx.calls.spawn, 1, "a snapshot or configure call must not start while refresh is in flight");

  instance.loading = false;
  instance.saving = true;
  instance.refresh(cx);
  instance.saveConfig(cx);
  assert.equal(cx.calls.spawn, 1, "refresh and configure must not start while save is in flight");
  assert.equal(instance.busy(), true);

  instance.saving = false;
  assert.equal(instance.busy(), false);
  assert.match(mainSource, /button\("insights-refresh",[^;]*?disabled: this\.busy\(\)/);
  const headerAt = mainSource.indexOf("  header(c,");
  const refreshAt = mainSource.indexOf('"insights-refresh"', headerAt);
  const exportAt = mainSource.indexOf('"insights-export"', headerAt);
  const settingsAt = mainSource.indexOf('"insights-settings"', headerAt);
  assert.ok(headerAt > 0 && refreshAt > headerAt && exportAt > refreshAt && settingsAt > exportAt,
    "the Export button sits between Refresh and Settings");
  assert.match(mainSource, /button\("ins-config-save",[\s\S]*?disabled: this\.busy\(\)/);
  assert.doesNotMatch(mainSource, /insights-save-profile|profileDirty|AvatarImage|nameInput|handleInput|avatarInput/);
});

test("dashboard render uses the precomputed presentation and builds closed filter menus lazily", () => {
  assert.match(mainSource, /const derived = local \? \(this\.dashboardCurrent\(\) \? this\.dashboard : null\) : view\?\.dashboard;/);
  assert.doesNotMatch(mainSource, /dashboardCache|updateDashboard|deriveDashboard/);
  assert.doesNotMatch(mainSource, /\b(buildHeatmap|buildModelSeries|facetStats|filterRows|filterRowsByRange|leaderboard|peakDay|streakStats|sumTokens)\(/);
  assert.match(mainSource, /if \(this\.openFilter === id && this\.openOptions\)/);
  assert.match(mainSource, /this\.openOptions = open \? buildFacetOptions/);
  assert.match(mainSource, /menu\.content\(this\.filterMenuContent/);
  assert.doesNotMatch(mainSource, /const (source|provider|model|project)Options = buildFacetOptions/);
  assert.doesNotMatch(mainSource, /safeAvatarPath|AvatarImage|AvatarFallback|Profile/);
  assert.match(mainSource, /scheduleDashboard\(clickCx, \{ force: true \}\)/);
});

test("inline cache notices name only degraded machines with their age or safe reason", () => {
  const instance = blankInstance();
  instance.machineLabels = new Map([["studio", "Studio"]]);
  assert.deepEqual(instance.cacheNotices({}, [
    { name: null, status: "fresh", ageMs: 0 },
    { name: "studio", status: "stale", ageMs: 60_000 },
    { name: "unknown-age", status: "stale", ageMs: null },
    { name: "office", status: "unavailable", reason: "could not reach that machine" },
  ]).map(renderedText), [
    "Studio · Showing older usage data · 1m old",
    "unknown-age · Showing older usage data · age unknown",
    "office · Token history unavailable · could not reach that machine",
  ]);
});

function renderedText(node) {
  if (typeof node === "string") return node;
  return (node?.childNodes ?? []).map(renderedText).join(" ");
}

function scopedReply(options, statuses) {
  const machines = Object.entries(statuses).map(([name, status]) => ({
    name: name === "local-fixture" ? null : name,
    status, ageMs: status === "unavailable" ? null : status === "stale" ? 120_000 : 10,
    reason: status === "unavailable" ? "no cache on that machine" : null,
  }));
  const readable = machines.filter(({ status }) => status !== "unavailable").length;
  const dashboard = readable ? presentationFor(savedSnapshot(), options).dashboard : null;
  if (dashboard) {
    dashboard.lifetime = { ...dashboard.lifetime, total: 716 };
    dashboard.rowCount = 1;
    if (options.scope.kind === "all") {
      const { models, ...series } = dashboard.modelSeries;
      dashboard.machineSeries = { ...series, machines: [] };
    }
  }
  const stale = machines.filter(({ status }) => status === "stale").length;
  return { code: 0, stdout: JSON.stringify({
    version: 1, kind: "insights-machine-dashboard", scope: options.scope, dashboard,
    coverage: { total: machines.length, readable, stale, partial: readable !== machines.length, machines },
  }) };
}

test("with no remotes All uses the Local dashboard but does not enable export", () => {
  useHerdr();
  const instance = blankInstance();
  instance.machineScope = { kind: "all" };
  const snapshot = { ...savedSnapshot(), savedAt: new Date().toISOString() };
  instance.snapshot = compactSnapshotFor(snapshot);
  const options = instance.dashboardOptions();
  instance.dashboard = presentationFor(snapshot, options).dashboard;
  instance.dashboardKey = presentationKey(instance.snapshot, options);
  const visible = renderedText(instance.dashboardView({}));
  assert.match(visible, /Token usage · All.*Token history by machine.*Top models/);
  assert.doesNotMatch(visible, /Token coverage|partial coverage|Showing older usage data|unavailable/);
  assert.match(renderedText(instance.machinePicker({}, instance.machineTarget())), /\bAll\b.*This Computer.*Export is available only for This Computer/);
  assert.equal(instance.exportReady(), false);
  instance.setMachine("local", fakeCx());
  assert.equal(instance.exportReady(), true);
});

test("scoped dashboard renders its loading state without a null native child", (t) => {
  const state = useHerdr();
  state.machines = [{ name: "linux" }];
  const instance = blankInstance();
  instance.machineScope = { kind: "all" };
  globalThis.__insightsTestNative.strictChildren = true;
  t.after(() => { globalThis.__insightsTestNative.strictChildren = false; });

  const visible = renderedText(instance.dashboardView({}));
  assert.match(visible, /Preparing All insights/);
  assert.doesNotMatch(visible, /Token coverage/);
  assert.equal(state.execCalls.length, 0);
});

test("new machine discovery after the local scan queues preparation once without exec in render", async () => {
  const state = useHerdr({
    execResult: (_binary, argv) => {
      assert.equal(argv[1], "machine-dashboard");
      return scopedReply(optionArgument(argv), { "local-fixture": "fresh", linux: "fresh" });
    },
  });
  state.machines = [{ name: null }];
  const instance = blankInstance();
  instance.machineScope = { kind: "all" };
  instance.year = Number(analytics.todayKey().slice(0, 4));
  const { cx, calls } = liveCx();
  const snapshot = { ...savedSnapshot(), savedAt: new Date().toISOString() };
  instance.applySnapshot(presentationFor(snapshot, instance.dashboardOptions()), cx);
  assert.doesNotMatch(renderedText(instance.render(cx)), /Token coverage|Showing older usage data|unavailable/);
  assert.equal(calls.after.length, 0);

  state.machines.push({ name: "linux", layout: "loading" });
  assert.match(renderedText(instance.render(cx)), /Preparing All insights/);
  instance.render(cx);
  assert.equal(state.execCalls.length, 0);
  assert.equal(calls.after.length, 1, "a registry change schedules one native callback");

  await calls.runAfter();
  await calls.runAfter();
  assert.equal(state.execCalls.length, 1);
  assert.deepEqual(optionArgument(state.execCalls[0].args).remoteNames, ["linux"]);
  const visible = renderedText(instance.render(cx));
  assert.match(visible, /Machine All This Computer linux.*Token usage · All.*Token history by machine/);
  assert.doesNotMatch(visible, /Token coverage|partial coverage|Showing older usage data|unavailable|Todas|Esta Mac|Cuotas/);
});

test("All draws the aggregate and each host as weekly bars, separately from model history", () => {
  const state = useHerdr();
  state.machines = [{ name: null }, { name: "linux" }, { name: "office" }];
  const instance = blankInstance();
  instance.machineScope = { kind: "all" };
  instance.machineLabels = new Map([["linux", "Build box"]]);
  const { key, options } = instance.dashboardRequest();
  const payload = JSON.parse(scopedReply(options, { "local-fixture": "fresh", linux: "stale", office: "unavailable" }).stdout);
  payload.dashboard.machineSeries = {
    weeks: [
      { start: "2024-01-07", total: 10, segments: [{ name: null, tokens: 10 }] },
      { start: "2024-01-14", total: 35, segments: [{ name: null, tokens: 15 }, { name: "linux", tokens: 20 }] },
    ],
    machines: [null, "linux"], maxTotal: 35, windowTotal: 45, includeCache: false,
  };
  instance.machineView = { key, payload };

  const dashboard = instance.dashboardView(ui.tokens({}));
  const visible = renderedText(dashboard);
  assert.match(visible, /Build box · Showing older usage data · 2m old/);
  assert.match(visible, /office · Token history unavailable · no cache on that machine/);
  assert.match(visible, /Token history by machine.*2 weeks · 45 tokens · cache excluded.*This Computer.*Build box.*Tokens History.*Top models/);
  assert.doesNotMatch(visible, /Token coverage|partial coverage/);
  const card = dashboard.childNodes.find((node) => renderedText(node.childNodes?.[0]).startsWith("Token history by machine"));
  const bars = card.childNodes[1].childNodes[0].childNodes[1].childNodes;
  const methodArg = (node, method) => node.calls.find(([name]) => name === method)?.[1][0];
  assert.equal(bars.length, 2);
  assert.match(methodArg(bars[0], "tooltip"), /10 tokens/);
  assert.match(methodArg(bars[1], "tooltip"), /35 tokens/);
  assert.ok(methodArg(bars[0].childNodes[0], "h") < methodArg(bars[1].childNodes[0], "h"));
  const segments = bars[1].childNodes[0].childNodes;
  assert.deepEqual(segments.map((node) => methodArg(node, "tooltip")), ["This Computer · 15 tokens", "Build box · 20 tokens"]);
  assert.notEqual(methodArg(segments[0], "bg"), methodArg(segments[1], "bg"));
  assert.deepEqual(state.execCalls, []);
});

test("quota projection stacks by machine and keeps zero, exhaustion, pace, resets and unavailable status distinct", (t) => {
  const now = Date.now();
  const resetAtMs = now + 3_600_000;
  const hosts = [
    { name: "linux", label: "Build box", providers: [
      { provider: "codex", plan: "Plus", status: "current", source: "CLI", observedAtMs: now - 60_000,
        windows: [{ label: "Week", usedPercent: 100, resetAtMs, pacePercent: 25 }] },
      { provider: "claude", status: "stale", source: "Dated snapshot", reason: "Auth expired", observedAtMs: now - 7_200_000,
        windows: [{ label: "Week", usedPercent: 99 }] },
    ] },
    { name: null, label: "Ignored local label", providers: [
      { provider: "codex", status: "current", source: "CLI", observedAtMs: now, windows: [
        { label: "5 h", usedPercent: 0, resetAtMs, pacePercent: 10 },
        { label: "Week", usedPercent: 35, resetAtMs: now },
        { label: "Other", usedPercent: null },
      ] },
      { provider: "claude", status: "unobserved", windows: [] },
    ] },
  ];
  const opts = { localLabel: "This Computer", now };
  globalThis.__insightsTestNative.strictChildren = true;
  t.after(() => { globalThis.__insightsTestNative.strictChildren = false; });
  const block = renderQuota(hosts, { kind: "all" }, {}, opts);
  const text = renderedText(block);
  assert.match(text, /Quotas.*This Computer.*Codex.*5 h.*\b0%.*Resets in 1H.*Week.*— Awaiting reset reading/);
  assert.match(text, /Other.*— No reading.*— Not observed.*Build box.*Codex Plus.*\b100%.*CLI.*Observed 1m ago/);
  assert.match(text, /Stale · Auth expired · Dated snapshot · Observed 2H ago/);
  assert.doesNotMatch(text, /35%|99%|Ignored local label|Cuotas/);
  const calls = [];
  const walk = (node) => {
    if (typeof node !== "object" || !node) return;
    calls.push(...node.calls);
    for (const child of node.childNodes) walk(child);
  };
  walk(block);
  assert.ok(calls.some(([method, args]) => method === "tooltip" && args[0] === "0% used · 10% pace"));
  assert.ok(calls.some(([method, args]) => method === "tooltip" && args[0] === "100% used · 25% pace"));
  assert.ok(calls.some(([method, args]) => method === "left" && args[0] === 16), "pace has its own marker");
  assert.ok(calls.some(([method, args]) => method === "asset" && args[0].endsWith("/openai.svg")));
  assert.ok(calls.some(([method, args]) => method === "asset" && args[0].endsWith("/anthropic.svg")));
  const remote = renderedText(renderQuota(hosts, { kind: "remote", name: "linux" }, {}, opts));
  const local = renderedText(renderQuota(hosts, { kind: "local" }, {}, opts));
  assert.match(remote, /Build box.*100%/);
  assert.doesNotMatch(remote, /This Computer/);
  assert.match(local, /This Computer.*\b0%/);
  assert.doesNotMatch(local, /Build box|100%/);
  assert.match(renderedText(renderQuota(hosts, { kind: "remote", name: "missing" }, {}, opts)), /missing.*— No quota reading/);
});

test("quota sections name Copilot and Antigravity per machine, text-only, with dated history", () => {
  const now = Date.now();
  const hosts = [{ name: "linux", label: "Build box", providers: [
    { provider: "copilot", plan: "Enterprise", status: "current", source: "Omarchy collector", observedAtMs: now - 60_000,
      windows: [{ label: "Monthly", usedPercent: 100 }] },
    { provider: "agy", status: "stale", reason: "Reading stale", observedAtMs: now - 15 * 86_400_000,
      windows: [], historyWindows: [{ label: "5h", usedPercent: 0 }] },
  ] }];
  const block = renderQuota(hosts, { kind: "remote", name: "linux" }, {}, { localLabel: "This Computer", now });
  const text = renderedText(block);
  assert.match(text, /Build box.*Copilot Enterprise.*Monthly.*100%.*Omarchy collector.*Antigravity.*5h \(dated\).*0% used/);
  const assets = [];
  const walk = (node) => {
    if (typeof node !== "object" || !node) return;
    assets.push(...node.calls.filter(([method]) => method === "asset").map(([, args]) => args[0]));
    for (const child of node.childNodes) walk(child);
  };
  walk(block);
  assert.deepEqual(assets, [], "no logo is invented for providers without one");
});

test("quota renderer remains visible with no token history and token filters do not alter it", () => {
  const state = useHerdr();
  state.machines = [{ name: null }, { name: "linux" }];
  const instance = blankInstance();
  instance.machineScope = { kind: "remote", name: "linux" };
  const { cx } = liveCx();
  const { key, options } = instance.dashboardRequest();
  instance.machineView = { key, payload: JSON.parse(scopedReply(options, { linux: "unavailable" }).stdout) };
  const before = renderedText(instance.render(cx));
  assert.match(before, /linux · Token history unavailable/);
  assert.equal((before.match(/Token history unavailable/g) ?? []).length, 1);
  assert.doesNotMatch(before, /Quotas|Lifetime tokens|0 tokens|Token coverage/);

  instance.quotaHosts = [{ name: "linux", label: "Build box", providers: [
    { provider: "codex", status: "current", source: "CLI", windows: [{ label: "5 h", usedPercent: 17 }] },
  ] }];
  assert.match(renderedText(instance.render(cx)), /Quotas.*Build box.*17%.*Build box · Token history unavailable · no cache on that machine/);
  instance.filters.model = "no-token-models";
  instance.setPeriod("month", cx);
  assert.match(renderedText(instance.render(cx)), /Quotas.*Build box.*17%.*Preparing Build box insights/);
  assert.deepEqual(state.execCalls, []);
});

test("projection maps the registered route separately from its label and preserves an observed zero", () => {
  const now = 1_800_000_000_000;
  const projection = {
    version: 1, owner: "ready", nextUpdateAt: null, local: [], remotes: [
      { route: "removed", label: "Old", registered: false, providers: [] },
      { route: "linux", label: "Build box", registered: true, providers: [
        { provider: "codex", status: "ready", current: { observedAt: now / 1_000 - 60, plan: "Plus", source: "cli",
          windows: [{ short: "5 h", percent: 0, resetsAt: now / 1_000 + 9_000, durationSec: 18_000 }] } },
        { provider: "claude", reason: "auth-expired", history: {
          observedAt: now / 1_000 - 120, plan: null, source: "history", windows: [{ short: "Week", percent: 73 }],
        } },
      ] },
    ],
  };
  const display = insightQuotaHosts(projection, "This Computer", now);
  assert.deepEqual(display.map(({ name, label }) => [name, label]), [[null, "This Computer"], ["linux", "Build box"]]);
  assert.deepEqual(display[0].providers, []);
  assert.deepEqual(display[1].providers[0].windows[0],
    { label: "5 h", usedPercent: 0, resetAtMs: now + 9_000_000, pacePercent: 50 });
  assert.equal(display[1].providers[1].status, "stale");
  assert.equal(display[1].providers[1].reason, "Provider sign-in expired");
  assert.deepEqual(display[1].providers[1].windows, []);
  assert.equal(insightQuotaHosts({ ...projection, remotes: [] }, "This Computer", now), null);
  assert.equal(insightQuotaHosts({ ...projection, version: 2 }, "This Computer", now), null);
});

test("shared quota view mounts once, ticks silently, and cancels deduplicated repaint on close", () => {
  const { cx, calls } = liveCx();
  const events = [];
  let projection = { version: 1, nextUpdateAt: 3 };
  const view = mountQuotaView(cx, {
    coordinator: {
      mount() { events.push("mount"); return true; },
      tick() { events.push("tick"); },
      snapshot() { events.push("snapshot"); return projection; },
      dispose() { events.push("dispose"); },
    },
    shared: (key) => events.push(key), revisionKey: "fleet-quota.owner", tickMs: 250, now: () => 1_000,
  });
  const tick = calls.timers[0];
  assert.equal(tick.ms, 250);
  tick.fn(cx);
  assert.equal(calls.notify, 0);
  view.read(cx);
  view.read(cx);
  assert.deepEqual(events, ["mount", "tick", "fleet-quota.owner", "snapshot", "fleet-quota.owner", "snapshot"]);
  assert.equal(calls.after.length, 1);
  assert.equal(calls.after[0].ms, 2_000);
  const previous = calls.after[0];
  projection = { version: 1, nextUpdateAt: 4 };
  view.read(cx);
  assert.equal(previous.cancelled, true);
  previous.fn();
  assert.equal(calls.notify, 0);
  const next = calls.after[1];
  next.fn();
  view.read(cx);
  assert.equal(calls.notify, 1);
  assert.equal(calls.after.length, 2, "the same boundary is not rearmed");
  projection = { version: 1, nextUpdateAt: 5 };
  view.read(cx);
  const closing = calls.after[2];
  view.dispose();
  view.dispose();
  tick.fn(cx);
  closing.fn();
  assert.equal(closing.cancelled, true);
  assert.equal(tick.cancelled, true);
  assert.equal(calls.notify, 1);
  assert.equal(events.filter((event) => event === "tick").length, 1);
  assert.equal(events.filter((event) => event === "dispose").length, 1);
  assert.equal(view.read(cx), null);
});

test("full Insights owns the quota view and enrollment observer; check and toolbar do not mount them", async () => {
  const state = useHerdr({ readTextFile: () => new Promise(() => {}) });
  state.machines = [{ name: "linux" }];
  let mounts = 0;
  let ticks = 0;
  let disposes = 0;
  let enrollmentCreates = 0;
  let observations = 0;
  const readEnrollments = () => [];
  const invalidateEnrollment = async () => false;
  state.herdr.quotaEnrollment = ({ appHome, checking, readTextFile, writeTextFile }) => {
    assert.equal(appHome(), "/app");
    assert.equal(checking(), false);
    assert.equal(typeof readTextFile, "function");
    assert.equal(typeof writeTextFile, "function");
    enrollmentCreates++;
    return { readEnrollments, invalidateEnrollment, observe: async () => { observations++; } };
  };
  state.herdr.quotaCoordinator = (bindings) => {
    const { machines, checking } = bindings;
    assert.equal(checking(), false);
    assert.equal(machines()[0].name, "linux");
    assert.equal(bindings.readEnrollments, readEnrollments);
    assert.equal(bindings.invalidateEnrollment, invalidateEnrollment);
    return {
      mount() { mounts++; return true; },
      tick() { ticks++; },
      dispose() { disposes++; },
      snapshot: () => ({ version: 1, owner: "ready", nextUpdateAt: null, local: [], remotes: [
        { route: "linux", label: "Build box", registered: true, providers: [] },
      ] }),
    };
  };
  const checked = new Insights();
  state.checking = true;
  checked.init({}, liveCx().cx);
  checked.close();
  state.checking = false;
  state.props = { mode: "toolbar" };
  const toolbar = new Insights();
  toolbar.init({}, liveCx().cx);
  toolbar.close();
  assert.equal(mounts, 0);
  assert.equal(enrollmentCreates, 0);
  state.props = {};

  const instance = new Insights();
  const { cx, calls } = liveCx();
  instance.init({}, cx);
  assert.equal(mounts, 1);
  assert.equal(enrollmentCreates, 1);
  const tree = renderedText(instance.render(cx));
  assert.match(tree, /Machine All This Computer Build box.*Quotas This Computer.*Build box/);
  assert.equal(instance.exportReady(), false);
  instance.setMachine("remote:linux", cx);
  assert.match(renderedText(instance.render(cx)), /Preparing Build box insights/);
  assert.deepEqual(instance.machineTarget().remoteNames, ["linux"]);
  instance.setPeriod("week", cx);
  instance.exportMarkdown(cx);
  assert.equal(ticks, 0);
  assert.deepEqual(state.execCalls, []);
  assert.deepEqual(state.exportWrites, []);
  assert.ok(state.quotaSignals.every((key) => key === "fleet-quota.owner"));
  await flush();
  assert.equal(observations, 1);
  const enrollmentTimer = calls.timers.find(({ ms }) => ms === 5_000);
  enrollmentTimer.fn(cx);
  await flush();
  assert.equal(observations, 2);
  const timer = calls.timers.find(({ ms }) => ms === 250);
  timer.fn(cx);
  instance.close();
  timer.fn(cx);
  enrollmentTimer.fn(cx);
  await flush();
  assert.equal(ticks, 1);
  assert.equal(disposes, 1);
  assert.equal(timer.cancelled, true);
  assert.equal(enrollmentTimer.cancelled, true);
  assert.equal(observations, 2);
});

test("scope and filter changes suppress late responses and local refresh cannot replace scoped usage", async () => {
  const pending = [];
  const state = useHerdr({
    execResult: (_binary, argv) => new Promise((resolve) => {
      assert.equal(argv[1], "machine-dashboard");
      pending.push({ options: optionArgument(argv), resolve });
    }),
  });
  state.machines = [{ name: null }, { name: "linux" }, { name: "office" }];
  const instance = blankInstance();
  const { cx, calls } = liveCx();
  instance.machineScope = { kind: "all" };
  const local = { ...savedSnapshot(), config: { ...savedSnapshot().config, includeCache: false, weekStartsOn: 1 } };
  instance.applySnapshot(presentationFor(local, instance.dashboardOptions()), cx);
  await calls.runAfter();
  const all = pending.shift();
  assert.deepEqual(all.options.scope, { kind: "all" });
  assert.deepEqual(all.options.remoteNames, ["linux", "office"]);
  assert.equal(all.options.includeCache, false);
  assert.equal(all.options.weekStartsOn, 1);
  assert.doesNotMatch(JSON.stringify(all.options), /rows|roots|~\/saved/);

  instance.setMachine("remote:linux", cx);
  assert.match(renderedText(instance.dashboardView({})), /Preparing linux insights/);
  all.resolve(scopedReply(all.options, { "local-fixture": "fresh", linux: "fresh", office: "fresh" }));
  await flush();
  assert.equal(instance.machineView, null);
  await calls.runAfter();
  const remote = pending.shift();
  assert.deepEqual(remote.options.scope, { kind: "remote", name: "linux" });
  assert.deepEqual(remote.options.remoteNames, ["linux", "office"]);

  instance.setPeriod("month", cx);
  remote.resolve(scopedReply(remote.options, { linux: "fresh" }));
  await flush();
  assert.equal(instance.machineView, null);
  await calls.runAfter();
  const filtered = pending.shift();
  assert.equal(filtered.options.period, "month");
  filtered.resolve(scopedReply(filtered.options, { linux: "fresh" }));
  await flush();
  assert.equal(instance.machineView.payload.dashboard.lifetime.total, 716);

  instance.applySnapshot(presentationFor(local, instance.dashboardOptions()), cx);
  assert.equal(instance.dashboard.lifetime.total, 0, "the collector only updates Local");
  const visible = renderedText(instance.dashboardView({}));
  assert.match(visible, /Token usage · linux.*716/);
  assert.doesNotMatch(visible, /office|This Computer|Token history by machine|Token coverage/);
  assert.equal(instance.exportReady(), false);
  instance.exportMarkdown(cx);
  assert.equal(state.exportWrites.length, 0);

  instance.filters.model = "different-model";
  instance.scheduleDashboard(cx, { force: true });
  const loading = renderedText(instance.dashboardView({}));
  assert.match(loading, /Preparing linux insights/);
  assert.doesNotMatch(loading, /Lifetime tokens|716/);

  instance.setMachine("local", cx);
  const localLoading = renderedText(instance.dashboardView({}));
  assert.match(localLoading, /Preparing This Computer insights/);
  assert.doesNotMatch(localLoading, /Lifetime tokens|716/);
});

test("a removed machine never shows its late result or another machine's usage", async () => {
  let complete;
  const state = useHerdr({
    execResult: (_binary, argv) => {
      const options = optionArgument(argv);
      if (!options.remoteNames.includes("linux")) return scopedReply(options, { linux: "unavailable" });
      return new Promise((resolve) => { complete = () => resolve(scopedReply(options, { linux: "fresh" })); });
    },
  });
  state.machines = [{ name: null }, { name: "linux" }];
  const instance = blankInstance();
  const { cx, calls } = liveCx();
  instance.setMachine("remote:linux", cx);
  await calls.runAfter();
  state.machines = [{ name: null }, { name: "studio" }];
  assert.match(renderedText(instance.dashboardView({})), /linux.*machine is not registered/);
  complete();
  await flush();
  assert.equal(instance.machineView, null);
  await calls.runAfter();
  const visible = renderedText(instance.dashboardView({}));
  assert.match(visible, /linux · Token history unavailable/);
  assert.doesNotMatch(visible, /Lifetime tokens|716|studio/);
});

test("an observed removal fences a same-route replacement while a cache read is in flight", async () => {
  const pending = [];
  const state = useHerdr({
    execResult: (_binary, argv) => new Promise((resolve) => pending.push({ options: optionArgument(argv), resolve })),
  });
  state.machines = [{ name: "linux" }];
  const instance = blankInstance();
  const { cx, calls } = liveCx();
  instance.setMachine("remote:linux", cx);
  await calls.runAfter();
  const beforeRemoval = pending.shift();

  state.machines = [];
  assert.match(renderedText(instance.dashboardView({})), /machine is not registered/);
  state.machines = [{ name: "linux" }];
  assert.match(renderedText(instance.dashboardView({})), /Preparing linux insights/);
  beforeRemoval.resolve(scopedReply(beforeRemoval.options, { linux: "fresh" }));
  await flush();
  assert.equal(instance.machineView, null, "old Core response is rejected even if the route reappears");

  await calls.runAfter();
  const replacement = pending.shift();
  replacement.resolve(scopedReply(replacement.options, { linux: "unavailable" }));
  await flush();
  const unavailable = renderedText(instance.dashboardView({}));
  assert.match(unavailable, /linux · Token history unavailable/);
  assert.doesNotMatch(unavailable, /Preparing|716/);
});

test("native check mode initializes All without runtime reads, timers or exec", async () => {
  const state = useHerdr();
  state.checking = true;
  state.machines = [{ name: "linux" }];
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);
  await flush();
  assert.deepEqual(instance.machineScope, { kind: "all" });
  assert.deepEqual(state.runtimeReads, []);
  assert.deepEqual(state.execCalls, []);
  assert.equal(calls.spawn, 0);
  assert.equal(calls.after.length + calls.timers.length, 0);
  instance.close();
});

test("heatmap month labels keep their spans while partial labels cannot wrap", () => {
  const instance = blankInstance();
  const heatmap = buildHeatmap([], { endDay: "2024-01-28", weeks: 53, weekStartsOn: 0 });
  assert.equal(heatmap.months[0].span, 1, "the fixture must start with a partial month");

  const totals = {
    total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    sessions: 0, messages: 0, longestTaskMs: 0,
  };
  const card = instance.heatmapCard(
    { background: "#101010" },
    { palette: "blue", includeCache: true },
    heatmap,
    heatmap.range.dataEnd,
    0,
    totals,
    null,
  );
  const metrics = heatmapMetrics(undefined, heatmap.weeks.length);
  const grid = card.childNodes[1].childNodes[0];
  const monthNodes = grid.childNodes[0].childNodes.slice(1);
  assert.equal(monthNodes.length, heatmap.months.length);

  heatmap.months.forEach((month, index) => {
    const node = monthNodes[index];
    assert.equal(node.style.width, month.span * metrics.weekWidth, `${month.label} keeps its week span`);
    if (month.span === 1) {
      assert.deepEqual(node.childNodes, [], "a one-week partial month has no label to wrap");
    } else {
      assert.deepEqual(node.childNodes, [month.label]);
      assert.equal(node.style.whitespace, "nowrap", `${month.label} must not wrap`);
    }
  });
});

test("root size is converted from window pixels to zoomed layout units", () => {
  const instance = blankInstance();
  instance.render = Insights.prototype.render;
  let notified = 0;
  globalThis.__insightsTestSettings = { zoom: 0.9 };
  try {
    const root = instance.render({ notify() {} });
    const call = root.calls.find(([name]) => name === "on_size_change");
    assert.ok(call, "the root measures itself");
    call[1][0]({ width: 810, height: 450 }, { notify() { notified += 1; } });
    assert.equal(Math.round(instance.width), 900, "810 window px at zoom 0.9 is a 900-wide layout");
    assert.equal(Math.round(instance.height), 500);
    assert.equal(notified, 1);
    assert.equal(heatmapMetrics(instance.width, 53).centered, true,
      "a 900-wide panel fits all 53 weeks; the raw 810 would wrongly overflow");
    assert.equal(heatmapMetrics(810, 53).centered, false);
  } finally {
    delete globalThis.__insightsTestSettings;
  }
});

test("heatmap grows on wide views and prefers the newest weeks when narrow", () => {
  const wide = heatmapMetrics(1600, 53);
  const narrow = heatmapMetrics(480, 53);
  assert.ok(wide.cell > narrow.cell, "wider views get larger cells");
  assert.ok(wide.cell <= 20, "cells stay capped");
  assert.equal(wide.centered, true);
  assert.equal(narrow.centered, false);
  assert.equal(wide.weekWidth, wide.cell + 2);
  assert.ok(narrow.fitWeeks < 53 && narrow.fitWeeks >= 1, "a narrow view draws fewer weeks instead of overflowing");
  assert.ok(30 + narrow.fitWeeks * narrow.weekWidth <= 480, "the weeks it draws fit");
  assert.match(mainSource, /fitHeatmapWeeks\(heatmap, metrics\.fitWeeks\)/);
});

test("heatmap fits in drawn pixels under app zoom", () => {
  // At zoom 0.9 a 12-unit cell draws 11 px and a 2-unit gap 2 px: 13 px a week,
  // not 12.6. Fitting in unrounded units drew one week too many and hid the
  // current one.
  const zoomed = heatmapMetrics(494, 53, 0.9);
  assert.equal(zoomed.cell, 12);
  assert.equal(zoomed.centered, false);
  assert.equal(Math.round(zoomed.weekWidth * 0.9), 13);
  const room = (494 - 24 - 32) * 0.9 - Math.round(30 * 0.9);
  assert.ok(zoomed.fitWeeks * 13 <= room, "the drawn weeks fit the row");
  assert.ok((zoomed.fitWeeks + 1) * 13 > room, "and no more would");
  const wide = heatmapMetrics(1100, 53, 0.9);
  assert.equal(wide.centered, true);
  const drawnWeek = Math.round(wide.cell * 0.9) + Math.round(2 * 0.9);
  assert.ok(53 * drawnWeek <= (1100 - 48 - 32) * 0.9 - Math.round(30 * 0.9), "a centered grid also fits once snapped");
});

test("heatmap fits the measured card width once known", () => {
  // At zoom 0.8 a week draws 10 + 2 = 12 px. A card measured at 590 px holds
  // floor((590 - 24 - 1) / 12) = 47 weeks.
  const measured = heatmapMetrics(800, 53, 0.8, 590);
  assert.equal(measured.centered, false);
  assert.equal(Math.round(measured.weekWidth * 0.8), 12);
  assert.equal(measured.fitWeeks, 47);
  assert.ok(Math.round(30 * 0.8) + measured.fitWeeks * 12 <= 590);
  assert.equal(heatmapMetrics(800, 53, 0.8, 560).fitWeeks, 44, "the measurement, not the padding estimate, decides");
  assert.equal(heatmapMetrics(800, 53, 0.8, null).fitWeeks, heatmapMetrics(800, 53, 0.8).fitWeeks,
    "before the first measurement the estimate is used");
  assert.match(mainSource, /heatmapMetrics\(this\.width, heatmap\.weeks\.length, Number\(settings\(\)\.zoom\) \|\| 1, this\.heatmapRowPx\)/);
  assert.match(mainSource, /id\("ins-heat-legend"\)[\s\S]{0,200}on_size_change/);
});

test("fitHeatmapWeeks keeps the newest weeks and trims month spans", () => {
  const heatmap = buildHeatmap([], { endDay: "2024-01-28", weeks: 53, weekStartsOn: 0 });
  const all = fitHeatmapWeeks(heatmap, 53);
  assert.equal(all.weeks, heatmap.weeks);
  const fit = fitHeatmapWeeks(heatmap, 10);
  assert.equal(fit.weeks.length, 10);
  assert.equal(fit.weeks.at(-1), heatmap.weeks.at(-1), "the current week is kept");
  assert.equal(fit.months.reduce((sum, month) => sum + month.span, 0), 10, "month spans cover exactly the drawn weeks");
  assert.equal(fit.months[0].week, 0);
  assert.equal(fit.months.at(-1).label, heatmap.months.at(-1).label);
});

test("dashboard is divided into token and model usage sections", () => {
  assert.match(mainSource, /sectionHeader\(`Token usage · \$\{scopeLabel\}`/);
  assert.match(mainSource, /sectionHeader\("Model usage"/);
  assert.match(mainSource, /cardHeader\("Tokens History", range\?\.label \?\? null, c\)/);
  assert.doesNotMatch(mainSource, /53 weeks · ends/);
  assert.match(mainSource, /"Model Usage"/);
  assert.doesNotMatch(mainSource, /Contribution history|Usage leaders/);
  // Period and facet filters belong to the model usage section only.
  assert.ok(mainSource.indexOf('sectionHeader("Model usage"') < mainSource.indexOf("this.filtersBar"));
  assert.ok(mainSource.indexOf("this.filtersBar") > mainSource.indexOf("this.heatmapCard"));
  assert.doesNotMatch(mainSource, /filterMenu\("source"|filterMenu\("project"|breakdownCard|selectedDetail/);
});

test("usage logos prefer model marks, then provider marks, then initials", async () => {
  assert.equal(modelLogo("deepseek-v4.1-flash"), "deepseek.svg");
  assert.equal(modelLogo("xai.grok-4.6"), "xai.svg");
  assert.equal(modelLogo("grok-4.6"), "xai.svg");
  assert.equal(modelLogo("claude-opus-5"), "anthropic.svg");
  assert.equal(modelLogo("gpt-6.1"), "openai.svg");
  assert.equal(modelLogo("ollama"), "ollama.svg");
  assert.equal(modelLogo("ollama/qwen2.5"), "ollama.svg");
  assert.equal(modelLogo("ollama/mistral"), "mistralai.svg");
  assert.equal(modelLogo("ollama/llama3"), "meta.svg");
  assert.equal(modelLogo("llama3.2"), "meta.svg");
  assert.equal(modelLogo("codellama:7b"), "meta.svg");
  assert.equal(modelLogo("tinyllama"), "meta.svg");
  assert.equal(modelLogo("moonshot-kimi"), null);

  assert.equal(usageLogo("deepseek-v4.1", "openai"), "deepseek.svg");
  assert.equal(usageLogo("grok-4.6", "openrouter"), "xai.svg");
  assert.equal(usageLogo("custom-model", "openai"), "openai.svg");
  assert.equal(usageLogo("custom-model", "moonshot"), null);

  assert.equal(providerLogo("openai"), "openai.svg");
  assert.equal(providerLogo("amazon-bedrock"), "amazonaws.svg");
  assert.equal(providerLogo("bedrock-mantle"), "amazonaws.svg");
  assert.equal(providerLogo("opencode-go"), "opencode.svg");
  assert.equal(providerLogo("xai"), "xai.svg");
  assert.equal(providerLogo("deepseek"), "deepseek.svg");
  assert.equal(providerLogo("moonshot"), null);
  assert.equal(providerLogo("unknown"), null);
  assert.equal(providerLogo(null), null);

  assert.match(mainSource, /usageLogo\(entry\.name, entry\.provider\)/);
  assert.match(mainSource, /initials\(entry\.name, 1\)/);
  assert.doesNotMatch(mainSource, /initials\(entry\.name, 2\)/);
  assert.doesNotMatch(mainSource, /"x\.svg"/);
  await Promise.all([
    "amazonaws.svg",
    "anthropic.svg",
    "deepseek.svg",
    "googlegemini.svg",
    "meta.svg",
    "mistralai.svg",
    "ollama.svg",
    "openai.svg",
    "opencode.svg",
    "xai.svg",
  ].map((file) => readFile(new URL(`../mods/insights/logos/${file}`, import.meta.url))));
});

test("model usage leaderboard is models-only with ranked change rows", () => {
  assert.doesNotMatch(mainSource, /ins-leaders-group|leaderboardGroup|insights\.group/);
  const instance = blankInstance();
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const rows = [
    { day: "2024-01-10", model: "model-a", provider: "p-one", tokens: { input: 100, output: 50 } },
    { day: "2024-01-10", model: "model-b", provider: "p-two", tokens: { input: 40, output: 10 } },
  ];
  const leaders = analytics.leaderboard(rows, null, { groupBy: "model", includeCache: true });
  const card = instance.leaderboardCard(c, leaders, { label: "All time" });
  const column = card.childNodes[1].childNodes[0];
  const firstRow = column.childNodes[0];

  assert.equal(firstRow.childNodes.length, 4, "rank, avatar, name, and value only; no share bar");
  assert.deepEqual(firstRow.childNodes[0].childNodes, ["1."]);
  const nameColumn = firstRow.childNodes[2];
  assert.deepEqual(nameColumn.childNodes[0].childNodes, ["model-a"]);
  assert.deepEqual(nameColumn.childNodes[1].childNodes, ["by p-one"]);
  const valueColumn = firstRow.childNodes[3];
  assert.deepEqual(valueColumn.childNodes[0].childNodes, ["150 tokens"]);
  assert.deepEqual(valueColumn.childNodes[1].childNodes, ["—"], "no previous period shows a dash");
});

test("model usage wraps into columns instead of switching on a pane width", () => {
  const instance = blankInstance();
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const rows = Array.from({ length: 10 }, (_, index) => ({
    day: "2024-01-10",
    model: `model-${index}`,
    provider: "p-one",
    tokens: { input: 100 - index, output: 10 },
  }));
  const leaders = analytics.leaderboard(rows, null, { groupBy: "model", includeCache: true });

  const grid = instance.leaderboardCard(c, leaders, { label: "All time" }).childNodes[1];
  assert.equal(grid.style.flexWrap, "wrap", "columns wrap instead of using a width breakpoint");
  assert.deepEqual(grid.childNodes.map((column) => column.childNodes.length), [5, 5]);
  for (const column of grid.childNodes) {
    assert.equal(column.style.flexBasis, 300, "preferred width controls wrapping");
    assert.equal(column.style.flexGrow, 1, "columns share remaining space");
    assert.equal(column.style.minWidth, 0, "a column can shrink below its basis in narrow split panes");
  }

  const single = analytics.leaderboard(rows.slice(0, 1), null, { groupBy: "model", includeCache: true });
  const singleGrid = instance.leaderboardCard(c, single, { label: "All time" }).childNodes[1];
  assert.equal(singleGrid.childNodes.length, 1, "an empty second column is not rendered");
});

test("loading state shows live scan progress and scan status lives in settings", () => {
  assert.doesNotMatch(mainSource, /Reading local session history|collector and presentation helper|Preparing the compact dashboard|Initializing the native source|bottomGrid/);
  assert.match(mainSource, /children\(\[preferences, sources, scan, json\]\)/);

  const instance = blankInstance();
  instance.loading = true;
  instance.scanProgress = { processed: 42, total: 1183, file: "/home/u/.codex/sessions/a.jsonl" };
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const card = instance.initialState(c);
  assert.deepEqual(card.childNodes[1].childNodes, ["Scanning 42 of 1,183 files"]);
  assert.deepEqual(card.childNodes[2].childNodes, ["/home/u/.codex/sessions/a.jsonl"]);

  instance.scanProgress = null;
  const quiet = instance.initialState(c);
  assert.equal(quiet.childNodes.length, 1, "no static body or detail while progress is unknown");
});

test("model chart card renders stacked weekly bars, axis labels and a legend", () => {
  const instance = blankInstance();
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const rows = [
    { day: "2024-01-02", model: "model-a", tokens: { input: 100, output: 0 } },
    { day: "2024-01-09", model: "model-b", tokens: { input: 300, output: 0 } },
    { day: "2024-01-09", model: "model-a", tokens: { input: 100, output: 0 } },
  ];
  const series = analytics.buildModelSeries(rows, { endDay: "2024-01-14", weeks: 4, weekStartsOn: 0 });
  assert.equal(series.weeks.length, 4);
  assert.equal(series.maxTotal, 400);

  const card = instance.modelChartCard(c, series);
  const chart = card.childNodes[1];
  const barsRow = chart.childNodes[0].childNodes[1];
  assert.equal(barsRow.childNodes.length, 4, "one column per week");
  const tallest = barsRow.childNodes[2];
  assert.equal(tallest.childNodes.length, 1, "active week has a stacked column");
  assert.equal(tallest.childNodes[0].childNodes.length, 2, "two models stack in one week");
  const legend = chart.childNodes[2];
  assert.equal(legend.childNodes.length, series.models.length, "one legend entry per model");
});

test("stat grids top-align rows when optional notes change sibling heights", () => {
  const instance = blankInstance();
  const c = ui.tokens({
    background: "#101010",
    surface: "#181818",
    border: "#333333",
    foreground: "#f5f5f5",
    muted: "#9a9a9a",
    dim: "#707070",
    accent: "#5aa7ff",
  });
  const totals = {
    total: 1200, input: 800, output: 300, reasoning: 100, cacheRead: 100, cacheWrite: 0,
    sessions: 2, messages: 3, longestTaskMs: 4000,
  };
  const heatmap = buildHeatmap([], { endDay: "2024-01-20", weeks: 3, weekStartsOn: 0 });
  const detail = instance.tokenDetailCard(c, heatmap, "2024-01-10", "2024-01-20", totals, {
    name: "model-a",
    sublabel: "provider-a",
  }, totals, { name: "model-b", sublabel: "provider-b" });
  const snapshot = savedSnapshot();
  const status = instance.statusCard(c, snapshot, snapshot.config);
  const allTimeColumn = detail.childNodes[0].childNodes[0];
  const todayColumn = detail.childNodes[0].childNodes[1];
  const statRows = [
    allTimeColumn.childNodes[1],
    todayColumn.childNodes[1],
    status.childNodes[1],
  ];

  for (const row of statRows) {
    assert.equal(row.style.alignItems, "start");
  }
  assert.deepEqual(
    allTimeColumn.childNodes[1].childNodes.map((cell) => cell.childNodes[0].childNodes[0]),
    ["INPUT", "OUTPUT", "CACHE HIT RATE", "TOP MODEL"],
    "the detail card keeps only input, output, hit rate and top model",
  );
  assert.deepEqual(allTimeColumn.childNodes[0].childNodes, ["ALL TIME"]);

  const noted = statRows[0].childNodes.filter((cell) => cell.childNodes.length === 3);
  assert.equal(noted.length, 0, "the detail card shows values only, no notes");
  assert.equal(statRows[1].childNodes.every((cell) => cell.childNodes.length === 2), true);
  assert.equal(statRows[2].childNodes.every((cell) => cell.childNodes.length === 2), true);
});

test("cache hit rate is a share of input-side tokens", () => {
  assert.equal(analytics.formatHitRate(100, 900), "90%");
  assert.equal(analytics.formatHitRate(0, 0), "—");
  assert.equal(analytics.formatHitRate(200, 0), "0%");
});

test("initial async snapshot publishes the dashboard before settings host controls exist", async () => {
  globalThis.__insightsTestHostCalls = { inputStates: 0, editorStates: 0 };
  const state = useHerdr({ readTextFile: () => JSON.stringify({ node: "/test/node" }) });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  const notifications = [];
  const notify = cx.notify.bind(cx);
  cx.notify = () => {
    notifications.push({ dashboard: instance.dashboard?.period ?? null, loading: instance.loading });
    notify();
  };
  instance.init({}, cx);

  assert.equal(instance.refreshInput, null);
  assert.equal(instance.configEditor, null);
  assert.equal(instance.sourceInputs.size, 0);

  await flush();
  await flush();
  await flush();

  assert.equal(state.execCalls.length, 1);
  assert.equal(instance.snapshot?.rowCount, 0);
  assert.equal(instance.dashboard?.period, "all");
  assert.equal(instance.dashboardKey !== null, true);
  assert.equal(instance.refreshInput, null, "dashboard refresh must not create the refresh input");
  assert.equal(instance.configEditor, null, "dashboard refresh must not create the JSON editor");
  assert.equal(instance.sourceInputs.size, 0, "dashboard refresh must not create source inputs");
  assert.deepEqual(globalThis.__insightsTestHostCalls, { inputStates: 0, editorStates: 0 });
  assert.equal(calls.notify > 0, true);
  assert.deepEqual(notifications.at(-1), { dashboard: "all", loading: false });

  instance.openSettings(cx);
  assert.equal(instance.refreshInput !== null, true);
  assert.equal(instance.configEditor !== null, true);
  assert.equal(instance.sourceInputs.size, 1);
  assert.deepEqual(globalThis.__insightsTestHostCalls, { inputStates: 2, editorStates: 1 });
  assert.match(instance.configEditor.value(), /"refreshSeconds": 60/);
  instance.close();
});

test("form saves preserve the legacy profile and multi-root source mappings", () => {
  const instance = blankInstance();
  const saved = savedSnapshot();
  const profile = { name: "Legacy Name", handle: "legacy", avatar: "mods/insights/legacy.png" };
  const mapping = { session: "session.id", timestamp: "ts", usage: { input: "usage.input" } };
  saved.config.profile = profile;
  saved.config.sources = [{
    id: "codex",
    label: "Codex",
    adapter: "codex",
    enabled: true,
    roots: ["~/.codex/sessions", "~/.codex/archived_sessions"],
    mapping,
  }];
  Object.assign(instance, {
    snapshot: saved,
    configDirty: true,
    editorDirty: false,
    rootsDirty: false,
    refreshDirty: true,
    configDraft: JSON.parse(JSON.stringify(saved.config)),
    sourceInputs: new Map(),
    syncingInputs: false,
    refreshInput: { value: () => "120" },
    configEditor: { value: () => JSON.stringify(saved.config), set_value() {}, on() {} },
  });
  instance.ensureSourceInputs(instance.configDraft);
  const state = instance.sourceInputs.get("codex");
  assert.equal(state.value(), "~/.codex/sessions, ~/.codex/archived_sessions");
  const config = instance.buildConfigForSave();
  assert.deepEqual(config.profile, profile);
  assert.deepEqual(config.sources[0].roots, ["~/.codex/sessions", "~/.codex/archived_sessions"]);
  assert.deepEqual(config.sources[0].mapping, mapping);
  assert.equal(config.refreshSeconds, 120);
});

test("background snapshots leave closed settings drafts and host inputs untouched", async () => {
  const draft = configDraft();
  const customState = {
    value: "~/custom",
    released: false,
    writes: 0,
    set_value(value) { this.writes += 1; this.value = String(value); },
    on() {},
  };
  const instance = blankInstance();
  Object.assign(instance, {
    showSettings: false,
    configDirty: true,
    editorDirty: false,
    rootsDirty: false,
    refreshDirty: false,
    configDraft: draft,
    sourceInputs: new Map([["custom", customState]]),
    refreshInput: { writes: 0, set_value() { this.writes += 1; }, value: () => "120" },
    configEditor: { writes: 0, value: () => JSON.stringify(draft), set_value() { this.writes += 1; }, on() {} },
    setEditorText() { this.editorTextWrites = (this.editorTextWrites ?? 0) + 1; },
    schedule() { this.scheduleCalls = (this.scheduleCalls ?? 0) + 1; },
    scheduleDashboard() { this.dashboardUpdates = (this.dashboardUpdates ?? 0) + 1; },
  });

  instance.applySnapshot(presentationFor(savedSnapshot(), instance.dashboardOptions()), fakeCx());
  assert.equal(instance.sourceInputs.has("custom"), true);
  assert.equal(instance.sourceInputs.has("saved"), false);
  assert.equal(instance.sourceInputs.get("custom"), customState);
  assert.equal(customState.released, false);
  assert.equal(customState.writes, 0);
  assert.deepEqual(instance.configDraft.sources[0].mapping, { input: "usage.input" });
  assert.deepEqual(instance.configDraft.sources[0].extra, { keep: true });
  assert.deepEqual(instance.configDraft.customTopLevel, { keep: true });
  assert.equal(instance.editorTextWrites ?? 0, 0);
  assert.equal(instance.refreshInput.writes, 0);
  assert.equal(instance.configEditor.writes, 0);
  assert.equal(instance.scheduleCalls, 1);

  const editorInstance = blankInstance();
  const savedState = {
    value: "~/saved",
    released: false,
    writes: 0,
    set_value(value) { this.writes += 1; this.value = String(value); },
    release() { this.released = true; },
    on() {},
  };
  Object.assign(editorInstance, {
    showSettings: false,
    configDirty: false,
    editorDirty: true,
    rootsDirty: false,
    refreshDirty: false,
    configDraft: JSON.parse(JSON.stringify(savedSnapshot().config)),
    sourceInputs: new Map([["saved", savedState]]),
    refreshInput: { writes: 0, set_value() { this.writes += 1; }, value: () => "60" },
    configEditor: { writes: 0, value: () => JSON.stringify(draft), set_value() { this.writes += 1; }, on() {} },
    setEditorText() { this.editorTextWrites = (this.editorTextWrites ?? 0) + 1; },
    schedule() { this.scheduleCalls = (this.scheduleCalls ?? 0) + 1; },
    scheduleDashboard() { this.dashboardUpdates = (this.dashboardUpdates ?? 0) + 1; },
  });

  editorInstance.applySnapshot(presentationFor(savedSnapshot(), editorInstance.dashboardOptions()), fakeCx());
  assert.equal(editorInstance.sourceInputs.has("saved"), true);
  assert.equal(savedState.released, false);
  assert.equal(savedState.writes, 0);
  assert.equal(editorInstance.configEditor.value(), JSON.stringify(draft));
  assert.equal(editorInstance.editorTextWrites ?? 0, 0);

  // Reopening Settings after a closed background refresh must reuse the dirty draft.
  instance.showSettings = true;
  const { cx } = liveCx();
  instance.applySnapshot(presentationFor(savedSnapshot(), instance.dashboardOptions()), cx);
  await flush();
  await flush();
  assert.equal(instance.sourceInputs.get("custom"), customState);
  assert.equal(customState.released, false);
  assert.deepEqual(instance.configDraft.sources[0].mapping, { input: "usage.input" });
  assert.equal(instance.editorTextWrites ?? 0, 0);
  assert.equal(instance.configEditor.writes, 0);
});

test("async presentation refresh clears busy state and exposes a finite error", async () => {
  const state = useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: () => ({ code: 1, stdout: "", stderr: "scan failed" }),
  });
  const { cx } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  await flush();
  assert.equal(state.execCalls.length, 1);
  assert.equal(instance.loading, false);
  assert.equal(instance.busy(), false);
  assert.match(instance.error, /scan failed/);
  assert.equal(instance.snapshot, null);
  instance.close();
});

test("filter changes coalesce while a presentation prepare is in flight", async () => {
  const { todayKey } = analytics;
  const today = todayKey();
  const snapshot = savedSnapshot();
  snapshot.generatedAt = `${today}T12:00:00Z`;
  snapshot.lastScanAt = snapshot.generatedAt;
  snapshot.rows = [{
    day: today,
    session: "session-a",
    harness: "saved",
    provider: "provider",
    model: "model",
    project: "/tmp/project",
    tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 120 },
    messages: 1,
    activeMs: 1000,
    longestTaskMs: 1000,
  }];
  const pending = [];
  const state = useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: (command, args) => {
      if (args[1] === "prepare") {
        return new Promise((resolve) => {
          pending.push({ options: optionArgument(args), resolve });
        });
      }
      return { code: 0, stdout: JSON.stringify(presentationFor(snapshot, optionArgument(args), args[1])), stderr: "" };
    },
  });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  assert.equal(state.execCalls.length, 1);
  assert.equal(instance.dashboard?.period, "all");
  assert.equal(instance.loading, false);

  instance.setPeriod("week", cx);
  await calls.runAfter();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].options.period, "week");
  assert.equal(instance.dashboardPending !== null, true);

  instance.setPeriod("month", cx);
  assert.equal(instance.dashboardQueued, true);
  const first = pending.shift();
  first.resolve({ code: 0, stdout: JSON.stringify(presentationFor(snapshot, first.options, "prepare")), stderr: "" });
  await flush();
  await flush();
  assert.equal(instance.dashboard?.period, "all", "a stale prepare must never replace the current filter result");
  assert.equal(calls.after.filter((timer) => !timer.cancelled).length, 1, "the latest filter is prepared next");

  await calls.runAfter();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].options.period, "month");
  const latest = pending.shift();
  latest.resolve({ code: 0, stdout: JSON.stringify(presentationFor(snapshot, latest.options, "prepare")), stderr: "" });
  await flush();
  await flush();

  assert.equal(instance.dashboard?.period, "month");
  assert.equal(instance.dashboardPending, null);
  assert.equal(instance.dashboardQueued, false);
  assert.equal(instance.dashboardError, null);
  instance.close();
});

test("a failed prepare leaves the old dashboard and a retryable error", async () => {
  const { todayKey } = analytics;
  const snapshot = savedSnapshot();
  snapshot.generatedAt = `${todayKey()}T12:00:00Z`;
  snapshot.lastScanAt = snapshot.generatedAt;
  let failPrepare = true;
  const state = useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: (command, args) => {
      if (args[1] === "prepare" && failPrepare) {
        return { code: 1, stdout: "", stderr: "prepare failed" };
      }
      return { code: 0, stdout: JSON.stringify(presentationFor(snapshot, optionArgument(args), args[1])), stderr: "" };
    },
  });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  assert.equal(state.execCalls.length, 1);

  instance.setPeriod("week", cx);
  await calls.runAfter();
  await flush();
  await flush();
  assert.match(instance.dashboardError, /prepare failed/);
  assert.equal(instance.dashboardPending, null);
  assert.equal(instance.dashboardTask, null);
  assert.equal(instance.dashboard?.period, "all");

  failPrepare = false;
  instance.scheduleDashboard(cx, { force: true });
  await calls.runAfter();
  await flush();
  await flush();
  assert.equal(instance.dashboardError, null);
  assert.equal(instance.dashboard?.period, "week");
  assert.equal(instance.dashboardPending, null);
  instance.close();
});

test("partial scan continuation reschedules while busy and stops on close", async () => {
  const { cx, calls } = liveCx();
  const instance = blankInstance();
  instance.sourceInputs = new Map();
  instance.refreshInput = null;
  instance.configEditor = null;
  const refreshes = [];
  instance.refresh = (timerCx) => refreshes.push(timerCx);
  instance.snapshot = { ...savedSnapshot(), scan: { status: "partial", processed: 1, total: 3 } };

  instance.saving = true;
  instance.scheduleScanContinue(cx);
  assert.equal(calls.after.length, 1);
  await calls.runAfter();
  assert.equal(refreshes.length, 0, "a busy tick must not drop the continuation");
  assert.equal(calls.after.filter((timer) => !timer.cancelled).length, 1, "the timer reschedules");

  instance.saving = false;
  instance.loading = false;
  await calls.runAfter();
  assert.equal(refreshes.length, 1, "the continuation runs once the save finishes");

  instance.snapshot.scan = { status: "partial", processed: 2, total: 3 };
  instance.scheduleScanContinue(cx);
  const pending = calls.after.filter((timer) => !timer.cancelled);
  assert.equal(pending.length, 1);
  instance.close();
  assert.equal(pending[0].cancelled, true, "close cancels the pending continuation");
  await calls.runAfter();
  assert.equal(refreshes.length, 1, "a closed view never refreshes again");
});

test("watching a background index backs off instead of polling every second", () => {
  const { cx, calls } = liveCx();
  const instance = blankInstance();
  instance.sourceInputs = new Map();
  instance.refreshInput = null;
  instance.configEditor = null;
  instance.refresh = () => {};
  instance.snapshot = { ...savedSnapshot(), scan: { status: "running", processed: 1, total: 3 } };
  const delays = [];
  for (let streak = 1; streak <= 5; streak += 1) {
    instance.scanWaitStreak = streak;
    instance.cancelScanContinue();
    instance.scheduleScanContinue(cx);
    delays.push(calls.after.filter((timer) => !timer.cancelled).at(-1).ms);
  }
  assert.deepEqual(delays, [2_000, 4_000, 8_000, 10_000, 10_000]);
  instance.snapshot.scan = { status: "partial", processed: 2, total: 3 };
  instance.scanWaitStreak = 0;
  instance.cancelScanContinue();
  instance.scheduleScanContinue(cx);
  assert.equal(calls.after.filter((timer) => !timer.cancelled).at(-1).ms, 250, "foreground slices continue at once");
  instance.close();
});

test("settings sync releases its slot even when spawn runs the body at once", () => {
  const instance = blankInstance();
  instance.sourceInputs = new Map();
  instance.refreshInput = null;
  instance.configEditor = null;
  instance.showSettings = true;
  let syncs = 0;
  instance.syncSettingsControls = () => { syncs += 1; };
  const eagerCx = {
    notify() {},
    spawn(fn) { fn(eagerCx); return { cancel() {} }; },
  };
  instance.scheduleSettingsSync(eagerCx);
  instance.scheduleSettingsSync(eagerCx);
  instance.scheduleSettingsSync(eagerCx);
  assert.equal(syncs, 3, "every request runs; none is parked behind a finished task");
  assert.equal(instance.settingsTask, null);
  assert.equal(instance.settingsQueued ?? false, false);
  instance.close();
});

test("a selection following today moves at midnight and on New Year; a picked one stays", () => {
  const instance = blankInstance();
  instance.lastToday = "2026-12-31";
  instance.selectedDay = "2026-12-31";
  instance.year = 2026;
  instance.years = [2026, 2025];
  instance.followToday("2027-01-01");
  assert.equal(instance.selectedDay, "2027-01-01");
  assert.equal(instance.year, 2027);
  assert.deepEqual(instance.years, [2027, 2026, 2025]);

  instance.selectedDay = "2026-06-01";
  instance.year = 2026;
  instance.followToday("2027-01-02");
  assert.equal(instance.selectedDay, "2026-06-01", "a day the person picked stays");
  assert.equal(instance.year, 2026, "a year the person picked stays");
});

test("a Node path that can no longer start falls back to node on PATH", async () => {
  const state = useHerdr({
    execResult: (command) => {
      if (command === "/gone/node") throw new Error("cannot start /gone/node: program not found");
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  const instance = blankInstance();
  instance.nodeBinary = "/gone/node";
  const result = await instance.execNode(["presenter.mjs"], { timeout: 1_000 });
  assert.equal(result.stdout, "ok");
  assert.deepEqual(state.execCalls.map((call) => call.command), ["/gone/node", "node"]);
  assert.equal(instance.nodeBinary, "node", "later helpers use the working node");

  instance.nodeBinary = "/slow/node";
  useHerdr({ execResult: () => { throw new Error("timed out"); } });
  await assert.rejects(instance.execNode([], {}), /timed out/, "other failures are not retried");
});

test("a prepare error without a dashboard is shown once, not as a banner and a card", () => {
  useHerdr();
  const instance = blankInstance();
  instance.snapshot = savedSnapshot();
  instance.dashboard = null;
  instance.dashboardError = "prepare failed: boom";
  const texts = [];
  const walk = (node) => {
    if (typeof node === "string") texts.push(node);
    for (const child of node?.childNodes ?? []) walk(child);
  };
  walk(instance.render());
  assert.equal(texts.filter((text) => text === "prepare failed: boom").length, 1);
});

test("an unknown period command leaves the period unchanged", () => {
  useHerdr();
  const instance = blankInstance();
  instance.period = "month";
  let scheduled = 0;
  instance.scheduleDashboard = () => { scheduled += 1; };
  instance.setPeriod("fortnight", liveCx().cx);
  assert.equal(instance.period, "month");
  assert.equal(scheduled, 0);
  instance.setPeriod("week", liveCx().cx);
  assert.equal(instance.period, "week");
  assert.equal(scheduled, 1);
});

test("a hung prepare times out into a retryable dashboard error", async () => {
  const { todayKey } = analytics;
  const snapshot = savedSnapshot();
  snapshot.generatedAt = `${todayKey()}T12:00:00Z`;
  snapshot.lastScanAt = snapshot.generatedAt;
  let hang = true;
  useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: (command, args) => {
      if (args[1] === "prepare" && hang) return new Promise(() => {});
      return { code: 0, stdout: JSON.stringify(presentationFor(snapshot, optionArgument(args), args[1])), stderr: "" };
    },
  });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  instance.setPeriod("week", cx);
  await calls.runAfter();
  assert.equal(instance.dashboardPending !== null, true);
  assert.equal(instance.dashboardTask !== null, true);

  await calls.runAfter();
  await flush();
  assert.match(instance.dashboardError, /timed out/);
  assert.equal(instance.dashboardPending, null);
  assert.equal(instance.dashboardTask, null);
  assert.equal(instance.dashboardQueued, false);

  hang = false;
  instance.scheduleDashboard(cx, { force: true });
  await calls.runAfter();
  await flush();
  await flush();
  assert.equal(instance.dashboardError, null);
  assert.equal(instance.dashboard?.period, "week");
  instance.close();
});

for (const kind of ["refresh", "save"]) {
  test(`late ${kind} completion cannot overwrite a retry or clear its busy state`, async () => {
    const pending = [];
    useHerdr({ execResult: (_command, args) => new Promise((resolve) => {
      pending.push({ resolve, options: optionArgument(args) });
    }) });
    const { cx, calls } = liveCx();
    const instance = blankInstance();
    instance.buildConfigForSave = () => savedSnapshot().config;
    const start = () => kind === "refresh" ? instance.refresh(cx) : instance.saveConfig(cx);
    start();
    await flush();
    assert.equal(pending.length, 1);
    const watchdog = calls.after.find((timer) => timer.ms === (kind === "refresh" ? 50_000 : 65_000) && !timer.cancelled);
    watchdog.fn();
    assert.equal(instance.busy(), false);
    start();
    await flush();
    assert.equal(pending.length, 2);
    const first = pending[0];
    first.resolve({ code: 0, stdout: JSON.stringify(presentationFor(savedSnapshot(), first.options)), stderr: "" });
    await flush();
    assert.equal(instance.busy(), true, "stale finally must not clear retry flags");
    assert.equal(instance.snapshot, null, "stale data must not publish");
    const second = pending[1];
    second.resolve({ code: 0, stdout: JSON.stringify(presentationFor(savedSnapshot(), second.options)), stderr: "" });
    await flush();
    assert.equal(instance.busy(), false);
    assert.ok(instance.snapshot);
  });
}

for (const editKind of ["toggle", "editor", "invalid editor", "roots", "refresh interval"]) {
  test(`newer ${editKind} edits survive an in-flight configuration save`, async () => {
    let finish;
    let options;
    useHerdr({ execResult: (_command, args) => {
      options = optionArgument(args);
      return new Promise((resolve) => { finish = resolve; });
    } });
    const { cx } = liveCx();
    const instance = blankInstance();
    instance.sourceInputs = new Map();
    instance.configDraft = structuredClone(savedSnapshot().config);
    instance.configText = JSON.stringify(instance.configDraft);
    instance.configEditor = globalThis.__insightsTestEditorState.new({ value: instance.configText });
    instance.ensureSourceInputs(instance.configDraft);
    instance.configDirty = true;
    instance.saveConfig(cx);
    await flush();
    if (editKind === "toggle") instance.updateDraft((draft) => { draft.palette = "green"; });
    else if (editKind.includes("editor")) {
      instance.configEditor.set_value(editKind === "invalid editor" ? "{unfinished" : JSON.stringify({ ...instance.configDraft, palette: "purple" }));
      instance.editorDirty = true;
      instance.configDirty = true;
    } else if (editKind === "roots") {
      instance.sourceInputs.values().next().value.set_value("/new/root");
      instance.rootsDirty = true;
    } else {
      instance.refreshInput = globalThis.__insightsTestInputState.new({ value: "300" });
      instance.refreshDirty = true;
    }
    const newer = instance.draftSignature();
    finish({ code: 0, stdout: JSON.stringify(presentationFor(savedSnapshot(), options, "configure")), stderr: "" });
    await flush();
    assert.equal(instance.configDirty, true);
    assert.equal(instance.draftSignature(), newer);
    assert.match(instance.saveMessage, /Newer edits are still unsaved/);
    instance.close();
  });
}

test("Retry resolves a repaired runtime configuration without reopening the view", async () => {
  let reads = 0;
  const state = useHerdr({ readTextFile: () => ++reads === 1 ? "{invalid" : JSON.stringify({ node: "/test/node" }) });
  const { cx } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);
  await flush();
  assert.ok(instance.runtimeError);
  assert.equal(state.execCalls.length, 0);
  instance.refresh(cx);
  await flush();
  await flush();
  assert.equal(reads, 2);
  assert.equal(instance.runtimeError, null);
  assert.ok(instance.snapshot);
  instance.close();
});

test("closing a view invalidates a refresh even if its host exec resolves late", async () => {
  let finish;
  let options;
  useHerdr({ execResult: (_command, args) => {
    options = optionArgument(args);
    return new Promise((resolve) => { finish = resolve; });
  } });
  const { cx, calls } = liveCx();
  const instance = blankInstance();
  instance.sourceInputs = new Map();
  instance.refresh(cx);
  await flush();
  instance.close();
  const notified = calls.notify;
  finish({ code: 0, stdout: JSON.stringify(presentationFor(savedSnapshot(), options)), stderr: "" });
  await flush();
  assert.equal(instance.snapshot, null);
  assert.equal(calls.notify, notified);
});

test("malformed compact dashboards become a retryable error, never render state", async () => {
  useHerdr({ execResult: (_command, args) => {
    const payload = presentationFor(savedSnapshot(), optionArgument(args));
    payload.dashboard = {};
    return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
  } });
  const { cx } = liveCx();
  const instance = blankInstance();
  instance.refresh(cx);
  await flush();
  assert.equal(instance.snapshot, null);
  assert.equal(instance.busy(), false);
  assert.match(instance.error, /unexpected|invalid/i);
});

test("scan progress awaits the host read and ignores results after cancellation", async () => {
  let resolveRead;
  useHerdr({ readTextFile: () => new Promise((resolve) => { resolveRead = resolve; }) });
  const instance = blankInstance();
  instance.loading = true;
  const { cx, calls } = liveCx();
  instance.armProgress(cx);
  calls.timers[0].fn(cx);
  await flush();
  resolveRead(JSON.stringify({ processed: 3, total: 10, file: "/session.jsonl" }));
  await flush();
  assert.equal(instance.scanProgress.processed, 3);
  calls.timers[0].fn(cx);
  await flush();
  instance.cancelProgress();
  resolveRead(JSON.stringify({ processed: 4, total: 10, file: "/old.jsonl" }));
  await flush();
  assert.equal(instance.scanProgress, null);
  assert.equal(instance.progressTask, null);
});

test("progress poll merges mid-file stream state, keeps counts, and stops when settled", async () => {
  const state = useHerdr({
    readTextFile: async () => JSON.stringify({
      file: "/tmp/open-giant.jsonl.zst",
      decodedBytes: 4096,
      rows: [{ injected: true }],
      config: { injected: true },
    }),
  });
  const instance = blankInstance();
  instance.sourceInputs = new Map();
  instance.loading = true;
  const { cx, calls } = liveCx();
  instance.armProgress(cx);
  instance.scanProgress = { processed: 7, total: 11, file: "/tmp/previous.jsonl" };
  calls.timers[0].fn(cx);
  await flush();
  assert.equal(instance.scanProgress.processed, 7, "stream progress keeps accepted counts");
  assert.equal(instance.scanProgress.total, 11);
  assert.equal(instance.scanProgress.decodedBytes, 4096);
  assert.equal(instance.scanProgress.file, "/tmp/open-giant.jsonl.zst");
  assert.equal(instance.scanProgress.rows, undefined, "only display metadata is accepted");
  assert.equal(instance.scanProgress.config, undefined);

  instance.loading = false;
  calls.timers[0].fn(cx);
  await flush();
  assert.equal(instance.scanProgress, null, "completion stops and clears the poll");
  assert.equal(instance.progressTimer, null);
  const reads = state.runtimeReads.length;
  calls.timers[0].fn(cx);
  await flush();
  assert.equal(state.runtimeReads.length, reads, "a settled poll never reads again");

  instance.loading = true;
  instance.armProgress(cx);
  instance.close();
  assert.equal(instance.scanProgress, null, "close cancels in-flight progress");
  assert.equal(instance.progressTimer, null);
});

test("running worker status shows current file and decoded bytes", () => {
  const instance = blankInstance();
  const label = instance.scanStatusLabel({
    status: "running",
    processed: 2,
    total: 10,
    live: {
      file: "/home/u/.codex/sessions/open-giant.jsonl.zst",
      processed: 3,
      total: 10,
      decodedBytes: 123_456,
      phase: "decompress",
    },
  });
  assert.match(label, /Indexing 3 of 10 files/);
  assert.match(label, /open-giant\.jsonl\.zst/, "the live file is visible");
  assert.match(label, /decoded/, "in-progress decoded bytes are visible");
});

test("leaderboard change labels show one sign: the arrow", () => {
  assert.match(mainSource, /const magnitude = String\(entry\.change\.label\)\.replace\(\/\^\[\+-\]\/, ""\);/);
  assert.match(mainSource, /return `↑\$\{magnitude\}`;/);
  assert.match(mainSource, /return `↓\$\{magnitude\}`;/);
});
