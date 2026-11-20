import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CACHE_SCRIPT,
  NO_CACHE_EXIT_CODE,
  UNREADABLE_EXIT_CODE,
  fleetMachines,
  readFleetMachine,
} from "../mods/insights/core/fleet.mjs";

const SECRET = "SECRET /home/mateod/.ssh/id_ed25519";

async function tempDir(t, prefix = "insights-fleet-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function homeCachePath(home) {
  return join(home, ".config", "herdr-app", "data", "insights", "insights.json.cache.json");
}

async function writeCache(file, text) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

function runScript(home, extraEnv = {}) {
  return spawnSync("sh", ["-c", CACHE_SCRIPT], {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...extraEnv,
    },
  });
}

function usageRow(tokens, messages = 1) {
  return {
    day: "2026-03-04",
    session: "codex:session-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-5.6",
    project: "/home/person",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...tokens },
    messages,
  };
}

function cachePayload(overrides = {}) {
  return {
    version: 2,
    savedAt: "2026-03-04T10:00:00.000Z",
    lastScanAt: "2026-03-04T10:00:00.000Z",
    generation: 3,
    config: { includeCache: true, refreshSeconds: 60 },
    rows: [usageRow({ input: 100, output: 20, cacheRead: 5, cacheWrite: 3, reasoning: 7 }, 2)],
    scan: { status: "complete", processed: 1, total: 1 },
    storeFingerprint: { dev: "1", ino: "2", size: "3", mtimeNs: "4" },
    ...overrides,
  };
}

