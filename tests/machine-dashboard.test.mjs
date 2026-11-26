import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CACHE_SCRIPT } from "../mods/insights/core/fleet.mjs";
import { emptyStore, newFileEntry, saveStore } from "../mods/insights/core/store.mjs";
import { run } from "../mods/insights/presenter.mjs";

const TODAY = "2026-11-23";
const LOCAL_PRIVATE = "/local/private/config";
const REMOTE_PRIVATE = "/remote/private/config";
const session = "shared-session";
const storeOptions = { today: TODAY, selectedDay: TODAY, period: "week" };
const presenter = fileURLToPath(new URL("../mods/insights/presenter.mjs", import.meta.url));

function row(input, day = TODAY, overrides = {}) {
  return {
    day, session, harness: "codex", provider: "openai", model: "shared-model", project: "/work/shared",
    tokens: { input, cacheRead: 100 }, messages: 1, ...overrides,
  };
}

function cache(rows, savedAt = new Date().toISOString(), overrides = {}) {
  return {
    version: 2, rows, savedAt,
    config: { includeCache: true, weekStartsOn: 0, refreshSeconds: 300, sources: [{ roots: [REMOTE_PRIVATE] }] },
    scan: { error: REMOTE_PRIVATE },
    ...overrides,
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "insights-machine-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "insights.json");
  const store = emptyStore({
    includeCache: false, weekStartsOn: 1,
    sources: [{ id: "codex", label: "Codex", adapter: "codex", enabled: true, roots: [LOCAL_PRIVATE] }],
  });
  const entry = newFileEntry(store, {
    sourceId: "codex", path: `${LOCAL_PRIVATE}/session`, adapter: "codex", size: 0, mtimeMs: 0,
  });
  const { tokens, ...data } = row(10);
  entry.rows.push({ ...data, ...tokens });
  await saveStore(file, store);
  return { dir, file };
}

function args(file, options) {
  return ["machine-dashboard", "--store", file, "--options", JSON.stringify(options)];
}

async function view(file, options, machineExec) {
  const result = await run(args(file, { ...storeOptions, ...options }), { machineExec });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\/(local|remote)\/private\/config|shared-session/);
  return JSON.parse(result.stdout);
}

test("All combines readable hosts, preserves group labels, and counts colliding sessions by host", async (t) => {
  const { file } = await fixture(t);
  const seen = [];
  const result = await view(file, {
    scope: { kind: "all" }, remoteNames: ["old", "linux", "bad", "linux"],
  }, async (command, argv, { on, timeout }) => {
    assert.equal(command, "sh");
    assert.deepEqual(argv, ["-c", CACHE_SCRIPT]);
    assert.equal(timeout, 6000);
    seen.push(on);
    if (on === "bad") return { code: 3, stdout: "", stderr: REMOTE_PRIVATE };
    if (on === "old") return { code: 0, stdout: JSON.stringify(cache([row(3)], "2020-01-01T00:00:00Z")) };
    return { code: 0, stdout: JSON.stringify(cache([row(20), row(5)])) };
  });
  assert.deepEqual(seen.sort(), ["bad", "linux", "old"]);
  assert.equal(result.kind, "insights-machine-dashboard");
  assert.deepEqual(result.scope, { kind: "all" });
  assert.equal(result.dashboard.totals.total, 38);
  assert.equal(result.dashboard.totals.sessions, 3);
  assert.equal(result.dashboard.selectedTotals.sessions, 3);
  assert.deepEqual(result.dashboard.modelSeries.models, ["shared-model"]);
  assert.equal(result.dashboard.modelSeries.windowTotal, 38);
  assert.deepEqual(result.dashboard.machineSeries.machines, ["linux", null, "old"]);
  assert.equal(result.dashboard.machineSeries.windowTotal, 38);
  assert.deepEqual(result.dashboard.machineSeries.weeks, [{
    start: TODAY, total: 38, segments: [
      { name: "linux", tokens: 25 }, { name: null, tokens: 10 }, { name: "old", tokens: 3 },
    ],
  }]);
  assert.equal(result.dashboard.facets.project.stats[0].sessions, 3);
  assert.equal(result.dashboard.leaders.entries[0].name, "shared-model");
  assert.deepEqual(result.dashboard.config, { includeCache: false, weekStartsOn: 1 });
  assert.equal(result.dashboard.rows, undefined);
  assert.deepEqual(result.coverage.machines.map(({ name, status, reason }) => [name, status, reason]), [
    [null, "fresh", null], ["bad", "unavailable", "no cache on that machine"],
    ["linux", "fresh", null], ["old", "stale", null],
  ]);
  const { total, readable, stale, partial } = result.coverage;
  assert.deepEqual({ total, readable, stale, partial }, { total: 4, readable: 3, stale: 1, partial: true });
});

