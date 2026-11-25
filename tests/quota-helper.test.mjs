import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { parseQuotaReply, projectReading } from "../mods/insights/fleet-quota/protocol.mjs";
import { parseFrontierCredit } from "../scripts/quota/frontier.mjs";
import { runCli } from "../scripts/quota/runtime.mjs";

const exec = promisify(execFile);
const test = process.platform === "linux" ? nodeTest : nodeTest.skip;
const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const main = path.join(scripts, "quota/main.mjs");
const launch = path.join(scripts, "quota/launch.sh");
const installer = path.join(scripts, "install-quota.sh");
const SECRET = "sensitive-test-value";
const CORE = "936b195fef133a7299220eb467123c10";
const OTHER_CORE = "761fbbfc4625f1a4f400d47272a33f29";
const WRONG_BINDING = "0".repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const workspace = "work_fixture_123";
const userId = "user_fixture_123";
const email = "private-fixture@example.invalid";
const FRONTIER_MONEY = { currency: "$", usedMinor: 27_899, limitMinor: 2_000_000 };
const MONTHLY_MONEY = { currency: "$", usedMinor: 53_173, limitMinor: 60_000, resetLabel: "Dec 1" };

const FAKE_CLI = String.raw`
import assert from "node:assert/strict";
import { appendFileSync, fstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
const root = process.env.HOME;
const cli = basename(process.argv[1]).split(".")[0];
const args = process.argv.slice(2);
const f = JSON.parse(readFileSync(root + "/fixture.json", "utf8"));
const log = (method) => appendFileSync(root + "/calls", cli + ": " + method + "\n");
const emit = (reply) => process.stdout.write(JSON.stringify(reply) + "\n");
const spendUsageBudget = () => {
  if (f.singleUsageBudget) writeFileSync(root + "/usage-budget-spent", "1", { flag: "wx" });
};
assert.equal(process.env.CI, process.cwd() === f.frontierWorkspace ? undefined : "1");
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
process.stderr.write("sensitive-test-value /private/stderr\n");
if (cli === "codex") {
  assert.deepEqual(args, ["app-server"]);
  let accountCalls = 0;
  for await (const line of createInterface({ input: process.stdin })) {
    const rpc = JSON.parse(line);
    log(rpc.method);
    if (rpc.method === "initialize") {
      assert.equal(rpc.params.clientInfo.name, "herdr-quota");
      assert.equal(rpc.params.capabilities.explicitGatewayOauth, true);
      emit({ id: rpc.id, result: {} });
    } else if (rpc.method === "initialized") {
      assert.equal(rpc.id, undefined);
    } else if (rpc.method === "account/read") {
      assert.deepEqual(rpc.params, { refreshToken: false });
      emit({ id: rpc.id, result: ++accountCalls === 1 ? f.codexAccount : f.codexAccountAfter ?? f.codexAccount });
    } else if (rpc.method === "account/rateLimits/read") {
      assert.deepEqual(rpc.params, {});
      if (f.codexHang) {
        writeFileSync(root + "/active", "1");
        setInterval(() => {}, 1000);
        continue;
      }
      if (f.codexNotify) emit({ method: "account/updated", params: { email: "switched" } });
      else emit({ method: "account/updated", params: { reason: "workspaceRoutingReady" } });
      if (f.codexBad === "flood") {
        process.stdout.write("x".repeat(140 * 1024));
        continue;
      }
      if (f.codexBad === "json") {
        process.stdout.write('{"bad' + "\n");
        continue;
      }
      if (f.codexError) emit({ id: rpc.id, error: f.codexError });
      else emit({ id: rpc.id, result: f.codex });
    } else {
      throw new Error("not a quota method");
    }
  }
} else if (cli === "claude") {
  assert.equal(process.env.CLAUDE_CODE_SAFE_MODE, "1");
  if (args[0] === "auth") {
    log("auth status");
    assert.deepEqual(args, ["auth", "status"]);
    const history = readFileSync(root + "/calls", "utf8").split("\n");
    const auth = f.frontierAuthAfter && history.includes("claude: interactive") ? f.frontierAuthAfter :
      f.frontierAuthBefore && process.cwd() === f.frontierWorkspace ? f.frontierAuthBefore :
      f.claudeAuthAfter && history.includes("claude: get_usage") ? f.claudeAuthAfter : f.claudeAuth;
    process.stdout.write(JSON.stringify(auth, null, 2));
    process.exitCode = auth.loggedIn ? 0 : 1;
  } else if (args[0] === "--safe-mode") {
    assert.deepEqual(args, ["--safe-mode", "--tools", "", "--no-chrome"]);
    assert.equal(process.cwd(), f.frontierWorkspace);
    assert.equal(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "1");
    log("interactive");
    writeFileSync(root + "/frontier-pid", String(process.pid));
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    const show = (text) => process.stdout.write("\x1b[2J\x1b[H" + text);
    show(f.frontierMode === "trust" ? "Quick safety check: Do you trust this folder?\n❯\u00a0" :
      f.frontierMode === "startup-rate-limit" ? "Rate limited\n❯\u00a0" :
      f.frontierMode === "startup-page-rate-limit" ? f.frontierScreen + "\n❯\u00a0" :
      f.frontierMode === "nonblank" ? "❯\u00a0Tell me a joke" : "❯\u00a0");
    let typed = "";
    process.stdin.on("data", (input) => {
      if (input === "\r") {
        log("interactive Enter");
        assert.equal(typed, "/usage");
        spendUsageBudget();
        if (f.frontierInitial) {
          show(f.frontierInitial);
          if (f.frontierReplace) setTimeout(() => {
            log("replacement frame");
            show(f.frontierScreen);
          }, 550);
          return;
        }
        show(f.frontierMode === "empty" ? "No usage data" :
          f.frontierMode === "rate-limited" ? "Settings   Usage\n  Failed to load usage: Rate limited." :
          f.frontierMode === "too-many-requests" ? "Settings   Usage\n  Too many requests" : f.frontierScreen);
        return;
      }
      typed += input;
      if (typed === "/usage") {
        log("interactive /usage");
        const usage = "/usage\u2003Show plan usage limits";
        const credits = "/usage-credits   Show usage credits";
        const menu = f.frontierMode === "wrong-menu" ? "    " + usage + "\n  ❯ " + credits :
          f.frontierMode === "multiple-selected" ? "  ❯ " + usage + "\n  ❯ " + credits :
          f.frontierMode === "unconfirmed" ? "    " + usage + "\n    " + credits :
          "  ❯ " + usage + "\n    " + credits;
        show("❯\u00a0/usage\n───────────────────\n  Suggestions\n" + menu + "\n    /user   Show user settings");
      }
    });
  } else {
    log("get_usage");
    spendUsageBudget();
    assert.deepEqual(args, ["-p", "--safe-mode", "--no-session-persistence",
      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    assert.ok(fstatSync(0).isFile());
    const lines = readFileSync(0, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1);
    const req = JSON.parse(lines[0]);
    assert.deepEqual(req, { type: "control_request", request_id: "herdr-quota-v1",
      request: { subtype: "get_usage", skip_behaviors: true } });
    process.stdout.write("untrusted banner /raw/path\n");
    emit({ type: "system", session_id: "private-session-id" });
    emit({ type: "control_response", response: { request_id: "wrong-id", subtype: "error" } });
    const reply = f.claudeError
      ? { subtype: "error", error: f.claudeError }
      : { subtype: "success", response: f.claude };
    emit({ type: "control_response", response: { request_id: req.request_id, ...reply } });
  }
}
`;

function samples() {
  const w = (usedPercent, windowDurationMins, resetsAt = now() + 900) =>
    ({ usedPercent, windowDurationMins, resetsAt });
  const codex = { limitId: "codex", limitName: null, planType: "plus",
    primary: w(0, 300), secondary: w(100, 10_080) };
  return {
    codexAccount: { account: { type: "chatgpt", email, planType: "plus", workspaceName: SECRET },
      userId, workspaceRouting: { chatgptAccountId: workspace }, requiresOpenaiAuth: true },
    codex: { accountId: workspace, rateLimits: codex, rateLimitsByLimitId: {
      spark: { limitName: SECRET, primary: w(50, 300), secondary: w(88, 10_080) },
      [SECRET + "/untrusted"]: { limitName: SECRET, primary: w(7, 60) },
      codex,
    } },
    claudeAuth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email,
      orgId: "523e4567-e89b-12d3-a456-426614174000", orgName: SECRET, configDirectory: "/secret/path" },
    claude: { subscription_type: "max", rate_limits: { limits: [
      { kind: "session", percent: 0, resets_at: "2029-11-04T09:00:00.643974+00:00" },
      { kind: "weekly_all", percent: 100, resets_at: null },
      { kind: "weekly_scoped", percent: 42.4, scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 19, scope: { surface: "Cowork" } },
      { kind: "weekly_scoped", percent: 20, scope: { model: { display_name: SECRET } } },
      { kind: "frontier_credit", percent: 33, scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 21, scope: { surface: "Fable" } },
    ] } },
  };
}

