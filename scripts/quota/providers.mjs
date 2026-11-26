import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { claudeFrontier, frontierConfig } from "./frontier.mjs";
import { ClaudeWindowsMissing, claudeUsage, codexUsage, object } from "./normalize.mjs";
import { ProbeError, runCli } from "./runtime.mjs";

const malformed = () => { throw new ProbeError("malformed"); };
const opaqueId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(v);
const email = (v) => typeof v === "string" && v.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const uuid = (v) => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const nowSec = () => Math.floor(Date.now() / 1_000);

function statusOf(error) {
  const code = object(error) ? error.data?.status ?? error.status ?? error.code : null;
  const reason = object(error) ? error.message : error;
  if (code === 401 || reason === "Not logged in" || reason === "Authentication expired") return "auth-expired";
  if (code === 429 || reason === "Rate limited") return "rate-limited";
  if (code === -32601 || reason === "No subscription limits") return "unsupported";
  return "unavailable";
}

function codexIdentity(result) {
  if (!object(result) || !Object.hasOwn(result, "account")) malformed();
  const account = result.account;
  if (account === null) {
    if (typeof result.requiresOpenaiAuth !== "boolean") malformed();
    return { status: result.requiresOpenaiAuth ? "auth-expired" : "unsupported" };
  }
  if (!object(account) || typeof account.type !== "string") malformed();
  if (account.type !== "chatgpt") return { status: "unsupported" };
  const user = opaqueId(result.userId) ? result.userId : null;
  const workspace = opaqueId(result.workspaceRouting?.chatgptAccountId)
    ? result.workspaceRouting.chatgptAccountId : null;
  return {
    status: null,
    identity: user && workspace ? [user, workspace] : null,
    workspace,
    metadata: [user, workspace, email(account.email) ? account.email : null],
  };
}

function binding(before, after) {
  if (after.status) return { status: after.status, identity: null };
  if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) {
    return { status: "identity-changed", identity: null };
  }
  return { status: null, identity: after.identity };
}

function codex(context, identityOnly) {
  let step = 0;
  let before;
  let usage;
  let status;
  let workspace;
  let observedAt;
  let changed = false;
  const methods = ["initialize", "account/read", "account/rateLimits/read", "account/read"];
  const request = (send, params) => send({ id: step + 1, method: methods[step], params });
  return runCli("codex", ["app-server"], context, {
    onStart: (send) => request(send, {
      clientInfo: { name: "herdr-quota", version: "1" },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true },
    }),
    onLine: (message, send) => {
      if (!object(message)) malformed();
      if (step >= 2 && (message.method === "account/login/completed" ||
        (message.method === "account/updated" && message.params?.reason !== "workspaceRoutingReady"))) {
        changed = true;
      }
      if (message.id !== step + 1 || typeof message.method === "string") return;
      const hasResult = Object.hasOwn(message, "result");
      const hasError = Object.hasOwn(message, "error");
      if (hasResult === hasError || (hasError && !object(message.error))) malformed();
      const error = hasError ? statusOf(message.error) : null;
      if (step === 0) {
        if (error) return { status: error };
        if (!object(message.result)) malformed();
        send({ method: "initialized" });
      } else if (step === 1) {
        if (error) return { status: error };
        before = codexIdentity(message.result);
        if (identityOnly || before.status) return { status: before.status, identity: before.identity };
      } else if (step === 2) {
        status = error;
        if (!status) {
          try { usage = codexUsage(message.result); }
          catch { status = "malformed"; }
          observedAt = nowSec();
          workspace = object(message.result) ? message.result.accountId : null;
          if (workspace != null && !opaqueId(workspace)) status = "malformed";
          else if (!status && !usage) status = "unsupported";
        }
      } else {
        if (error) return { status: status ?? error };
        if (changed || (before.workspace && opaqueId(workspace) && workspace !== before.workspace)) {
          return { status: "identity-changed" };
        }
        const bound = binding(before, codexIdentity(message.result));
        return { status: bound.status ?? status, identity: bound.identity, usage, observedAt };
      }
      step++;
      request(send, step === 2 ? {} : { refreshToken: false });
    },
  });
}