test("All host history follows the same period, facets and cache inclusion as aggregate history", async (t) => {
  const { file } = await fixture(t);
  const remoteRows = [
    row(20), row(3, "2026-11-16"), row(400, TODAY, { model: "other-model" }),
    row(500, TODAY, { provider: "other-provider" }),
  ];
  const exec = async () => ({ code: 0, stdout: JSON.stringify(cache(remoteRows)) });
  const options = {
    scope: { kind: "all" }, remoteNames: ["linux"], period: "month",
    filters: { model: "shared-model", provider: "openai" },
  };
  const { dashboard } = await view(file, options, exec);
  const { machineSeries, modelSeries } = dashboard;
  assert.equal(machineSeries.windowTotal, 33);
  assert.equal(dashboard.totals.total, 33);
  assert.equal(dashboard.selectedTotals.total, 30);
  assert.equal(dashboard.leaders.totalTokens, 33);
  assert.deepEqual(machineSeries.weeks.map(({ start, total }) => [start, total]),
    modelSeries.weeks.map(({ start, total }) => [start, total]));
  assert.deepEqual(machineSeries.weeks.filter(({ total }) => total > 0).map(({ start, segments }) => [start, segments]), [
    ["2026-11-16", [{ name: "linux", tokens: 3 }]],
    [TODAY, [{ name: "linux", tokens: 20 }, { name: null, tokens: 10 }]],
  ]);

  const cached = await view(file, { ...options, period: "week", includeCache: true }, exec);
  assert.equal(cached.dashboard.heatmap.weeks.at(-1).days.find(({ date }) => date === TODAY).daily, 230);
  assert.equal(cached.dashboard.selectedTotals.sessions, 2);
  assert.equal(cached.dashboard.machineSeries.includeCache, true);
  assert.equal(cached.dashboard.machineSeries.windowTotal, 230);
  assert.deepEqual(cached.dashboard.machineSeries.weeks.at(-1).segments, [
    { name: "linux", tokens: 120 }, { name: null, tokens: 110 },
  ]);
});

test("All keeps every contributing host by route instead of folding it into Other", async (t) => {
  const { file } = await fixture(t);
  const remoteNames = ["local", "null", "unknown", "other", "east", "west", "north", "south"];
  const { dashboard } = await view(file, { scope: { kind: "all" }, remoteNames }, async () =>
    ({ code: 0, stdout: JSON.stringify(cache([row(1)])) }));
  assert.deepEqual(new Set(dashboard.machineSeries.machines), new Set([null, ...remoteNames]));
  assert.deepEqual(new Set(dashboard.machineSeries.weeks.at(-1).segments.map(({ name }) => name)),
    new Set([null, ...remoteNames]));
  assert.equal(dashboard.machineSeries.windowTotal, 18);
});

test("Local matches the original compact analytics without remote calls; remote applies viewer options", async (t) => {
  const { file } = await fixture(t);
  const before = await readFile(file, "utf8");
  const local = await view(file, { scope: { kind: "local" }, remoteNames: ["linux"] },
    () => assert.fail("Local must not request a remote"));
  const baseline = JSON.parse((await run(["prepare", "--store", file, "--options", JSON.stringify(storeOptions)])).stdout);
  assert.deepEqual(local.dashboard, { ...baseline.dashboard, config: local.dashboard.config });
  assert.match(baseline.dashboard.config.sources[0].roots[0], /private/);

  const remoteNames = ["other", "linux"];
  const cacheRows = [row(20), row(3, "2026-11-22"),
    row(7, TODAY, { model: "other-model" }), row(9, TODAY, { provider: "other-provider" })];
  const targets = [];
  const exec = async (_command, _argv, { on }) => {
    targets.push(on);
    return { code: 0, stdout: JSON.stringify(cache(cacheRows)) };
  };
  const remote = await view(file, {
    scope: { kind: "remote", name: "linux" }, remoteNames, filters: { model: "shared-model", provider: "openai" },
  }, exec);
  assert.deepEqual(remote.coverage.machines.map(({ name }) => name), ["linux"]);
  assert.equal(remote.dashboard.heatmap.weekStartsOn, 1);
  assert.equal(remote.dashboard.totals.total, 20, "viewer’s Monday week excludes Sunday");
  assert.equal(remote.dashboard.selectedTotals.total, 20);
  assert.equal(remote.dashboard.machineSeries, undefined);
  const preferenceChange = await view(file, {
    scope: { kind: "remote", name: "linux" }, remoteNames, includeCache: true, weekStartsOn: 0,
    filters: { model: "shared-model", provider: "openai" },
  }, exec);
  assert.equal(preferenceChange.dashboard.totals.total, 223);
  assert.deepEqual(targets, ["linux", "linux"]);
  assert.equal(await readFile(file, "utf8"), before);
});