async function fixture(t, { install = true, useDefault = false, session } = {}) {
  const temp = "/tmp/opencode";
  const base = await access(temp, constants.W_OK).then(() => temp, () => tmpdir());
  const home = await mkdtemp(path.join(base, "quota-fixture-"));
  const socketPath = path.join(home, "core.sock");
  const runtime = path.join(home, "run");
  const defaultSocket = path.join(runtime, "herdr-core", `${session ?? "default"}.sock`);
  await mkdir(path.dirname(defaultSocket), { recursive: true, mode: 0o700 });
  const connections = new Set();
  const servers = [];
  const core = { id: CORE, pid: process.pid, version: "0.1.20", calls: 0, overflow: false, hangs: false };
  const startCore = async (socketName, options = {}) => {
    const data = { ...core, calls: 0, ...options };
    const server = createServer((socket) => {
      connections.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => connections.delete(socket));
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk;
        if (!request.endsWith("\n")) return;
        assert.deepEqual(JSON.parse(request), { jsonrpc: "2.0", id: 1, method: "server.status", params: {} });
        data.calls++;
        if (data.hangs) return;
        socket.end(`${JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { version: data.version, pid: data.pid,
            core: { id: data.id, name: data.overflow ? "x".repeat(20 * 1024) : SECRET } },
        })}\n`);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketName, resolve);
    });
    servers.push(server);
    return data;
  };
  const runningCore = await startCore(useDefault ? defaultSocket : socketPath);
  t.after(async () => {
    for (const connection of connections) connection.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(home, { recursive: true, force: true });
  });
  const bin = path.join(home, "fixture bin");
  await mkdir(bin);
  for (const name of ["codex", "claude"]) {
    await writeFile(path.join(bin, `${name}.mjs`), `#!${process.execPath}\n${FAKE_CLI}`, { mode: 0o700 });
    await symlink(`${name}.mjs`, path.join(bin, name));
  }
  await symlink(process.execPath, path.join(bin, "node"));
  await symlink("/usr/bin/dirname", path.join(bin, "dirname"));
  const data = samples();
  const config = () => writeFile(path.join(home, "fixture.json"), JSON.stringify(data));
  await config();
  const env = { HOME: home, PATH: bin, LANG: "C", XDG_RUNTIME_DIR: runtime };
  if (!useDefault) env.HC_SOCKET = socketPath;
  if (session !== undefined) env.HC_SESSION = session;
  const command = async (file, args) => {
    try { return { code: 0, ...await exec(file, args, { env, cwd: home, timeout: 20_000 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const admin = (...args) => command("/bin/sh", [installer, ...args]);
  let binding;
  const enroll = async () => {
    const result = await admin("enroll");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^[0-9a-f]{64}\n$/);
    binding = result.stdout.trim();
    return binding;
  };
  if (install) {
    assert.equal((await admin()).code, 0);
    await enroll();
  }
  const state = path.join(home, ".local/state/herdr-quota-v1");
  const stateFile = (provider = "codex") => path.join(state, `${provider}.json`);
  const calls = async () => (await readFile(path.join(home, "calls"), "utf8")).trim().split("\n");
  const quota = async (operation = "read", provider = "codex", viaLauncher = false, requested = binding) => {
    const invocation = viaLauncher ? command("/bin/sh", [launch, operation, provider, requested]) :
      command(process.execPath, [main, operation, provider, requested]);
    const res = await invocation;
    assert.equal(res.code, 0, JSON.stringify(res));
    assert.equal(res.stderr, "");
    assert.doesNotMatch(res.stdout, /sensitive-test-value|private-fixture|private-session-id|work_fixture_123|user_fixture_123|523e4567|\/raw\/path|\/secret\/path/);
    const withoutMoneyUnit = res.stdout.replaceAll(/"currency"\s*:\s*"\$"/g, "");
    assert.doesNotMatch(withoutMoneyUnit, /\$|531\.73|600\.00|America\/Argentina\/Buenos_Aires/);
    const dto = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(dto), ["version", "provider", "status", "readAt", "attemptedAt", "retryAt", "binding", "reading"]);
    assert.equal(dto.version, 1);
    assert.equal(dto.provider, provider);
    assert.ok(dto.binding === requested || (dto.binding === null && ["not-enrolled", "unavailable"].includes(dto.status)));
    assert.ok(!res.stdout.includes(CORE) && !res.stdout.includes(OTHER_CORE));
    assert.ok(Number.isInteger(dto.readAt));
    assert.ok(dto.attemptedAt === null || (Number.isInteger(dto.attemptedAt) && dto.attemptedAt <= dto.readAt));
    return dto;
  };
  const changeState = async (edit, provider) => {
    const file = stateFile(provider);
    const stored = JSON.parse(await readFile(file, "utf8"));
    edit(stored);
    await writeFile(file, JSON.stringify(stored));
  };
  const marker = path.join(home, ".local/lib/herdr-quota-v1/grant");
  return { home, bin, data, config, command, env, state, stateFile, quota, changeState, calls,
    core: runningCore, marker, startCore, defaultSocket, admin, enroll, get binding() { return binding; } };
}

test("fixed opt-in launcher reserves 73/74 and invalid argv creates no state", async (t) => {
  const f = await fixture(t, { install: false });
  const argv = [launch, "read", "codex", WRONG_BINDING];
  assert.equal((await f.command("/bin/sh", argv)).code, 73);
  const invalidArgs = [["read", "codex"], ["read", "claude; echo ignored", WRONG_BINDING],
    ["snooze", "claude", WRONG_BINDING], ["read", "codex", WRONG_BINDING, "extra"],
    ["read", "codex", "a".repeat(65)], ["read", "codex", "A".repeat(64)],
    ["read", "codex", `${"a".repeat(63)}\n`], ["enroll", "codex", WRONG_BINDING], []];
  for (const args of invalidArgs) {
    assert.deepEqual(await f.command("/bin/sh", [launch, ...args]), { code: 64, stdout: "", stderr: "" });
    assert.deepEqual(await f.command(process.execPath, [main, ...args]), { code: 64, stdout: "", stderr: "" });
  }
  assert.equal((await f.command("/bin/sh", [installer])).code, 0);
  assert.equal((await f.command("/bin/sh", [installer])).code, 1);
  await assert.rejects(access(f.state), { code: "ENOENT" });
  const installed = path.join(f.home, ".local/bin/herdr-quota-v1");
  await access(installed, constants.X_OK);
  assert.equal((await f.quota("read", "codex", true, WRONG_BINDING)).status, "not-enrolled");
  assert.equal(f.core.calls, 0);
  await assert.rejects(access(f.marker), { code: "ENOENT" });
  await assert.rejects(access(f.state), { code: "ENOENT" });
  await f.enroll();
  assert.equal((await f.quota("read", "codex", true)).status, "fresh");
  await chmod(installed, 0o600);
  assert.equal((await f.command("/bin/sh", argv)).code, 74);
  await chmod(installed, 0o777);
  assert.equal((await f.command("/bin/sh", argv)).code, 74);
  await rm(installed);
  await symlink("dangling", installed);
  assert.equal((await f.command("/bin/sh", argv)).code, 74);
  await rm(installed);
  await mkdir(installed);
  assert.equal((await f.command("/bin/sh", argv)).code, 74);
  await rm(installed, { recursive: true });
  await writeFile(installed, "#!/nonexistent-interpreter\n", { mode: 0o700 });
  assert.deepEqual(await f.command("/bin/sh", argv), { code: 74, stdout: "", stderr: "" });
});

function assertDenied(result, status = "not-enrolled") {
  assert.deepEqual(result, {
    version: 1, provider: "codex", status, readAt: result.readAt,
    attemptedAt: null, retryAt: null, binding: null, reading: null,
  });
}

test("wrong binding and a changed Core are denied before any provider state or CLI work", async (t) => {
  const f = await fixture(t);
  const marker = await readFile(f.marker);
  assert.equal((await lstat(f.marker)).mode & 0o777, 0o600);
  assert.equal(marker.length, 32);
  const expected = createHash("sha256").update("quota:host-binding:v1\0")
    .update(Buffer.from(CORE, "hex")).update(marker).digest("hex");
  assert.equal(f.binding, expected);
  assertDenied(await f.quota("read", "codex", true, WRONG_BINDING));
  await assert.rejects(access(f.state), { code: "ENOENT" });
  await assert.rejects(f.calls(), { code: "ENOENT" });
  const fresh = await f.quota();
  assert.equal(fresh.status, "fresh");
  const cache = await readFile(f.stateFile(), "utf8");
  assert.ok(!cache.includes(expected) && !cache.includes(CORE) && !cache.includes(marker.toString("hex")));

  await writeFile(f.stateFile(), "corrupt");
  const previousCalls = await f.calls();
  f.core.id = OTHER_CORE;
  assertDenied(await f.quota("refresh", "codex", true));
  f.core.id = CORE;
  assertDenied(await f.quota("read", "codex", true, WRONG_BINDING));
  assert.deepEqual(await f.calls(), previousCalls);
  assert.equal(await readFile(f.stateFile(), "utf8"), "corrupt");
  assert.equal((await f.quota()).status, "malformed");
});

test("missing, invalid, and oversized Core contexts fail closed without a CLI or startup path", async (t) => {
  const f = await fixture(t);
  const socket = f.env.HC_SOCKET;
  delete f.env.HC_SOCKET;
  const count = f.core.calls;
  assertDenied(await f.quota(), "unavailable");
  f.env.HC_SOCKET = path.join(f.home, "missing.sock");
  assertDenied(await f.quota(), "unavailable");
  const nonSocket = path.join(f.home, "not-a-socket");
  await writeFile(nonSocket, "");
  f.env.HC_SOCKET = nonSocket;
  assertDenied(await f.quota(), "unavailable");
  assert.equal(f.core.calls, count);
  f.env.HC_SOCKET = socket;
  f.core.version = "9.9.9";
  assertDenied(await f.quota(), "unavailable");
  f.core.version = "0.1.20";
  f.core.overflow = true;
  assertDenied(await f.quota(), "unavailable");
  const marker = await readFile(f.marker);
  assert.equal((await f.admin("enroll")).code, 1);
  assert.deepEqual(await readFile(f.marker), marker);
  f.core.overflow = false;
  f.core.hangs = true;
  assertDenied(await f.quota(), "unavailable");
  await assert.rejects(access(f.state), { code: "ENOENT" });
  await assert.rejects(f.calls(), { code: "ENOENT" });
});

test("default runtime Core authorizes through a real ancestor without an inherited socket", async (t) => {
  const local = await fixture(t, { useDefault: true });
  assert.equal(local.env.HC_SOCKET, undefined);
  assert.equal((await local.quota("read", "codex", true)).status, "fresh");
  const named = await fixture(t, { useDefault: true, session: "fixture-1" });
  assert.equal((await named.quota()).status, "fresh");
  const count = named.core.calls;
  named.env.HC_SESSION = "../fixture-1";
  assertDenied(await named.quota(), "unavailable");
  assert.equal(named.core.calls, count);
});

test("inherited Core never falls back on failure and must agree with a second existing candidate", async (t) => {
  const f = await fixture(t);
  const second = await f.startCore(f.defaultSocket);
  assert.equal((await f.quota()).status, "fresh");
  assert.equal(second.calls, 1);
  second.id = OTHER_CORE;
  assertDenied(await f.quota(), "unavailable");
  second.id = CORE;
  second.pid = 2;
  assertDenied(await f.quota(), "unavailable");
  second.pid = process.pid;
  f.env.HC_SOCKET = path.join(f.home, "never-created.sock");
  const count = second.calls;
  assertDenied(await f.quota(), "unavailable");
  assert.equal(second.calls, count);
  f.env.HC_SOCKET = f.defaultSocket;
  assert.equal((await f.quota()).status, "cached");
  assert.equal(second.calls, count + 1);
  assert.equal((await f.calls()).filter((call) => call.includes("rateLimits")).length, 1);
});

test("same-user non-ancestor Core cannot authorize provider reads even with the correct grant", async (t) => {
  const f = await fixture(t, { useDefault: true, install: false });
  const sibling = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  t.after(() => sibling.kill());
  f.core.pid = sibling.pid;
  assert.ok(Number.isInteger(sibling.pid));
  assert.equal((await f.admin()).code, 0);
  await f.enroll();
  assertDenied(await f.quota("read", "codex", true), "unavailable");
  await assert.rejects(access(f.state), { code: "ENOENT" });
  await assert.rejects(f.calls(), { code: "ENOENT" });
  f.core.pid = process.pid;
  assert.equal((await f.quota("read", "codex", true)).status, "fresh");
});

test("rotation and revocation invalidate the old grant and isolate provider history", async (t) => {
  const f = await fixture(t);
  const old = f.binding;
  const first = await f.quota();
  assert.equal(first.status, "fresh");
  const oldMarker = await readFile(f.marker);
  const oldState = await readFile(f.stateFile(), "utf8");
  const revoked = await f.admin("revoke");
  assert.deepEqual({ code: revoked.code, stdout: revoked.stdout, stderr: revoked.stderr },
    { code: 0, stdout: "", stderr: "" });
  const count = f.core.calls;
  assertDenied(await f.quota("refresh", "codex", true, old));
  assert.equal(f.core.calls, count);
  await assert.rejects(access(f.marker), { code: "ENOENT" });
  assert.equal(await readFile(f.stateFile(), "utf8"), oldState);
  assert.notEqual(await f.enroll(), old);
  assert.notDeepEqual(await readFile(f.marker), oldMarker);
  assertDenied(await f.quota("read", "codex", true, old));
  f.data.codexError = { code: -32600, message: SECRET };
  await f.config();
  const failed = await f.quota();
  assert.equal(failed.binding, f.binding);
  assert.equal(failed.reading, null);
  assert.equal(failed.status, "unavailable");
  await f.enroll();
  delete f.data.codexError;
  await f.config();
  const newGrant = await f.quota();
  assert.equal(newGrant.status, "fresh");
  assert.notEqual(newGrant.reading.account, first.reading.account);
});

test("Codex brackets all buckets in one app-server; cache validates current identity only", async (t) => {
  const f = await fixture(t);
  const fresh = await f.quota();
  assert.equal(fresh.status, "fresh");
  assert.equal(fresh.retryAt, fresh.attemptedAt + 300);
  assert.match(fresh.reading.account, /^[0-9a-f]{64}$/);
  assert.equal(fresh.reading.plan, "plus");
  assert.deepEqual(fresh.reading.windows.map(({ id, short, percent }) => [id, short, percent]), [
    ["codex:primary", "5h", 0], ["codex:secondary", "wk", 100],
    ["spark:primary", "Spark 5h", 50], ["spark:secondary", "Spark wk", 88],
    ["bucket-1:primary", "Bucket 1 1h", 7],
  ]);
  assert.deepEqual(await f.calls(), [
    "codex: initialize", "codex: initialized", "codex: account/read", "codex: account/rateLimits/read", "codex: account/read",
  ]);
  assert.equal((await lstat(f.state)).mode & 0o777, 0o700);
  assert.equal((await lstat(f.stateFile())).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(f.stateFile(), "utf8"), /private-fixture|sensitive-test-value|work_fixture_123/);
  const cached = await f.quota();
  assert.equal(cached.status, "cached");
  assert.deepEqual(cached.reading, fresh.reading);
  const manual = await f.quota("refresh");
  assert.equal(manual.status, "cooldown");
  assert.equal(manual.attemptedAt, fresh.attemptedAt);
  assert.equal(manual.retryAt, fresh.attemptedAt + 30);
  assert.equal((await f.calls()).filter((s) => s.includes("rateLimits")).length, 1);
  assert.equal((await f.calls()).filter((s) => s === "codex: account/read").length, 4);
});

test("Codex does not reuse a host-scoped reading on an old or switched account", async (t) => {
  const f = await fixture(t);
  delete f.data.codexAccount.workspaceRouting;
  delete f.data.codexAccount.userId;
  await f.config();
  const old = await f.quota();
  assert.equal(old.status, "fresh");
  assert.equal(old.reading.account, null);
  assert.equal((await f.quota()).reading, null);

  await f.changeState((state) => { state.attemptedAt -= 31; });
  f.data.codexAccount = samples().codexAccount;
  f.data.codexAccountAfter = { ...f.data.codexAccount, userId: "user_fixture_456" };
  await f.config();
  const switched = await f.quota("refresh");
  assert.equal(switched.status, "identity-changed");
  assert.equal(switched.reading, null);

  await f.changeState((state) => { state.attemptedAt -= 500; });
  delete f.data.codexAccountAfter;
  await f.config();
  const verified = await f.quota();
  assert.notEqual(verified.reading.account, null);
  f.data.codexAccount.userId = "user_fixture_456";
  await f.config();
  const dirtyCache = await f.quota();
  assert.equal(dirtyCache.status, "identity-changed");
  assert.equal(dirtyCache.reading, null);
  assert.equal(JSON.parse(await readFile(f.stateFile(), "utf8")).reading, null);
});

test("Codex rejects an account change notification or a mismatched response workspace", async (t) => {
  const f = await fixture(t);
  f.data.codexNotify = true;
  await f.config();
  assert.equal((await f.quota()).status, "identity-changed");
  await f.changeState((state) => { state.attemptedAt -= 300; });
  f.data.codexNotify = false;
  f.data.codex.accountId = "other_workspace";
  await f.config();
  assert.equal((await f.quota()).status, "identity-changed");
});

test("opaque accounts cannot be joined across separate helper installations", async (t) => {
  const [first, second] = await Promise.all([fixture(t), fixture(t)]);
  const results = await Promise.all([first.quota(), second.quota()]);
  for (const result of results) assert.match(result.reading.account, /^[0-9a-f]{64}$/);
  assert.notEqual(results[0].reading.account, results[1].reading.account);
});

test("Claude normalizes modern scoped windows and validates legacy control readings", async (t) => {
  const f = await fixture(t);
  const modern = await f.quota("read", "claude");
  assert.equal(modern.status, "fresh");
  assert.match(modern.reading.account, /^[0-9a-f]{64}$/);
  assert.equal(modern.reading.plan, "max");
  assert.deepEqual(modern.reading.windows.map(({ id, percent }) => [id, percent]), [
    ["session", 0], ["weekly_all", 100], ["weekly_scoped:Fable", 42], ["weekly_scoped:Cowork", 19],
    ["limit-1", 20], ["limit-2", 21],
  ]);
  assert.equal(modern.reading.windows[0].resetsAt, Date.parse("2029-11-04T09:00:00Z") / 1000);
  assert.deepEqual(await f.calls(), ["claude: auth status", "claude: get_usage", "claude: auth status"]);
  assert.deepEqual((await f.quota("read", "claude")).reading, modern.reading);
  await f.changeState((state) => { state.attemptedAt -= 31; state.reading.observedAt -= 31; }, "claude");
  f.data.claude = { subscription_type: SECRET, rate_limits: {
    five_hour: { utilization: 0 }, seven_day: { utilization: 100 }, seven_day_sonnet: { utilization: 59 },
  } };
  await f.config();
  const legacy = await f.quota("refresh", "claude");
  assert.equal(legacy.status, "fresh");
  assert.equal(legacy.reading.plan, null);
  assert.equal(legacy.reading.account, modern.reading.account);
  assert.deepEqual(legacy.reading.windows.map(({ id, percent }) => [id, percent]), [
    ["session", 0], ["weekly_all", 100], ["weekly_scoped:Sonnet", 59],
  ]);
});

for (const [name, payload, status] of [
  ["available with null limits", { rate_limits_available: true, rate_limits: null }, "unavailable"],
  ["available with omitted limits", { rate_limits_available: true }, "unavailable"],
  ["available with empty modern limits", { rate_limits_available: true, rate_limits: { limits: [] } }, "unavailable"],
  ["available with empty legacy window", { rate_limits_available: true, rate_limits: { five_hour: null } }, "unavailable"],
  ["only Frontier is not a plan", { rate_limits_available: true, rate_limits: { limits: [
    { kind: "frontier_credit", percent: 70 },
  ] } }, "unavailable"],
  ["percentage must be numeric", { rate_limits: { five_hour: { utilization: "0" } } }, "malformed"],
  ["absent usage payload", undefined, "malformed"],
  ["unsupported with null limits", { rate_limits_available: false, rate_limits: null }, "unsupported"],
  ["invalid boolean limits", { rate_limits_available: false, rate_limits: false }, "malformed"],
]) {
  test(`Claude usage payload: ${name}`, async (t) => {
    const f = await fixture(t);
    f.data.claude = payload;
    await f.config();
    const result = await f.quota("read", "claude", true);
    assert.deepEqual(await f.calls(), ["claude: auth status", "claude: get_usage", "claude: auth status"]);
    assert.equal(result.reading, null);
    assert.equal(result.status, status);
  });
}

test("Claude reports signed out, API-key, in-flight switch and matched control errors without raw logs", async (t) => {
  const f = await fixture(t);
  f.data.claudeAuth = { loggedIn: false, authMethod: "none" };
  await f.config();
  assert.equal((await f.quota("read", "claude")).status, "auth-expired");
  assert.deepEqual(await f.calls(), ["claude: auth status"]);
  await f.changeState((s) => { s.attemptedAt -= 900; }, "claude");
  f.data.claudeAuth = { ...samples().claudeAuth, authMethod: "api_key" };
  await f.config();
  assert.equal((await f.quota("read", "claude")).status, "unsupported");
  await f.changeState((s) => { s.attemptedAt -= 900; }, "claude");
  f.data.claudeAuth = samples().claudeAuth;
  f.data.claudeAuthAfter = { ...f.data.claudeAuth, orgId: "123e4567-e89b-12d3-a456-426614174001" };
  await f.config();
  const changed = await f.quota("read", "claude");
  assert.equal(changed.status, "identity-changed");
  assert.equal(changed.reading, null);
  await f.changeState((s) => { s.attemptedAt -= 900; }, "claude");
  delete f.data.claudeAuthAfter;
  f.data.claudeError = "Not logged in";
  await f.config();
  assert.equal((await f.quota("refresh", "claude")).status, "auth-expired");
  await f.changeState((s) => { s.attemptedAt -= 900; }, "claude");
  delete f.data.claudeError;
  delete f.data.claudeAuth.orgId;
  await f.config();
  const unverified = await f.quota("refresh", "claude");
  assert.equal(unverified.status, "unavailable");
  assert.equal(unverified.reading, null);
  assert.deepEqual((await f.calls()).slice(-3), ["claude: auth status", "claude: get_usage", "claude: auth status"]);
});

async function optInFrontier(f, mode, percent = 1) {
  // Use literal shell/tmux syntax in a valid pathname; the CLI must see this exact cwd.
  const workspace = path.join(f.home, "trusted ' $(touch INJECTED) #{host}");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(f.state, { recursive: true, mode: 0o700 });
  const file = path.join(f.state, "claude-frontier-workspace.json");
  await writeFile(file, JSON.stringify({ cwd: workspace }), { mode: 0o600 });
  const reset = new Date((now() + 20 * 86_400) * 1_000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(reset).map(({ type, value }) => [type, value]));
  const resetText = `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute}${parts.dayPeriod.toLowerCase()}` +
    " (America/Argentina/Buenos_Aires)";
  f.data.frontierScreen = "  Frontier model credit\n" +
    `  ▏━━━━━━━━━━━━    ${percent}% used\n  $278.99 of $20,000 used · Resets ${resetText}`;
  f.data.frontierWorkspace = workspace;
  f.data.frontierMode = mode;
  f.data.claude = { rate_limits_available: true, rate_limits: null };
  await f.config();
  return file;
}

test("installed opted-in Claude helper publishes Frontier credit with verified identity and safe wire projection", async (t) => {
  if (!await access("/usr/bin/tmux", constants.X_OK).then(() => true, () => false)) return t.skip("tmux unavailable");
  const f = await fixture(t);
  await optInFrontier(f);
  const reply = await f.quota("read", "claude", true);
  assert.equal(reply.status, "fresh", JSON.stringify(await f.calls()));
  assert.match(reply.reading.account, /^[0-9a-f]{64}$/);
  assert.deepEqual(reply.reading.windows, [{
    id: "frontier_credit", short: "Frontier credit", long: "Frontier credit", percent: 1,
    durationSec: null, resetsAt: reply.reading.windows[0].resetsAt, money: FRONTIER_MONEY,
  }]);
  assert.ok(Math.abs(reply.reading.windows[0].resetsAt - now() - 20 * 86_400) < 90);
  assert.doesNotMatch(JSON.stringify(reply), /\$\d|278\.99|20,000|Argentina|INJECTED/);
  assert.deepEqual(await f.calls(), ["claude: auth status", "claude: get_usage", "claude: auth status",
    "claude: interactive", "claude: interactive /usage", "claude: interactive Enter", "claude: auth status"]);
  await assert.rejects(access(path.join(f.home, "INJECTED")), { code: "ENOENT" });
  await assert.rejects(access(path.join(f.data.frontierWorkspace, "INJECTED")), { code: "ENOENT" });
  const pid = Number(await readFile(path.join(f.home, "frontier-pid"), "utf8"));
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  assert.ok(!stat || /^\d+ \(.*\) [ZX] /.test(stat), "interactive CLI must not remain running");
  const cached = await f.quota("read", "claude", true);
  assert.equal(cached.status, "cached");
  assert.deepEqual(cached.reading, reply.reading);

  const parse = (dto, provider = "claude") => parseQuotaReply({ code: 0, stdout: JSON.stringify(dto) },
    { provider, binding: f.binding, now: cached.readAt, sentAt: reply.attemptedAt });
  const { data } = parse(reply);
  const projected = { ...reply.reading.windows[0], kind: "credit" };
  assert.deepEqual(projectReading(data.reading, reply.readAt, true).current.windows, [projected]);
  for (const percent of [0, 100]) {
    const dto = structuredClone(reply);
    Object.assign(dto.reading.windows[0], { percent, amountUsd: 278.99, short: "fake", long: "fake" });
    assert.deepEqual(parse(dto).data.reading.windows[0], { ...projected, percent });
  }
  for (const [key, value] of [["resetsAt", null], ["resetsAt", reply.reading.observedAt],
    ["resetsAt", reply.reading.observedAt + 62 * 86_400 + 1], ["durationSec", 3_600], ["percent", 1.5]]) {
    const dto = structuredClone(reply);
    dto.reading.windows[0][key] = value;
    assert.deepEqual(parse(dto), { reason: "malformed" });
  }
  assert.deepEqual(parse({ ...reply, reading: { ...reply.reading, account: null } }), { reason: "malformed" });
  assert.deepEqual(parse({ ...reply, provider: "codex" }, "codex"), { reason: "malformed" });
});

test("configured frontier fallback ignores unsafe sidecars and cannot bypass the provider gate", async (t) => {
  const f = await fixture(t);
  const file = await optInFrontier(f);
  const before = ["claude: auth status", "claude: get_usage", "claude: auth status"];
  const rerun = async (status, reading = false) => {
    const calls = await f.calls().catch(() => []);
    const reply = await f.quota("read", "claude", true);
    assert.equal(reply.status, status);
    assert.equal(!!reply.reading, reading);
    assert.deepEqual((await f.calls()).slice(calls.length), before);
    await rm(f.stateFile("claude"));
  };
  await chmod(file, 0o644);
  await rerun("unavailable");
  const moved = path.join(f.state, "sidecar-target");
  await writeFile(moved, JSON.stringify({ cwd: f.data.frontierWorkspace }), { mode: 0o600 });
  await rm(file);
  await symlink(moved, file);
  await rerun("unavailable");
  await rm(file);
  const linked = path.join(f.home, "workspace-link");
  await symlink(f.data.frontierWorkspace, linked);
  await writeFile(file, JSON.stringify({ cwd: linked }), { mode: 0o600 });
  await rerun("unavailable");
  await writeFile(file, `{"cwd":${JSON.stringify(linked)},"cwd":${JSON.stringify(f.data.frontierWorkspace)}}`);
  await rerun("unavailable");
  const cwd = JSON.stringify(f.data.frontierWorkspace);
  for (const members of ['"mode":"frontier-only","mode":"frontier-only"', '"mode":"unsupported"',
    '"mode":null', '"mode":"frontier-only","extra":false', `"mode":"frontier-only","cwd":${cwd}`]) {
    await writeFile(file, `{"cwd":${cwd},${members}}`);
    await rerun("unavailable");
  }
  await writeFile(file, JSON.stringify({ cwd: f.data.frontierWorkspace }));
  for (const [payload, error, status, reading] of [
    [undefined, undefined, "malformed"], [{ rate_limits_available: false }, undefined, "unsupported"],
    [undefined, "Not logged in", "auth-expired"], [undefined, "No subscription limits", "unsupported"],
    [samples().claude, undefined, "fresh", true],
  ]) {
    f.data.claude = payload;
    f.data.claudeError = error;
    await f.config();
    await rerun(status, reading);
  }
  f.data.claude = { rate_limits_available: true };
  delete f.data.claudeAuth.orgId;
  await f.config();
  await rerun("unavailable");
  assert.equal((await f.quota("read", "codex", true)).status, "fresh");
  assert.ok(!(await f.calls()).some((call) => call.includes("interactive")));
});

for (const [scenario, status, expected] of [
  ["success", "fresh", { entered: true }],
  ["rate-limited", "rate-limited", { entered: true }],
  ["timeout", "unavailable", { entered: true }],
  ["trust", "unavailable", { entered: false }],
  ["changed before", "identity-changed", { identities: 2 }],
  ["changed after", "identity-changed", { entered: true }],
  ["missing identity", "unavailable", { identities: 1 }],
  ["invalid workspace", "unavailable", { identities: 1 }],
]) {
  test(`frontier-only ${scenario} never falls back to get_usage`, async (t) => {
    if (!await access("/usr/bin/tmux", constants.X_OK).then(() => true, () => false)) return t.skip("tmux unavailable");
    const f = await fixture(t);
    const file = await optInFrontier(f, scenario);
    const cwd = scenario === "invalid workspace" ? path.join(f.home, "missing") : f.data.frontierWorkspace;
    await writeFile(file, JSON.stringify({ mode: "frontier-only", cwd }));
    f.data.singleUsageBudget = true;
    f.data.claude = samples().claude;
    if (scenario === "timeout") f.data.frontierScreen = "Loading usage…";
    const different = { ...f.data.claudeAuth, orgId: "123e4567-e89b-12d3-a456-426614174001" };
    if (scenario === "changed before") f.data.frontierAuthBefore = different;
    if (scenario === "changed after") f.data.frontierAuthAfter = different;
    if (scenario === "missing identity") delete f.data.claudeAuth.orgId;
    await f.config();

    const result = await f.quota("read", "claude", true);
    assert.equal(result.status, status);
    const auth = "claude: auth status";
    const expectedCalls = expected.identities ? Array(expected.identities).fill(auth) :
      [auth, auth, "claude: interactive", ...(expected.entered ? ["claude: interactive /usage", "claude: interactive Enter"] : []), auth];
    assert.deepEqual(await f.calls(), expectedCalls);
    const budget = path.join(f.home, "usage-budget-spent");
    if (expected.entered) assert.equal(await readFile(budget, "utf8"), "1");
    else await assert.rejects(access(budget), { code: "ENOENT" });

    if (status === "fresh") {
      assert.match(result.reading.account, /^[0-9a-f]{64}$/);
      assert.deepEqual(result.reading.windows, [{
        id: "frontier_credit", short: "Frontier credit", long: "Frontier credit", percent: 1,
        durationSec: null, resetsAt: result.reading.windows[0].resetsAt, money: FRONTIER_MONEY,
      }]);
      assert.ok(result.reading.windows[0].resetsAt > result.readAt);
      assert.doesNotMatch(JSON.stringify(result), /\$\d|278\.99|20,000|Argentina|INJECTED/);
      for (const [op, status] of [["read", "cached"], ["refresh", "cooldown"]]) {
        const deferred = await f.quota(op, "claude", true);
        assert.equal(deferred.status, status);
        assert.deepEqual(deferred.reading, result.reading);
      }
      const cachedCalls = [...expectedCalls, auth, auth, auth, auth];
      assert.deepEqual(await f.calls(), cachedCalls);

      const elapsed = 301;
      await f.changeState((state) => {
        state.attemptedAt -= elapsed;
        state.reading.observedAt -= elapsed;
      }, "claude");
      await rm(budget);
      f.data.frontierMode = "rate-limited";
      await f.config();
      const limited = await f.quota("read", "claude", true);
      assert.equal(limited.status, "rate-limited");
      assert.deepEqual(limited.reading, { ...result.reading, source: "history",
        observedAt: result.reading.observedAt - elapsed });
      assert.equal(await readFile(budget, "utf8"), "1");
      const limitedCalls = [...cachedCalls, ...expectedCalls];
      assert.deepEqual(await f.calls(), limitedCalls);

      f.data.claudeAuth = different;
      await f.config();
      const switched = await f.quota("refresh", "claude", true);
      assert.equal(switched.status, "identity-changed");
      assert.equal(switched.reading, null);
      assert.deepEqual(await f.calls(), [...limitedCalls, auth, auth]);
    } else {
      assert.equal(result.reading, null);
      if (status === "rate-limited") {
        assert.equal(result.retryAt, result.attemptedAt + 300);
        for (const op of ["read", "refresh"]) {
          const deferred = await f.quota(op, "claude", true);
          assert.equal(deferred.status, "rate-limited");
          assert.equal(deferred.retryAt, result.retryAt);
          assert.equal(deferred.reading, null);
        }
        assert.deepEqual(await f.calls(), expectedCalls);
      }
    }
  });
}

const monthlyScreen = "  Usage credits\n  ▏━━━━━━━━━━━━    88% used\n" +
  "  $531.73 / $600.00 spent · Resets Dec 1 (America/Argentina/Buenos_Aires)";

test("Claude cache never splices a spend sidecar into plan or joins later credit to earlier plan", async (t) => {
  if (!await access("/usr/bin/tmux", constants.X_OK).then(() => true, () => false)) return t.skip("tmux unavailable");
  const f = await fixture(t);
  const plan = await f.quota("read", "claude", true);
  assert.equal(plan.status, "fresh");
  assert.equal(plan.reading.windows.some(({ id }) => id === "weekly_scoped:Fable"), true);
  await f.changeState((state) => {
    state.reading.monthlySpendLimit = { id: "monthly_spend_limit", percent: 88,
      resetsAt: null, durationSec: null, money: MONTHLY_MONEY };
  }, "claude");
  const cached = await f.quota("read", "claude", true);
  assert.equal(cached.status, "cached");
  assert.deepEqual(cached.reading, plan.reading);
  await f.changeState((state) => { state.attemptedAt -= 31; state.reading.observedAt -= 31; }, "claude");
  const file = await optInFrontier(f);
  await writeFile(file, JSON.stringify({ cwd: f.data.frontierWorkspace, mode: "frontier-only" }));
  f.data.frontierScreen += `\n\n${monthlyScreen}`;
  await f.config();
  const credit = await f.quota("refresh", "claude", true);
  assert.equal(credit.status, "fresh");
  assert.equal(credit.reading.account, plan.reading.account);
  assert.deepEqual(credit.reading.windows.map(({ id }) => id), ["frontier_credit", "monthly_spend_limit"]);
  const cooldown = await f.quota("refresh", "claude", true);
  assert.equal(cooldown.status, "cooldown");
  assert.deepEqual(cooldown.reading, credit.reading);
  assert.equal((await f.calls()).filter((c) => c === "claude: get_usage" || c === "claude: interactive Enter").length, 2);
});

for (const [name, expected, explicit = true] of [
  ["both", ["frontier_credit", "monthly_spend_limit"]],
  ["monthly-only", ["monthly_spend_limit"]],
  ["missing", ["frontier_credit"]],
  ["wrong heading", ["frontier_credit"]],
  ["duplicate heading", ["frontier_credit"]],
  ["legacy ignores monthly", ["frontier_credit"], false],
  ["invalid cached pane", []],
  ["invalid no-data pane", []],
]) {
  test(`monthly spend limit installed/helper viewer: ${name}`, async (t) => {
    if (!await access("/usr/bin/tmux", constants.X_OK).then(() => true, () => false)) return t.skip("tmux unavailable");
    const f = await fixture(t);
    const file = await optInFrontier(f);
    if (explicit) {
      await writeFile(file, JSON.stringify({ cwd: f.data.frontierWorkspace, mode: "frontier-only" }));
      f.data.singleUsageBudget = true;
    }
    const frontier = f.data.frontierScreen;
    const both = `${frontier}\n\n${monthlyScreen}`;
    f.data.frontierScreen = {
      "monthly-only": monthlyScreen,
      missing: frontier,
      "wrong heading": both.replace("Usage credits", "Claude Code and Cowork credit"),
      "duplicate heading": `${both}\n\n  Usage credits\n  Disabled`,
      "invalid cached pane": `Showing last-known usage\n${both}`,
      "invalid no-data pane": `No usage data\n${both}`,
    }[name] ?? both;
    await f.config();
    const reply = await f.quota("read", "claude", true);
    assert.equal(reply.status, expected.length ? "fresh" : "unavailable");
    assert.doesNotMatch(JSON.stringify(reply), /\$\d|531\.73|600\.00|America\/Argentina\/Buenos_Aires/);
    const calls = ["claude: auth status", ...(explicit ? [] : ["claude: get_usage"]), "claude: auth status",
      "claude: interactive", "claude: interactive /usage", "claude: interactive Enter", "claude: auth status"];
    assert.deepEqual(await f.calls(), calls);
    if (explicit) assert.equal(await readFile(path.join(f.home, "usage-budget-spent"), "utf8"), "1");
    if (!expected.length) {
      assert.equal(reply.reading, null);
      return;
    }
    const { windows } = reply.reading;
    assert.deepEqual(windows.map((w) => w.id), expected);
    const stored = JSON.parse(await readFile(f.stateFile("claude"), "utf8"));
    if (name === "monthly-only") {
      assert.equal(stored.reading, null);
      const deferred = await f.quota("read", "claude", true);
      assert.equal(deferred.status, "cooldown");
      assert.equal(deferred.reading, null);
      assert.deepEqual(await f.calls(), calls);
    } else {
      assert.deepEqual(stored.reading.windows, windows.filter((w) => w.id !== "monthly_spend_limit"));
      assert.deepEqual(stored.reading.monthlySpendLimit, windows.find((w) => w.id === "monthly_spend_limit"));
      const cached = await f.quota("read", "claude", true);
      assert.equal(cached.status, "cached");
      assert.deepEqual(cached.reading, reply.reading);
      assert.deepEqual(await f.calls(), [...calls, ...Array(explicit ? 2 : 1).fill("claude: auth status")]);
      if (name === "both") {
        await f.changeState((state) => { state.reading.monthlySpendLimit.money.resetLabel = "Feb 30"; }, "claude");
        const degraded = await f.quota("read", "claude", true);
        assert.equal(degraded.status, "cached");
        assert.deepEqual(degraded.reading.windows, [windows[0]]);
        assert.deepEqual(await f.calls(), [...calls, ...Array(4).fill("claude: auth status")]);
      }
    }
    const parse = (dto, provider = "claude") => parseQuotaReply({ code: 0, stdout: JSON.stringify(dto) },
      { provider, binding: f.binding, now: reply.readAt, sentAt: reply.attemptedAt });
    const { data } = parse(reply);
    const typed = windows.map((window) => ({ ...window, kind: window.id === "frontier_credit" ? "credit" : "spend" }));
    assert.deepEqual(projectReading(data.reading, reply.readAt, true).current.windows, typed);
    if (name !== "monthly-only") return;
    assert.deepEqual(windows, [{ id: "monthly_spend_limit", short: "Monthly usage credits", long: "Monthly usage credits",
      percent: 88, resetsAt: null, durationSec: null, money: MONTHLY_MONEY }]);
    assert.deepEqual(parse({ ...reply, provider: "codex" }, "codex"), { reason: "malformed" });
    assert.deepEqual(parse({ ...reply, reading: { ...reply.reading, account: null } }), { reason: "malformed" });
    for (const patch of [{ resetsAt: now() + 3_600 }, { durationSec: 86_400 }, { percent: 101 }]) {
      const reading = { ...reply.reading, windows: [{ ...windows[0], ...patch }] };
      assert.deepEqual(parse({ ...reply, reading }), { reason: "malformed" });
    }
    for (const percent of [0, 100]) {
      const reading = { ...reply.reading, windows: [{ ...windows[0], percent, short: "forged", amountUsd: 531.73 }] };
      assert.deepEqual(parse({ ...reply, reading }).data.reading.windows, [{ ...typed[0], percent }]);
    }
  });
}

test("monthly spend limit rollback keeps the exact old helper's Frontier cache readable", async (t) => {
  const previous = process.env.QUOTA_ROLLBACK_FIXTURE;
  if (!previous) return t.skip("set QUOTA_ROLLBACK_FIXTURE to the qualified prior module directory");
  const f = await fixture(t);
  const file = await optInFrontier(f);
  await writeFile(file, JSON.stringify({ cwd: f.data.frontierWorkspace, mode: "frontier-only" }));
  f.data.singleUsageBudget = true;
  f.data.frontierScreen += `\n\n${monthlyScreen}`;
  await f.config();
  const fresh = await f.quota("read", "claude", true);
  assert.equal(fresh.status, "fresh");
  assert.deepEqual(fresh.reading.windows.map((w) => w.id), ["frontier_credit", "monthly_spend_limit"]);
  const before = await readFile(f.stateFile("claude"), "utf8");
  const calls = await f.calls();
  const bundle = path.join(f.home, ".local/lib/herdr-quota-v1/scripts/quota");
  for (const module of ["frontier", "normalize", "providers", "state"]) {
    await copyFile(path.join(previous, `${module}.mjs`), path.join(bundle, `${module}.mjs`));
  }
  const cached = await f.quota("read", "claude", true);
  assert.equal(cached.status, "cached");
  const { money: _, short, long, ...frontier } = fresh.reading.windows[0];
  assert.deepEqual(cached.reading, { ...fresh.reading, windows: [{ ...frontier, short: "Fable/Opus", long: "Fable/Opus credit" }] });
  assert.equal(await readFile(f.stateFile("claude"), "utf8"), before);
  assert.deepEqual(await f.calls(), [...calls, "claude: auth status", "claude: auth status"]);
  assert.equal(await readFile(path.join(f.home, "usage-budget-spent"), "utf8"), "1");
});

for (const [operation, unusable] of [["read", false], ["refresh", false], ["read", true]]) {
  test(`frontier-only ${operation} withholds cached evidence when trusted cwd ${unusable ? "disappears" : "switches identity"}`, async (t) => {
    if (!await access("/usr/bin/tmux", constants.X_OK).then(() => true, () => false)) return t.skip("tmux unavailable");
    const f = await fixture(t);
    const file = await optInFrontier(f);
    await writeFile(file, JSON.stringify({ cwd: f.data.frontierWorkspace, mode: "frontier-only" }));
    f.data.singleUsageBudget = true;
    await f.config();
    const fresh = await f.quota("read", "claude", true);
    assert.equal(fresh.status, "fresh");
    const calls = await f.calls();
    assert.equal(calls.filter((call) => call === "claude: interactive Enter").length, 1);
    assert.ok(!calls.includes("claude: get_usage"));

    if (unusable) await rm(f.data.frontierWorkspace, { recursive: true });
    else {
      f.data.frontierAuthBefore = { ...f.data.claudeAuth, orgId: "123e4567-e89b-12d3-a456-426614174001" };
      await f.config();
    }
    const reply = await f.quota(operation, "claude", true);
    assert.equal(reply.status, unusable ? "unavailable" : "identity-changed");
    assert.equal(reply.reading, null);
    assert.deepEqual((await f.calls()).slice(calls.length), Array(unusable ? 1 : 2).fill("claude: auth status"));
    assert.equal(JSON.parse(await readFile(f.stateFile("claude"), "utf8")).reading, null);
  });
}

const untilBanner = "The usage page is rate limited until 5:22pm.";
const retryBanner = "The usage page is rate limited\u00a0—\u00a0try again in a moment.";
const temporaryBanner = "Claude is temporarily limiting requests to the usage page\n" +
  "  (not your usage limit). Try again in a moment.";
for (const [name, banner, replace, status, oldMeter = false] of [
  ["provisional no-data", "No usage data", true, "fresh"],
  ["provisional cache", "Failed to load usage: showing last known usage", true, "fresh", true],
  ["provisional failed load", "Couldn't load usage data", true, "fresh", true],
  ["provisional loading", "Loading usage data…", true, "fresh"],
  ["provisional refreshing seed", "Refreshing\u00a0usage...", true, "fresh", true],
  ["stable cache", "Cached usage", false, "unavailable", true],
  ["stable failed refresh seed", "Couldn't refresh usage data", false, "unavailable", true],
  ["hard rate limit", untilBanner, true, "rate-limited"],
  ["actual no-clock throttle", "The usage page is requests temporarily limited — try again in a moment.", true, "rate-limited"],
  ["seeded throttle footer", "Showing last-known usage (rate limited until 5:22pm)", true, "rate-limited", true],
  ["explicit 429", "Failed to load usage: HTTP 429\n  No usage data", true, "rate-limited"],
  ["hard trust block", "Trust this folder?", true, "unavailable"],
  ["hard auth block", "Choose login method", true, "unavailable"],
]) {
  test(`frontier-only post-submit ${name} handles delayed panel frames without resubmitting`, async (t) => {
    if (!await access("/usr/bin/tmux", constants.X_OK).then(() => true, () => false)) return t.skip("tmux unavailable");
    const f = await fixture(t);
    const file = await optInFrontier(f);
    await writeFile(file, JSON.stringify({ cwd: f.data.frontierWorkspace, mode: "frontier-only" }));
    f.data.singleUsageBudget = true;
    f.data.frontierInitial = `Settings   Usage\n  ${banner}` +
      (oldMeter ? `\n${f.data.frontierScreen.replace("1% used", "99% used")}` : "");
    if (oldMeter) assert.equal(parseFrontierCredit(f.data.frontierInitial, now()), null);
    f.data.frontierReplace = replace;
    await f.config();

    const reply = await f.quota("read", "claude", true);
    const calls = await f.calls();
    const expectedCalls = ["claude: auth status", "claude: auth status", "claude: interactive",
      "claude: interactive /usage", "claude: interactive Enter",
      ...(status === "fresh" ? ["claude: replacement frame"] : []), "claude: auth status"];
    const pid = Number(await readFile(path.join(f.home, "frontier-pid"), "utf8"));
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    assert.ok(!stat || /^\d+ \(.*\) [ZX] /.test(stat), "interactive pane must have been cleaned up");
    assert.equal(reply.status, status, JSON.stringify(calls));
    assert.deepEqual(calls, expectedCalls);
    assert.equal(await readFile(path.join(f.home, "usage-budget-spent"), "utf8"), "1");
    if (status === "fresh") {
      assert.deepEqual(reply.reading.windows.map(({ id, percent }) => [id, percent]), [["frontier_credit", 1]]);
    } else {
      assert.equal(reply.reading, null);
    }
    if (status === "rate-limited") {
      assert.equal(reply.retryAt, reply.attemptedAt + 300);
      assert.equal((await f.quota("refresh", "claude", true)).status, "rate-limited");
      assert.deepEqual(await f.calls(), expectedCalls);
    }
  });
}

for (const [mode, typed, entered, status = "unavailable", banner] of [
  ["trust", false, false], ["nonblank", false, false], ["startup-rate-limit", false, false],
  ["wrong-menu", true, false], ["multiple-selected", true, false],
  ["unconfirmed", true, false], ["empty", true, true],
  ["rate-limited", true, true, "rate-limited"], ["too-many-requests", true, true, "rate-limited"],
  ["usage-page-until", true, true, "rate-limited", untilBanner],
  ["usage-page-retry", true, true, "rate-limited", retryBanner],
  ["usage-page-temporary", true, true, "rate-limited", temporaryBanner],
  ["startup-page-rate-limit", false, false, "unavailable", temporaryBanner],
  ["trust-after-enter", true, true, "unavailable", `Trust this folder?\n  ${untilBanner}`],
  ["ambiguous-no-data", true, true, "unavailable", "Rate limited."],
  ["not-a-full-banner", true, true, "unavailable", `Not a warning: ${untilBanner}`],
  [undefined, true, true, "identity-changed"],
]) {
  test(`installed Claude fallback refuses ${mode ?? "changed identity"} without a fresh reading`, async (t) => {
    if (!await access("/usr/bin/tmux", constants.X_OK).then(() => true, () => false)) return t.skip("tmux unavailable");
    const f = await fixture(t);
    await optInFrontier(f, mode);
    if (banner) {
      f.data.frontierScreen = mode === "startup-page-rate-limit" ? banner :
        `Settings   Usage\n  ${banner}\n  No usage data\n  ${SECRET}\n${f.data.frontierScreen}`;
      await f.config();
    }
    if (status === "identity-changed") {
      f.data.frontierAuthAfter = { ...f.data.claudeAuth, orgId: "123e4567-e89b-12d3-a456-426614174001" };
      await f.config();
    }
    const result = await f.quota("read", "claude", true);
    assert.equal(result.status, status);
    assert.equal(result.reading, null);
    assert.doesNotMatch(JSON.stringify(result), /5:22pm|usage page|temporarily limiting|No usage data|Too many requests|Rate limited/i);
    const calls = await f.calls();
    assert.ok(calls.includes("claude: interactive"), JSON.stringify(calls));
    assert.equal(calls.includes("claude: interactive /usage"), typed);
    assert.equal(calls.includes("claude: interactive Enter"), entered);
    if (status === "rate-limited") {
      const deferred = await f.quota("refresh", "claude", true);
      assert.equal(deferred.status, "rate-limited");
      assert.equal(deferred.retryAt, result.attemptedAt + 300);
      assert.deepEqual(await f.calls(), calls);
    }
  });
}

test("aborting the installed fallback cleans up its private terminal and cannot publish a reading", async (t) => {
  if (!await access("/usr/bin/tmux", constants.X_OK).then(() => true, () => false)) return t.skip("tmux unavailable");
  const f = await fixture(t);
  await optInFrontier(f);
  f.data.frontierScreen = "Loading usage…";
  await f.config();
  const child = spawn(path.join(f.home, ".local/bin/herdr-quota-v1"), ["read", "claude", f.binding],
    { cwd: f.home, env: f.env, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (text) => { output += text; });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => { child.kill(); await closed; });
  let submitted = false;
  for (let i = 0; i < 200 && !submitted; i++) {
    submitted = (await f.calls().catch(() => [])).includes("claude: interactive Enter");
    if (!submitted) await delay(25);
  }
  assert.ok(submitted);
  const pid = Number(await readFile(path.join(f.home, "frontier-pid"), "utf8"));
  child.kill("SIGTERM");
  assert.equal(await closed, 0);
  assert.equal(JSON.parse(output).reading, null);
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  assert.ok(!stat || /^\d+ \(.*\) [ZX] /.test(stat), "aborted interactive CLI must not remain running");
});

test("same verified identity gets dated evidence after failures, never reset-to-zero", async (t) => {
  const f = await fixture(t);
  const fresh = await f.quota();
  await f.changeState((s) => {
    for (const w of s.reading.windows) w.resetsAt = now() - 2;
  });
  const expired = await f.quota();
  assert.equal(expired.status, "waiting-reset");
  assert.equal(expired.reading.source, "history");
  assert.equal(expired.reading.observedAt, fresh.reading.observedAt);
  assert.equal(expired.reading.windows[1].percent, 100);

  await f.changeState((s) => { s.attemptedAt -= 900; s.reading.observedAt -= 900; });
  f.data.codexError = { code: -32600, data: { status: 429 }, message: SECRET };
  await f.config();
  const failed = await f.quota("refresh");
  assert.equal(failed.status, "rate-limited");
  assert.equal(failed.retryAt - failed.attemptedAt, 300);
  assert.equal(failed.reading.source, "history");
  assert.equal(failed.reading.observedAt, fresh.reading.observedAt - 900);
  const deferred = await f.quota("refresh");
  assert.equal(deferred.attemptedAt, failed.attemptedAt);
  assert.deepEqual(deferred.reading, failed.reading);
  assert.equal((await f.calls()).filter((s) => s.includes("rateLimits")).length, 2);
  await f.changeState((s) => { s.attemptedAt -= 300; });
  const backoff = await f.quota("refresh");
  assert.equal(backoff.retryAt - backoff.attemptedAt, 600);
  await f.changeState((s) => { s.reading.observedAt -= 14 * 86400; });
  assert.equal((await f.quota()).reading, null);
});

test("missing CLI is cached for an hour; installing a CLI or reading another pair does not force retries", async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.bin, "codex"));
  const missing = await f.quota();
  assert.equal(missing.status, "missing-cli");
  assert.equal(missing.retryAt, missing.attemptedAt + 3600);
  await symlink("codex.mjs", path.join(f.bin, "codex"));
  const retry = await f.quota("refresh");
  assert.deepEqual({ ...retry, readAt: missing.readAt }, missing);
  assert.equal((await f.quota("refresh", "claude")).status, "fresh");
  assert.ok((await f.calls()).every((item) => item.startsWith("claude:")));
});