test("the cache script only reads the target machine's environment", () => {
  assert.equal(typeof CACHE_SCRIPT, "string");
  const appHome = CACHE_SCRIPT.indexOf("HERDR_APP_HOME");
  const xdg = CACHE_SCRIPT.indexOf("XDG_CONFIG_HOME");
  const home = CACHE_SCRIPT.indexOf('home_cache="$HOME/.config');
  assert.ok(appHome >= 0, "the HERDR_APP_HOME candidate is present");
  assert.ok(xdg > appHome, "the XDG_CONFIG_HOME candidate follows HERDR_APP_HOME");
  assert.ok(home > xdg, "the HOME candidate follows XDG_CONFIG_HOME");
  assert.equal((CACHE_SCRIPT.match(/insights\.json\.cache\.json/g) ?? []).length, 3);

  assert.match(CACHE_SCRIPT, /-L/, "symlinks are refused");
  assert.match(CACHE_SCRIPT, /! -f/, "non-regular files are refused");
  assert.match(CACHE_SCRIPT, /8388608/, "files over 8 MiB are refused");
  assert.doesNotMatch(CACHE_SCRIPT, /\$[@*#]/, "no positional or special shell arguments");
});

test("the cache script prints the file's exact bytes", async (t) => {
  const home = await tempDir(t);
  const text = `${JSON.stringify(cachePayload(), null, 2)}\n`;
  await writeCache(homeCachePath(home), text);

  const result = runScript(home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, text);
});

test("the cache script accepts a BSD-style padded byte count", async (t) => {
  const home = await tempDir(t);
  const text = JSON.stringify(cachePayload());
  await writeCache(homeCachePath(home), text);

  // macOS wc pads its count with leading spaces; the size check must not
  // mistake that for a corrupt count.
  const bin = await tempDir(t, "insights-fleet-bin-");
  const wc = join(bin, "wc");
  await writeFile(wc, "#!/bin/sh\nprintf '      42\\n'\n");
  await chmod(wc, 0o755);

  const result = runScript(home, {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, text);
});

test("the cache script prefers HERDR_APP_HOME, then XDG_CONFIG_HOME", async (t) => {
  const home = await tempDir(t);
  const appHome = await tempDir(t);
  const xdgHome = await tempDir(t);
  const appText = JSON.stringify(cachePayload({ savedAt: "app-home" }));
  const xdgText = JSON.stringify(cachePayload({ savedAt: "xdg-config" }));
  const homeText = JSON.stringify(cachePayload({ savedAt: "home-config" }));
  await writeCache(join(appHome, "data", "insights", "insights.json.cache.json"), appText);
  await writeCache(join(xdgHome, "herdr-app", "data", "insights", "insights.json.cache.json"), xdgText);
  await writeCache(homeCachePath(home), homeText);

  const withAppHome = runScript(home, { HERDR_APP_HOME: appHome });
  assert.equal(withAppHome.status, 0, withAppHome.stderr);
  assert.equal(withAppHome.stdout, appText);

  const withXdg = runScript(home, { XDG_CONFIG_HOME: xdgHome });
  assert.equal(withXdg.status, 0, withXdg.stderr);
  assert.equal(withXdg.stdout, xdgText);
});

test("a missing cache prints nothing and reports no cache", async (t) => {
  const home = await tempDir(t);
  const result = runScript(home);
  assert.equal(result.status, NO_CACHE_EXIT_CODE);
  assert.equal(result.stdout, "");
});

test("a symlinked cache prints nothing and reports it unreadable", async (t) => {
  const home = await tempDir(t);
  const target = join(home, "outside.json");
  await writeFile(target, JSON.stringify(cachePayload()));
  const cachePath = homeCachePath(home);
  await mkdir(dirname(cachePath), { recursive: true });
  await symlink(target, cachePath);

  const result = runScript(home);
  assert.equal(result.status, UNREADABLE_EXIT_CODE);
  assert.equal(result.stdout, "");
});

test("an oversized cache prints nothing and reports it unreadable", async (t) => {
  const home = await tempDir(t);
  const cachePath = homeCachePath(home);
  await writeCache(cachePath, "{}");
  await truncate(cachePath, 8 * 1024 * 1024 + 1);

  const result = runScript(home);
  assert.equal(result.status, UNREADABLE_EXIT_CODE);
  assert.equal(result.stdout, "");
});

test("fleetMachines puts this computer first and sorts the rest case-insensitively", () => {
  const machines = fleetMachines([
    { name: "zeta", layout: "ready" },
    { name: null, layout: "ready" },
    { name: "B", layout: "ready" },
    { name: "a", layout: "loading" },
  ]);
  assert.deepEqual(machines.map((machine) => machine.name), [null, "a", "B", "zeta"]);
  assert.deepEqual(machines.map((machine) => machine.label), ["This computer", "a", "B", "zeta"]);

  const tied = fleetMachines([
    { name: "a", layout: "ready" },
    { name: "A", layout: "ready" },
  ]);
  assert.deepEqual(tied.map((machine) => machine.name), ["A", "a"],
    "the exact name keeps the order stable");
});

test("readFleetMachine returns a good cache and routes the name through exec", async () => {
  const payload = cachePayload();
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
  };

  const result = await readFleetMachine({ name: "studio", label: "Studio" }, { exec, timeout: 4321 });
  assert.equal(result.ok, true);
  assert.equal(result.name, "studio");
  assert.equal(result.label, "Studio");
  assert.deepEqual(result.rows, payload.rows);
  assert.deepEqual(result.scan, payload.scan);
  assert.equal(result.savedAt, payload.savedAt);
  assert.equal(result.lastScanAt, payload.lastScanAt);
  assert.deepEqual(result.config, payload.config);
  assert.equal(result.reason, null);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "sh");
  assert.deepEqual(calls[0].args, ["-c", CACHE_SCRIPT]);
  assert.equal(calls[0].options.on, "studio");
  assert.equal(calls[0].options.timeout, 4321);
});

test("a machine name never reaches the cache script", async () => {
  const hostile = 'laptop"; touch /tmp/pwned; echo "';
  let seen;
  const exec = async (command, args, options) => {
    seen = { command, args, options };
    return { code: 0, stdout: JSON.stringify(cachePayload()) };
  };

  await readFleetMachine({ name: hostile }, { exec, timeout: 1_000 });
  assert.equal(seen.args[1], CACHE_SCRIPT);
  assert.equal(CACHE_SCRIPT.includes(hostile), false);
  assert.equal(seen.options.on, hostile, "the name travels only as the exec target");
});

test("readFleetMachine targets this computer when the name is null", async () => {
  let options;
  const exec = async (_command, _args, value) => {
    options = value;
    return { code: 0, stdout: JSON.stringify(cachePayload()) };
  };

  const result = await readFleetMachine({ name: null }, { exec, timeout: 1_000 });
  assert.equal(options.on, null);
  assert.equal(result.ok, true);
  assert.equal(result.name, null);
  assert.equal(result.label, "This computer");
});

test("a missing cache maps to a fixed reason without echoing stderr", async () => {
  const result = await readFleetMachine({ name: "studio", label: "Studio" }, {
    exec: async () => ({ code: NO_CACHE_EXIT_CODE, stdout: "", stderr: SECRET }),
    timeout: 1_000,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.rows, []);
  assert.equal(result.reason, "no cache on that machine");
  assert.equal(result.reason.includes(SECRET), false);
  assert.doesNotMatch(result.reason, /SECRET|id_ed25519|\/home/);
});

test("an unreadable cache has its own reason", async () => {
  const result = await readFleetMachine({ name: "studio" }, {
    exec: async () => ({ code: UNREADABLE_EXIT_CODE, stdout: "", stderr: SECRET }),
    timeout: 1_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cache unreadable");
  assert.doesNotMatch(result.reason, /SECRET|id_ed25519/);
});

test("an unreachable machine includes exec rejection, timeout and unknown exits", async () => {
  const rejecting = await readFleetMachine({ name: "studio" }, {
    exec: async () => { throw new Error(`${SECRET} ECONNREFUSED`); },
    timeout: 1_000,
  });
  assert.equal(rejecting.ok, false);
  assert.equal(rejecting.reason, "could not reach that machine");
  assert.doesNotMatch(rejecting.reason, /SECRET|id_ed25519|ECONNREFUSED/);

  const timedOut = await readFleetMachine({ name: "studio" }, {
    exec: async () => ({ code: null, stdout: "", stderr: "timed out" }),
    timeout: 1_000,
  });
  assert.equal(timedOut.reason, "could not reach that machine");

  const unknownExit = await readFleetMachine({ name: "studio" }, {
    exec: async () => ({ code: 127, stdout: "", stderr: "sh: not found" }),
    timeout: 1_000,
  });
  assert.equal(unknownExit.reason, "could not reach that machine");

  const noExec = await readFleetMachine({ name: "studio" }, { timeout: 1_000 });
  assert.equal(noExec.reason, "could not reach that machine");
});

test("corrupt JSON and non-cache payloads report their own reasons", async () => {
  const corrupt = await readFleetMachine({ name: "studio" }, {
    exec: async () => ({ code: 0, stdout: '{"version":2,"rows":[', stderr: SECRET }),
    timeout: 1_000,
  });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reason, "cache is not valid JSON");
  assert.doesNotMatch(corrupt.reason, /SECRET|id_ed25519/);

  const payloads = [
    JSON.stringify({ version: 2 }),
    JSON.stringify({ version: 1, rows: [] }),
    JSON.stringify({ rows: [] }),
    JSON.stringify({ version: 2, rows: {} }),
    "[]",
    "null",
  ];
  for (const stdout of payloads) {
    const result = await readFleetMachine({ name: "studio" }, {
      exec: async () => ({ code: 0, stdout }),
      timeout: 1_000,
    });
    assert.equal(result.ok, false, stdout);
    assert.equal(result.reason, "cache is not an insights cache", stdout);
  }
});

test("a non-zero exit with a valid cache is still honoured", async () => {
  const result = await readFleetMachine({ name: "studio" }, {
    exec: async () => ({ code: 9, stdout: JSON.stringify(cachePayload()), stderr: SECRET }),
    timeout: 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
});