test("unknown and unreadable scopes keep named coverage without substituting zero or Local", async (t) => {
  const { dir, file } = await fixture(t);
  const viewFor = (name, exec, remoteNames = [name]) =>
    view(file, { scope: { kind: "remote", name }, remoteNames }, exec);
  const removed = await viewFor("removed", () => assert.fail("missing registration must not execute"), ["linux"]);
  assert.deepEqual(removed.coverage.machines, [
    { name: "removed", status: "unavailable", ageMs: null, reason: "machine is not registered" },
  ]);
  assert.equal(removed.dashboard, null);
  for (const [result, reason] of [
    [{ code: 4 }, "cache unreadable"],
    [{ code: 0, stdout: "{" }, "cache is not valid JSON"],
    [{ code: 0, stdout: JSON.stringify(cache([null])) }, "cache is not an insights cache"],
    [{ code: 0, stdout: JSON.stringify(cache([], null, { version: 7 })) }, "cache is not an insights cache"],
  ]) {
    const missing = await viewFor("linux", async () => ({ ...result, stderr: REMOTE_PRIVATE }));
    assert.equal(missing.coverage.machines[0].reason, reason);
    assert.equal(missing.coverage.readable, 0);
    assert.equal(missing.dashboard, null);
  }
  const genuinelyEmpty = await viewFor("linux", async () => ({ code: 0, stdout: JSON.stringify(cache([])) }));
  assert.equal(genuinelyEmpty.coverage.readable, 1);
  assert.equal(genuinelyEmpty.dashboard.totals.total, 0);
  const noLocal = await view(join(dir, "missing.json"), { scope: { kind: "all" }, remoteNames: ["linux"] },
    async () => ({ code: 0, stdout: JSON.stringify(cache([row(20)])) }));
  assert.equal(noLocal.coverage.machines[0].status, "unavailable");
  assert.equal(noLocal.dashboard.rowCount, 1);
});

test("invalid scopes or noncompact options fail closed before doing remote work", async () => {
  for (const options of [
    {}, { scope: { kind: "fleet" }, remoteNames: [] },
    { scope: { kind: "local", name: "linux" }, remoteNames: [] },
    { scope: { kind: "remote" }, remoteNames: [] },
    { scope: { kind: "remote", name: "--help" }, remoteNames: ["--help"] },
    { scope: { kind: "remote", name: "linux\n" }, remoteNames: ["linux\n"] },
    { scope: { kind: "all" }, remoteNames: [{ name: "linux", cache: [] }] },
    { scope: { kind: "all" }, remoteNames: [], extra: REMOTE_PRIVATE.repeat(1024) },
  ]) {
    const result = await run(args("/does/not/exist", options), {
      machineExec: () => assert.fail("invalid options must not execute"),
    });
    assert.deepEqual(result, { exitCode: 2, stdout: "", stderr: "invalid machine-dashboard --options\n" });
  }
});

test("All bounds concurrent remote reads and still returns each failed host", async (t) => {
  const { file } = await fixture(t);
  let active = 0;
  let peak = 0;
  const remoteNames = Array.from({ length: 12 }, (_, index) => `machine-${index}`);
  const result = await view(file, { scope: { kind: "all" }, remoteNames }, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(setImmediate);
    active -= 1;
    throw new Error(REMOTE_PRIVATE);
  });
  assert.equal(peak, 4);
  assert.equal(result.coverage.total, 13);
  assert.equal(result.coverage.readable, 1);
  assert.equal(result.dashboard.totals.total, 10);
  assert.ok(result.coverage.machines.slice(1).every(({ reason }) => reason === "could not reach that machine"));
});

