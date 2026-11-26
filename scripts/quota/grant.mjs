import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { directory, homeDirectory } from "./state.mjs";

export const BINDING = /^[0-9a-f]{64}$/;
const CORE_ID = /^[0-9a-f]{32}$/;
const DOMAIN = "quota:host-binding:v1\0";
const CORE_REQUEST = '{"jsonrpc":"2.0","id":1,"method":"server.status","params":{}}\n';
const CORE_LIMIT = 16 * 1024;
const CORE_DEADLINE = 2_000;
const PROC_LIMIT = 4 * 1024;
const MAX_ANCESTORS = 16;
const MARKER_BYTES = 32;

async function readOwnedFile(file, size) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.geteuid() || info.nlink !== 1 ||
      (info.mode & 0o7777) !== 0o600 || info.size !== size) throw new Error("invalid grant file");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function bundleDirectory() {
  const home = await homeDirectory();
  const local = await directory(path.join(home, ".local"));
  const lib = await directory(path.join(local, "lib"));
  return directory(path.join(lib, "herdr-quota-v1"), { privateDir: true });
}

function lockGrant(fd, exclusive) {
  return new Promise((resolve) => {
    // flock operates on the inherited open-file description; the parent holds
    // the lock until it closes its descriptor, even after flock exits.
    const child = spawn("/usr/bin/flock", [exclusive ? "-x" : "-s", "-w", exclusive ? "20" : "0.5", "3"], {
      env: {},
      stdio: ["ignore", "ignore", "ignore", fd],
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

const canonicalPath = (value) => path.isAbsolute(value) && path.resolve(value) === value;
const optionalStat = (file) => lstat(file).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});

async function defaultRuntimeSocket() {
  const session = process.env.HC_SESSION?.trim() || "default";
  if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(session) || session === "." || session === "..") {
    throw new Error("unsupported core session");
  }
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  if (!canonicalPath(runtime) || runtime === "/") throw new Error("invalid runtime directory");
  const info = await optionalStat(runtime);
  if (!info) return null;
  if (!info.isDirectory() || info.uid !== process.geteuid() || (info.mode & 0o022) !== 0) {
    throw new Error("unsafe runtime directory");
  }
  return path.join(runtime, "herdr-core", `${session}.sock`);
}

async function checkedSocket(file) {
  if (!file) return null;
  if (!canonicalPath(file) || Buffer.byteLength(file) > 107) throw new Error("invalid core socket");
  const info = await optionalStat(file);
  if (!info) return null;
  if (!info.isSocket() || info.uid !== process.geteuid()) throw new Error("unsafe core socket");
  return file;
}

const validPid = (pid) => Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff;

function coreStatus(socketPath, signal) {
  // On Linux the pinned `hc server status` can start Core. Use exactly its
  // plain-mode status RPC, with no CLI, configuration read or startup path.
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let result = Buffer.alloc(0);
    const abort = () => finish(null);
    const timer = setTimeout(abort, CORE_DEADLINE);
    function finish(status) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(status);
    }
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => socket.write(CORE_REQUEST));
    socket.on("data", (chunk) => {
      const newline = chunk.indexOf(0x0a);
      const part = newline < 0 ? chunk : chunk.subarray(0, newline);
      if (result.length + part.length > CORE_LIMIT) return finish(null);
      result = Buffer.concat([result, part]);
      if (newline < 0) return;
      try {
        const message = JSON.parse(result.toString("utf8"));
        const id = message?.result?.core?.id;
        const pid = message?.result?.pid;
        if (message?.jsonrpc === "2.0" && message.id === 1 && message.result?.version === "0.1.20" &&
          !Object.hasOwn(message, "error") && typeof id === "string" && CORE_ID.test(id) && validPid(pid)) {
          return finish({ id, pid });
        }
      } catch { /* Malformed metadata fails closed. */ }
      finish(null);
    });
    socket.once("error", abort);
    socket.once("close", abort);
    if (signal?.aborted) abort();
  });
}

async function existingCore(signal) {
  if (signal?.aborted) return null;
  const inherited = process.env.HC_SOCKET || null;
  const fallback = await defaultRuntimeSocket();
  const selected = await checkedSocket(inherited || fallback);
  if (!selected) return null;
  const alternate = inherited && fallback !== selected ? await checkedSocket(fallback) : null;
  const [status, other] = await Promise.all([
    coreStatus(selected, signal),
    alternate ? coreStatus(alternate, signal) : null,
  ]);
  if (alternate && (!other || other.id !== status?.id || other.pid !== status?.pid)) return null;
  return status;
}

async function isAncestor(expected, signal) {
  let pid = process.pid;
  const buffer = Buffer.alloc(PROC_LIMIT + 1);
  for (let depth = 0; depth < MAX_ANCESTORS && validPid(pid) && !signal?.aborted; depth++) {
    const file = await open(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let count;
    try {
      ({ bytesRead: count } = await file.read(buffer, 0, buffer.length, 0));
    } finally {
      await file.close();
    }
    if (count > PROC_LIMIT || buffer[count - 1] !== 0x0a) return false;
    const stat = buffer.toString("utf8", 0, count);
    const end = stat.lastIndexOf(") ");
    if (!stat.startsWith(`${pid} (`) || end < 0) return false;
    const parent = Number(/^[a-zA-Z] (\d+) /.exec(stat.slice(end + 2))?.[1]);
    if (!validPid(parent) || parent === pid) return false;
    if (parent === expected) return true;
    pid = parent;
  }
  return false;
}

function digest(id, marker) {
  return createHash("sha256").update(DOMAIN).update(Buffer.from(id, "hex")).update(marker).digest("hex");
}

async function readMarker(file) {
  const handle = await readOwnedFile(file, MARKER_BYTES);
  try {
    const bytes = Buffer.alloc(MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== MARKER_BYTES) throw new Error("invalid marker");
    return bytes.subarray(0, MARKER_BYTES);
  } finally {
    await handle.close();
  }
}

async function writeMarker(file, bytes) {
  const temp = `${file}.new-${randomBytes(8).toString("hex")}`;
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function withGrant(exclusive, action) {
  if (process.platform !== "linux") throw new Error("unsupported platform");
  const dir = await bundleDirectory();
  const handle = await readOwnedFile(path.join(dir, "grant.lock"), 0);
  try {
    if (!await lockGrant(handle.fd, exclusive)) throw new Error("grant busy");
    return await action(path.join(dir, "grant"));
  } finally {
    await handle.close();
  }
}

export async function withVerifiedGrant(binding, signal, action) {
  return withGrant(false, async (file) => {
    const marker = await readMarker(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!marker) return { denial: "not-enrolled" };
    const core = await existingCore(signal);
    if (!core || !await isAncestor(core.pid, signal) || signal?.aborted) return { denial: "unavailable" };
    if (!timingSafeEqual(Buffer.from(binding, "hex"), Buffer.from(digest(core.id, marker), "hex"))) {
      return { denial: "not-enrolled" };
    }
    return { report: await action() };
  }).catch(() => ({ denial: "unavailable" }));
}

export function manageGrant(operation) {
  return withGrant(true, async (file) => {
    if (operation === "revoke") {
      await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
      return null;
    }
    if (operation !== "enroll") throw new Error("invalid operation");
    const core = await existingCore();
    if (!core) throw new Error("existing core unavailable");
    const marker = randomBytes(MARKER_BYTES);
    await writeMarker(file, marker);
    return digest(core.id, marker);
  });
}