async function claudeExecutable(context) {
  for (const dir of context.env.PATH.split(":")) {
    const file = path.join(dir, "claude");
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      return file;
    } catch (error) {
      if (!["EACCES", "ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw error;
    }
  }
  throw new ProbeError("missing-cli");
}

async function claudeIdentity(executable, context) {
  const { value, code } = await runCli(executable, ["auth", "status"], context, { json: true, input: "ignore" });
  if (!object(value) || typeof value.loggedIn !== "boolean") malformed();
  if (code === 1 && value.loggedIn === false) return { status: "auth-expired" };
  if (code !== 0 || !value.loggedIn || typeof value.authMethod !== "string") malformed();
  if (value.authMethod !== "claude.ai" || (value.apiProvider != null && value.apiProvider !== "firstParty")) {
    return { status: "unsupported" };
  }
  const user = email(value.email) ? value.email : null;
  const org = uuid(value.orgId) ? value.orgId.toLowerCase() : null;
  return { status: null, identity: user && org ? [user, org] : null, metadata: [user, org] };
}

async function finishClaude(executable, context, before, result, frontier) {
  let after;
  try { after = await claudeIdentity(executable, context); }
  catch (error) { return { status: result.status ?? error.status ?? "unavailable" }; }
  const bound = binding(before, after);
  if (!bound.identity) return { status: bound.status ?? result.status ?? "unavailable" };
  const checkedAt = nowSec();
  const windows = frontier?.windows.filter((w) => w.resetsAt === null || w.resetsAt > checkedAt);
  if (windows?.length) {
    return { status: null, identity: bound.identity, observedAt: frontier.observedAt,
      usage: { plan: null, windows } };
  }
  return { ...result, identity: bound.identity };
}

async function probeClaudeFrontier(executable, context, before, cwd, status, { identityOnly = false, includeMonthly = false } = {}) {
  if (!cwd || !before.identity || context.signal?.aborted) return { status: "unavailable" };
  const env = { ...context.env, TERM: "xterm-256color", SHELL: "/bin/sh", CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" };
  delete env.CI;
  context = { ...context, cwd, env };
  // Check in the selected cwd as well: CLI wrappers may resolve differently by project.
  let current;
  try { current = binding(before, await claudeIdentity(executable, context)); }
  catch (error) { return { status: error.status ?? "unavailable" }; }
  if (!current.identity) return { status: current.status ?? "unavailable" };
  if (identityOnly) return current;
  let frontier;
  try { frontier = await claudeFrontier(executable, context, { includeMonthly }); }
  catch (error) {
    if (!(error instanceof ProbeError)) throw error;
    status = error.status;
  }
  return finishClaude(executable, context, before, { status }, frontier);
}

async function claude(context, identityOnly) {
  const executable = await claudeExecutable(context);
  const before = await claudeIdentity(executable, context);
  if (before.status) return before;
  const frontier = await frontierConfig(context.cwd);
  if (frontier?.mode === "frontier-only") {
    return probeClaudeFrontier(executable, context, before, frontier.cwd, "unavailable", { identityOnly, includeMonthly: true });
  }
  if (identityOnly) return before;
  const requestId = "herdr-quota-v1";
  const request = { type: "control_request", request_id: requestId,
    request: { subtype: "get_usage", skip_behaviors: true } };
  const input = path.join(context.cwd, `.request-${randomBytes(16).toString("hex")}`);
  const handle = await open(input, "wx+", 0o600);
  let result;
  try {
    // The pinned CLI processes this control request reliably from a regular file.
    await unlink(input);
    await handle.write(`${JSON.stringify(request)}\n`, 0, "utf8");
    result = await runCli(executable, ["-p", "--safe-mode", "--no-session-persistence",
      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], context, {
      input: handle.fd,
      skipBanner: true,
      onLine: (msg) => {
        if (!object(msg)) malformed();
        if (msg.type !== "control_response" || msg.response?.request_id !== requestId) return;
        const reply = msg.response;
        if (reply.subtype === "error") return { status: statusOf(reply.error) };
        if (reply.subtype !== "success") malformed();
        try {
          const usage = claudeUsage(reply.response);
          return { status: usage ? null : "unsupported", usage, observedAt: nowSec() };
        } catch (error) {
          if (!(error instanceof ClaudeWindowsMissing)) throw error;
          return { status: error.status, missingWindows: true };
        }
      },
    });
  } catch (error) {
    if (!(error instanceof ProbeError)) throw error;
    result = { status: error.status };
  } finally {
    await handle.close();
  }
  if (result.missingWindows && frontier?.cwd && before.identity && !context.signal?.aborted) {
    return probeClaudeFrontier(executable, context, before, frontier.cwd, result.status);
  }
  return finishClaude(executable, context, before, result);
}

export async function probe(provider, context, { identityOnly = false } = {}) {
  try {
    if (provider === "claude") {
      return await claude({ ...context, env: { ...context.env, CLAUDE_CODE_SAFE_MODE: "1" } }, identityOnly);
    }
    return await codex(context, identityOnly);
  } catch (error) {
    if (error instanceof ProbeError) return { status: error.status };
    throw error;
  }
}