test("the real Node adapter uses fixed Core argv and reads an 8 MiB cache through stdout", async (t) => {
  const { dir, file } = await fixture(t);
  const payload = JSON.stringify(cache([row(20)]));
  const envelope = join(dir, "core-output.json");
  const pad = " ".repeat(8 * 1024 * 1024 - Buffer.byteLength(payload));
  const argvLog = join(dir, "core-argv.json");
  await writeFile(join(dir, "settings.json"), "{}");
  const output = (stdout, overrides = {}) => JSON.stringify({
    code: 0, stdout: Buffer.from(stdout).toString("base64"), stderr: Buffer.from(REMOTE_PRIVATE).toString("base64"),
    truncated: false, timed_out: false, ...overrides,
  });
  await writeFile(envelope, output(payload + pad));
  const fakeCore = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("hc 0.1.20"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv));
fs.createReadStream(${JSON.stringify(envelope)}).pipe(process.stdout);
`;
  const call = (search = dir) => JSON.parse(execFileSync(process.execPath, [presenter, ...args(file, {
    scope: { kind: "remote", name: "linux" }, remoteNames: ["linux"], ...storeOptions,
  })], { encoding: "utf8", env: { PATH: search, HERDR_APP_HOME: dir, HOME: dir }, timeout: 10_000 }));
  await writeFile(join(dir, "herdr-core"), fakeCore, { mode: 0o755 });
  const result = call();
  assert.equal(result.dashboard.totals.total, 20);
  assert.deepEqual(JSON.parse(await readFile(argvLog, "utf8")),
    ["exec", "--json", "--on=linux", "--timeout", "6", "--", "sh", "-c", CACHE_SCRIPT]);
  await rm(join(dir, "herdr-core"));
  await writeFile(join(dir, "hc"), fakeCore, { mode: 0o755 });
  for (const [body, reason] of [
    [output(payload, { truncated: true }), "cache unreadable"],
    [output(payload, { timed_out: true }), "could not reach that machine"],
    [output("", { code: 3 }), "no cache on that machine"],
    [JSON.stringify({ error: { message: REMOTE_PRIVATE } }), "could not reach that machine"],
  ]) {
    await writeFile(envelope, body);
    const unavailable = call();
    assert.equal(unavailable.coverage.machines[0].reason, reason);
    assert.equal(unavailable.dashboard, null);
  }
  await writeFile(envelope, output(payload));
  await rm(argvLog);
  const laterEntryCore = call(`/not/the/app-core:${dir}`);
  assert.equal(laterEntryCore.dashboard.totals.total, 20, "a Core in a later PATH entry is used");
  assert.deepEqual(JSON.parse(await readFile(argvLog, "utf8")),
    ["exec", "--json", "--on=linux", "--timeout", "6", "--", "sh", "-c", CACHE_SCRIPT]);
  await rm(argvLog);

  const settings = join(dir, "settings.json");
  const overrideLog = join(dir, "override-argv.json");
  const renamedLog = join(dir, "renamed-argv.json");
  await writeFile(join(dir, "herdr-core"), fakeCore.replace(argvLog, overrideLog), { mode: 0o755 });
  await writeFile(settings, JSON.stringify({ core: join(dir, "herdr-core") }));
  assert.equal(call().dashboard.totals.total, 20, "an exact stock binary override is accepted");
  assert.deepEqual(JSON.parse(await readFile(overrideLog, "utf8")),
    ["exec", "--json", "--on=linux", "--timeout", "6", "--", "sh", "-c", CACHE_SCRIPT]);
  await rm(overrideLog);
  await writeFile(join(dir, "renamed-core"), fakeCore.replace(argvLog, renamedLog), { mode: 0o755 });
  await writeFile(settings, JSON.stringify({ core: "~/renamed-core" }));
  assert.equal(call().dashboard.totals.total, 20, "a home-relative renamed binary wins over both standard names");
  assert.match(await readFile(renamedLog, "utf8"), /--on=linux/);
  await rm(renamedLog);
  await assert.rejects(readFile(overrideLog), { code: "ENOENT" });

  for (const invalid of [join(dir, "missing"), `${REMOTE_PRIVATE}/custom-core`, "relative-core", 7]) {
    await writeFile(settings, JSON.stringify({ core: invalid }));
    const rejected = call();
    assert.equal(rejected.coverage.machines[0].reason, "configured Herdr Core unavailable");
    assert.equal(rejected.dashboard, null);
    assert.doesNotMatch(JSON.stringify(rejected), /\/remote\/private\/config/);
    await assert.rejects(readFile(argvLog), { code: "ENOENT" });
    await assert.rejects(readFile(overrideLog), { code: "ENOENT" });
  }
});

test("the Core binary is found in a later PATH entry, not only in the first one", async (t) => {
  const { dir, file } = await fixture(t);
  const first = join(dir, "first");
  const later = join(dir, "later");
  const short = join(dir, "short");
  const elsewhere = join(dir, "elsewhere");
  await mkdir(first);
  await mkdir(later);
  await mkdir(short);
  await mkdir(elsewhere);
  const argvLog = join(dir, "argv.json");
  const envelope = join(dir, "core-output.json");
  const payload = JSON.stringify(cache([row(20)]));
  await writeFile(envelope, JSON.stringify({
    code: 0, stdout: Buffer.from(payload).toString("base64"), stderr: Buffer.from("").toString("base64"),
    truncated: false, timed_out: false,
  }));
  const core = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("hc 0.1.20"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ binary: process.argv[1], argv }));
fs.createReadStream(${JSON.stringify(envelope)}).pipe(process.stdout);
`;
  await writeFile(join(later, "herdr-core"), core, { mode: 0o755 });
  await writeFile(join(short, "hc"), core, { mode: 0o755 });
  await writeFile(join(elsewhere, "herdr-core"), core, { mode: 0o755 });
  // A binary that answers but is not a Core must not end the scan.
  await writeFile(join(first, "hc"), `#!${process.execPath}\nconsole.log("hc dev");\n`, { mode: 0o755 });
  await writeFile(join(dir, "settings.json"), "{}");
  const call = (search, cwd = dir) => JSON.parse(execFileSync(process.execPath, [presenter, ...args(file, {
    scope: { kind: "remote", name: "linux" }, remoteNames: ["linux"], ...storeOptions,
  })], { encoding: "utf8", env: { PATH: search, HERDR_APP_HOME: dir, HOME: dir }, cwd, timeout: 10_000 }));
  const search = `${first}${delimiter}${later}`;

  const found = call(search);
  assert.equal(found.dashboard.totals.total, 20, "the Core in the later PATH entry is used");
  const used = JSON.parse(await readFile(argvLog, "utf8"));
  assert.equal(used.binary, join(later, "herdr-core"), "the first PATH entry without a Core does not block a later one");
  assert.deepEqual(used.argv, ["exec", "--json", "--on=linux", "--timeout", "6", "--", "sh", "-c", CACHE_SCRIPT]);

  await rm(argvLog);
  const shortName = call(`${first}${delimiter}${short}`);
  assert.equal(shortName.dashboard.totals.total, 20, "the short Core name is found in a later PATH entry too");
  assert.equal(JSON.parse(await readFile(argvLog, "utf8")).binary, join(short, "hc"));

  await rm(argvLog);
  // The working directory holds a Core: a relative PATH entry must not reach it.
  const skipped = call(`${delimiter}.${delimiter}${search}`, elsewhere);
  assert.equal(skipped.dashboard.totals.total, 20);
  assert.equal(JSON.parse(await readFile(argvLog, "utf8")).binary, join(later, "herdr-core"),
    "empty and relative PATH entries are skipped, not trusted");
});