test("alternate authentication selectors fail closed without a different login or probe", async (t) => {
  const f = await fixture(t);
  f.env.OPENAI_API_KEY = SECRET;
  f.env.CLAUDE_CODE_OAUTH_TOKEN = SECRET;
  for (const provider of ["codex", "claude"]) {
    const result = await f.quota("refresh", provider);
    assert.equal(result.status, "unsupported");
    assert.equal(result.reading, null);
    assert.equal(result.attemptedAt, null);
  }
  await assert.rejects(access(f.state), { code: "ENOENT" });
  await assert.rejects(f.calls(), { code: "ENOENT" });
});

test("malformed provider payloads, future state and untrusted paths are refused", async (t) => {
  const f = await fixture(t);
  f.data.codex.rateLimitsByLimitId.codex.secondary.usedPercent = "100";
  await f.config();
  assert.equal((await f.quota()).status, "malformed");
  await f.changeState((s) => { s.attemptedAt -= 300; });
  f.data.codexBad = "flood";
  await f.config();
  assert.equal((await f.quota()).status, "malformed");
  await f.changeState((s) => { s.version = 99; });
  const callCount = (await f.calls()).length;
  assert.equal((await f.quota()).status, "malformed");
  assert.equal((await f.calls()).length, callCount);

  const sentinel = path.join(f.home, "sentinel");
  await writeFile(sentinel, SECRET);
  await rm(f.stateFile());
  await symlink(sentinel, f.stateFile());
  assert.equal((await f.quota()).status, "malformed");
  assert.equal(await readFile(sentinel, "utf8"), SECRET);
  await rm(f.stateFile());
  await symlink(sentinel, `${f.stateFile()}.lock`);
  assert.equal((await f.quota()).status, "malformed");
  assert.equal(await readFile(sentinel, "utf8"), SECRET);
  await rm(f.state, { recursive: true });
  await symlink(f.home, f.state);
  assert.equal((await f.quota()).status, "unavailable");
  assert.equal((await f.calls()).length, callCount);
});

