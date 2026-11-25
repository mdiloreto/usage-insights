import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const MAX_STDOUT = 128 * 1024;
const PASS_ENV = [
  "HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "CODEX_HOME",
  "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

export class ProbeError extends Error {
  constructor(status) {
    super(status);
    this.status = status;
  }
}

export function cliContext(cwd, signal) {
  const env = Object.fromEntries(PASS_ENV
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  env.PATH = (env.PATH ?? "/usr/bin:/bin").split(":")
    .filter((dir) => dir.startsWith("/")).join(":") || "/usr/bin:/bin";
  env.CI = "1";
  env.DISABLE_AUTOUPDATER = "1";
  return { cwd, env, signal, deadline: performance.now() + 15_000 };
}

export function runCli(command, args, context, { input = "pipe", json, onStart, onLine, skipBanner } = {}) {
  return new Promise((resolve, reject) => {
    const remaining = context.deadline - performance.now();
    if (context.signal?.aborted) return reject(new ProbeError("unavailable"));
    if (remaining <= 0) return reject(new ProbeError("timeout"));

    const child = spawn(command, args, {
      cwd: context.cwd,
      env: context.env,
      detached: true,
      stdio: [input, "pipe", "ignore"],
    });
    let result;
    let outcome;
    let consumed = 0;
    let pending = "";
    const killGroup = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
      }
    };
    const finish = (status) => {
      if (outcome !== undefined) return;
      outcome = status;
      killGroup();
      child.stdin?.destroy();
      child.stdout.destroy();
    };
    const abort = () => finish("unavailable");
    const timer = setTimeout(() => finish("timeout"), remaining);
    context.signal?.addEventListener("abort", abort, { once: true });

    function send(value) {
      if (outcome === undefined) child.stdin.write(`${JSON.stringify(value)}\n`);
    }

    child.stdin?.on("error", () => {});
    child.once("error", (error) => finish(error.code === "ENOENT" ? "missing-cli" : "unavailable"));
    child.once("spawn", () => {
      if (outcome !== undefined) return killGroup();
      if (onStart) onStart(send);
      else child.stdin?.end();
    });
    child.once("exit", killGroup);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      if (outcome !== undefined) return;
      consumed += Buffer.byteLength(text);
      if (consumed > MAX_STDOUT) return finish("malformed");
      pending += text;
      if (!onLine) return;
      let end;
      while (outcome === undefined && (end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line || (skipBanner && !line.startsWith("{"))) continue;
        try {
          result = onLine(JSON.parse(line), send);
          if (result !== undefined) finish(null);
        } catch (error) {
          finish(error instanceof ProbeError ? error.status : "malformed");
        }
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      if (outcome === null) return resolve(result);
      if (outcome) return reject(new ProbeError(outcome));
      if (json && pending.trim()) {
        try { return resolve({ value: JSON.parse(pending), code }); }
        catch { return reject(new ProbeError("malformed")); }
      }
      reject(new ProbeError(pending.trim() ? "malformed" : "unavailable"));
    });
  });
}
