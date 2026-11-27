import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = "../mods/usage-limits-fleet-canary";
const { default: provider, parse } = await import(`${root}/providers/opencode-go.js`);
const { fetchedState, NEVER_FETCHED } = await import(`${root}/lib/fetch-state.js`);
const { barModel, cardModel } = await import(`${root}/lib/view.js`);
const { effectivePrefs } = await import(`${root}/lib/prefs.js`);

const HELPER = fileURLToPath(new URL(`${root}/helpers/opencode-go-limits.sh`, import.meta.url));
const NOW = 2_000_000_000;
const STATUS = "service status";
const VERSION = "--version";
const API = "api GET /api/experimental/usage/limits";
const URL_LINE = "http://127.0.0.1:50000";
const STOPPED_MARKER = '{"herdr":"server-stopped"}\n';
const UNAVAILABLE_MARKER = '{"herdr":"limits-unavailable"}\n';

const GO = {
  rolling: { percent: 12, limited: false, resetsAt: 2000003600000 },
  weekly: { percent: 100, limited: true, resetsAt: 2000604800000 },
  monthly: { percent: 34, limited: false, resetsAt: 2002592000000 },
};
const reply = (data) => `${JSON.stringify({ location: { directory: "/x" }, data })}\n`;
const signedIn = (go) => ({ workspace: { id: "wrk_example", usageURL: "https://example.invalid" }, go, budgets: [] });

test("a full reply becomes the 5-hour, weekly and monthly windows with resets in seconds", () => {
  const report = parse(reply(signedIn(GO)), NOW);
  assert.deepEqual(report, { status: "ok", message: null, plan: null, observedAt: NOW, source: "OpenCode server", windows: [
    { id: "session", short: "5h", long: "5-hour", percent: 12, resetsAt: 2000003600, durationSec: 18000 },
    { id: "weekly_all", short: "wk", long: "Weekly", percent: 100, resetsAt: 2000604800, durationSec: 604800 },
    { id: "monthly", short: "mo", long: "Monthly", percent: 34, resetsAt: 2002592000, durationSec: null },
  ] });
});

const reads = (text, status, message) => {
  const report = parse(text, NOW);
  assert.deepEqual([report.status, report.message, report.windows], [status, message, []], text);
};

test("a stopped server, unreadable limits, a signed-out console and a workspace without Go are unavailable", () => {
  reads(STOPPED_MARKER, "unavailable", "OpenCode server isn't running");
  reads(UNAVAILABLE_MARKER, "unavailable", "OpenCode couldn't read the usage limits");
  reads(reply(null), "unavailable", "Not signed in to OpenCode Console");
  const { go, ...noGo } = signedIn(GO);
  reads(reply(noGo), "unavailable", "No OpenCode Go usage for this workspace");
  reads(reply(signedIn(null)), "unavailable", "No OpenCode Go usage for this workspace");
});

test("a missing or malformed meter is an unknown reply, never a partial reading", () => {
  const broken = [undefined, null, {}, { percent: "5", resetsAt: 1 }, { percent: -1, resetsAt: 1 },
    { percent: 101, resetsAt: 1 }, { percent: 5 }, { percent: 5, resetsAt: 0 }, { percent: 5, resetsAt: "2000003600000" }];
  for (const key of Object.keys(GO)) {
    for (const meter of broken) {
      reads(reply(signedIn({ ...GO, [key]: meter })), "error", "Unknown usage reply from OpenCode");
    }
  }
});

test("anything unrecognizable is no reply", () => {
  for (const text of ["", "not json", "{broken", '{"location":{}}', reply("text"), reply([]), reply(7)]) {
    reads(text, "error", "No reply from OpenCode");
  }
});

function fakeOpencode(t, { status = URL_LINE, statusExit = 0, version = "opencode v2.4.2",
  body = "", stderr = "", apiExit = 0, statusSleep = 0, apiSleep = 0 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-go-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name, text) => writeFileSync(path.join(dir, name), text);
  file("status", `${status}\n`);
  file("version", `${version}\n`);
  file("body", body);
  file("stderr", stderr);
  file("opencode", `#!/bin/sh
here=$(dirname "$0")
printf '%s\\n' "$*" >>"$here/argv"
if [ "$1" = service ]; then
  sleep ${statusSleep}
  cat "$here/status"
  exit ${statusExit}
fi
if [ "$1" = --version ]; then
  exec cat "$here/version"
fi
cat "$here/body"
cat "$here/stderr" >&2
if [ ${apiSleep} -gt 0 ]; then
  exec sleep ${apiSleep}
fi
exit ${apiExit}
`);
  chmodSync(path.join(dir, "opencode"), 0o755);
  return dir;
}

function runHelper(dir, { bin = path.join(dir, "opencode"), env = {} } = {}) {
  const result = spawnSync("sh", [HELPER], {
    encoding: "utf8",
    env: { ...process.env, HERDR_USAGE_OPENCODE_BIN: bin, TMPDIR: dir, ...env },
  });
  const log = path.join(dir, "argv");
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { code: result.status, stdout: result.stdout, calls };
}