test("rejects a codex session-log fallback with no verified account binding", async (t) => {
  const f = await fixture(t);
  const logs = path.join(f.home, ".codex/sessions");
  await mkdir(logs, { recursive: true });
  await writeFile(path.join(logs, "existing.jsonl"), JSON.stringify({
    timestamp: new Date().toISOString(), payload: { rate_limits: {
      plan_type: "plus", primary: { used_percent: 75, window_minutes: 300, resets_at: now() + 100 },
    } },
  }));
  f.data.codexError = { code: -32600, message: SECRET };
  await f.config();
  const result = await f.quota();
  assert.equal(result.status, "unavailable");
  assert.equal(result.reading, null);
});

test("deadlines kill the process group, not just the fake CLI's root process", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.bin, "hang"), `#!/bin/sh
/bin/sleep 60 &
printf '%s' "$!" > "$HOME/pid"
wait "$!"
`, { mode: 0o700 });
  const context = { env: f.env, cwd: f.home, deadline: performance.now() + 500 };
  await assert.rejects(runCli("hang", [], context), { status: "timeout" });
  const pid = Number(await readFile(path.join(f.home, "pid"), "utf8"));
  for (let tries = 0; tries < 20; tries++) {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!stat || /^\d+ \(.*\) [ZX] /.test(stat)) return;
    await delay(20);
  }
  assert.fail("running descendant survived process-group cleanup");
});