test("a configured Core override must live in PATH and never falls back to another binary", async (t) => {
  const { dir, file } = await fixture(t);
  const first = join(dir, "first");
  const later = join(dir, "later");
  const outside = join(dir, "outside");
  await mkdir(first);
  await mkdir(later);
  await mkdir(outside);
  const argvLog = join(dir, "argv.json");
  const envelope = join(dir, "core-output.json");
  const payload = JSON.stringify(cache([row(20)]));
  await writeFile(envelope, JSON.stringify({
    code: 0, stdout: Buffer.from(payload).toString("base64"), stderr: Buffer.from("").toString("base64"),
    truncated: false, timed_out: false,
  }));
  const core = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("hc 0.1.20"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ binary: process.argv[1], argv }));
fs.createReadStream(${JSON.stringify(envelope)}).pipe(process.stdout);
`;
  await writeFile(join(later, "herdr-core"), core, { mode: 0o755 });
  await writeFile(join(outside, "herdr-core"), core, { mode: 0o755 });
  const settings = join(dir, "settings.json");
  const call = (search) => JSON.parse(execFileSync(process.execPath, [presenter, ...args(file, {
    scope: { kind: "remote", name: "linux" }, remoteNames: ["linux"], ...storeOptions,
  })], { encoding: "utf8", env: { PATH: search, HERDR_APP_HOME: dir, HOME: dir }, timeout: 10_000 }));
  const search = `${first}${delimiter}${later}`;

  await writeFile(settings, JSON.stringify({ core: join(later, "herdr-core") }));
  const accepted = call(search);
  assert.equal(accepted.dashboard.totals.total, 20, "an override in a later PATH entry is accepted");
  assert.equal(JSON.parse(await readFile(argvLog, "utf8")).binary, join(later, "herdr-core"));

  await rm(argvLog);
  await writeFile(settings, JSON.stringify({ core: join(outside, "herdr-core") }));
  const refused = call(search);
  assert.equal(refused.coverage.machines[0].reason, "configured Herdr Core unavailable");
  assert.equal(refused.dashboard, null);
  await assert.rejects(readFile(argvLog), { code: "ENOENT" });
});