test("helper: a missing binary exits 127", (t) => {
  const dir = fakeOpencode(t);
  assert.equal(runHelper(dir, { bin: path.join(dir, "absent") }).code, 127);
});

test("helper: a stopped server prints the marker and never calls api", (t) => {
  const result = runHelper(fakeOpencode(t, { status: "stopped" }));
  assert.deepEqual(result, { code: 0, stdout: STOPPED_MARKER, calls: [STATUS] });
});

test("helper: a running server is asked for the limits and the body passes through", (t) => {
  for (const status of [URL_LINE, "https://127.0.0.1:50000\n"]) {
    const body = reply(signedIn(GO));
    const result = runHelper(fakeOpencode(t, { status, body }));
    assert.deepEqual(result, { code: 0, stdout: body, calls: [STATUS, API] });
  }
});

test("helper: a removed route exits 127", (t) => {
  const result = runHelper(fakeOpencode(t, { stderr: "HTTP 404 Not Found\n", apiExit: 1 }));
  assert.deepEqual(result, { code: 127, stdout: "", calls: [STATUS, API] });
});

test("helper: a 404 for a missing server directory is not a removed route", (t) => {
  const result = runHelper(fakeOpencode(t, {
    body: '{"_tag":"LocationNotFoundError"}\n', stderr: "HTTP 404 Not Found\n", apiExit: 1,
  }));
  assert.deepEqual(result, { code: 1, stdout: "", calls: [STATUS, API] });
});

test("helper: a 503 prints the unavailable marker", (t) => {
  const result = runHelper(fakeOpencode(t, {
    body: '{"message":"unavailable"}\n', stderr: "HTTP 503 Service Unavailable\n", apiExit: 1,
  }));
  assert.deepEqual(result, { code: 0, stdout: UNAVAILABLE_MARKER, calls: [STATUS, API] });
});

test("helper: any other api failure exits 1 and prints nothing", (t) => {
  const result = runHelper(fakeOpencode(t, {
    body: '{"message":"HTTP 404"}\n', stderr: "HTTP 500 Internal Server Error\n", apiExit: 1,
  }));
  assert.deepEqual(result, { code: 1, stdout: "", calls: [STATUS, API] });
});

const UNUSABLE_STATUSES = [{ status: "starting" }, { status: "" }, { status: URL_LINE, statusExit: 1 }];

test("helper: without a usable status, a release before 2 reads as absent and api is never called", (t) => {
  for (const options of UNUSABLE_STATUSES) {
    for (const version of ["0.15.0", "1.2.3"]) {
      const result = runHelper(fakeOpencode(t, { ...options, version }));
      assert.deepEqual(result, { code: 127, stdout: "", calls: [STATUS, VERSION] });
    }
  }
});

test("helper: without a usable status, any other release exits 1 and api is never called", (t) => {
  for (const options of UNUSABLE_STATUSES) {
    const result = runHelper(fakeOpencode(t, options));
    assert.deepEqual(result, { code: 1, stdout: "", calls: [STATUS, VERSION] });
  }
});

test("helper: both commands share one deadline", (t) => {
  const dir = fakeOpencode(t, { statusSleep: 6, apiSleep: 6, body: reply(signedIn(GO)) });
  const result = runHelper(dir, { env: { HERDR_USAGE_OPENCODE_GO_DEADLINE_S: "10" } });
  assert.deepEqual(result, { code: 1, stdout: "", calls: [STATUS, API] });
});

test("exit 127 marks the provider absent and a stopped server keeps it installed", () => {
  const absent = fetchedState(NEVER_FETCHED, provider, { code: 127, stdout: "" }, NOW);
  assert.equal(absent.installed, false);
  assert.equal(absent.report, null);
  const stopped = fetchedState(NEVER_FETCHED, provider, { code: 0, stdout: STOPPED_MARKER }, NOW);
  assert.equal(stopped.installed, true);
  assert.equal(stopped.report.status, "unavailable");
});

test("the bar and the card show the windows, keep a signed-out group and drop an absent one", () => {
  const prefs = effectivePrefs();
  const views = (result) => {
    const states = { [provider.id]: fetchedState(NEVER_FETCHED, provider, result, NOW) };
    return { bar: barModel(states, prefs, NOW, [provider]), card: cardModel(states, NOW, [provider], prefs) };
  };
  const full = views({ code: 0, stdout: reply(signedIn(GO)) });
  assert.deepEqual(full.bar.groups[0].segments.map((s) => s.short), ["5h", "wk", "mo"]);
  assert.deepEqual(full.card.groups[0].rows.map((r) => r.percent), ["12%", "100%", "34%"]);
  const signedOut = views({ code: 0, stdout: reply(null) });
  assert.deepEqual(signedOut.card.groups.map((g) => [g.providerId, g.status]),
    [["opencode-go", "Not signed in to OpenCode Console"]]);
  const absent = views({ code: 127, stdout: "" });
  assert.deepEqual([absent.bar.groups, absent.card.groups], [[], []]);
});