test("parallel invocations share the grant, defer the same provider, and fence rotation", async (t) => {
  const f = await fixture(t);
  f.data.codexHang = true;
  await f.config();
  const controller = new AbortController();
  const inProgress = exec(process.execPath, [main, "read", "codex", f.binding], {
    env: f.env, signal: controller.signal, timeout: 19_000,
  }).catch((error) => error);
  t.after(async () => { controller.abort(); await inProgress; });
  for (let i = 0; i < 200; i++) {
    try { await access(path.join(f.home, "active")); break; }
    catch (error) {
      if (error.code !== "ENOENT" || i === 199) throw error;
      await delay(20);
    }
  }
  const [competing, claude] = await Promise.all([f.quota("refresh"), f.quota("refresh", "claude")]);
  assert.equal(competing.status, "in-flight");
  assert.equal(competing.reading, null);
  assert.equal(claude.status, "fresh");
  assert.equal((await f.calls()).filter((s) => s.includes("rateLimits")).length, 1);
  const lock = `${f.marker}.lock`;
  assert.equal((await f.command("/usr/bin/flock", ["-x", "-n", lock, "/bin/true"])).code, 1);
  const old = f.binding;
  const rotated = f.enroll();
  controller.abort();
  await inProgress;
  assert.notEqual(await rotated, old);
  assertDenied(await f.quota("read", "codex", true, old));
});
