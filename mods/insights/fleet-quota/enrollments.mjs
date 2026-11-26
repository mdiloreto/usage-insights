import { VERSION, readGrants } from "./protocol.mjs";

export const ENROLLMENT_OBSERVE_MS = 5_000;
const MAX_AGE_MS = 2 * ENROLLMENT_OBSERVE_MS;
const IO_LEASE_MS = MAX_AGE_MS;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_REVOCATIONS = 128;
const READ_BATCH = 4;
const RUNTIME_KEY = Symbol.for("usage-insights.fleet-quota.enrollments");
const REASONS = ["route-removed", "core-replaced", "receiver-binding-mismatch"];
const marker = (reason) => `${JSON.stringify({ version: VERSION, reason })}\n`;
const MARKERS = new Map(REASONS.map((reason) => [marker(reason), reason]));
const GRANT_FIELDS = ["version", "route", "generation", "coreDigest", "binding", "enabled", "providers"];
const ENVELOPE_FIELDS = ["version", "grants"];
const exactFields = (value, fields) => value && !Array.isArray(value) && typeof value === "object" &&
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const within = (started, now, limit) => now !== null && now >= started && now - started < limit;

function operation(started) {
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });
  return { started, promise, finish };
}

function decode(text) {
  if (text === null) return [];
  // The v1 envelope and every accepted field are ASCII, so chars bound UTF-8 bytes.
  if (typeof text !== "string" || text.length > MAX_FILE_BYTES || /[^\x00-\x7f]/.test(text)) return null;
  const data = JSON.parse(text);
  if (!exactFields(data, ENVELOPE_FIELDS) || data.version !== VERSION || !Array.isArray(data.grants) ||
    data.grants.length > MAX_REVOCATIONS || !data.grants.every((row) => exactFields(row, GRANT_FIELDS))) return null;
  const grants = readGrants(data.grants);
  if (!grants) return null;
  const rows = [...grants.values()];
  return new Set(rows.map((row) => row.generation)).size === rows.length ? rows.map((row) =>
    Object.freeze({ version: VERSION, ...row, providers: Object.freeze(row.providers) })) : null;
}

/**
 * Both native views call observe() from their mounted timer and pass readEnrollments/
 * invalidateEnrollment to the coordinator. Never expose the private snapshot in UI or logs.
 * Stage only with approval: create real, viewer-owned directories (0700 for fleet-quota,
 * no symlinks), then atomically publish a mode-0600 file from a same-directory temp under
 * umask 077. Keep tombstones while their generation could be restored; never reuse a generation.
 */
export function createQuotaEnrollmentStore({
  appHome, checking, readTextFile, writeTextFile, monotonic = () => globalThis.performance.now(),
  runtimeGlobal = globalThis,
} = {}) {
  function live() {
    try { return checking() === false; } catch { return false; }
  }

  function time() {
    try {
      const value = monotonic();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch { return null; }
  }

  function state(initialize = false) {
    if (!live() || typeof readTextFile !== "function" || typeof writeTextFile !== "function") return null;
    try {
      const root = appHome();
      if (typeof root !== "string" || !root.startsWith("/") || root.length > 4_096 ||
        /[\0\r\n]/.test(root) || root.split("/").some((part) => part === "." || part === "..")) return null;
      const home = root.replace(/\/+$/, "");
      if (!home) return null;
      const dir = `${home}/data/fleet-quota`;
      if (initialize && !(RUNTIME_KEY in runtimeGlobal)) {
        runtimeGlobal[RUNTIME_KEY] = { version: VERSION, dir, rows: null, view: null, grants: null, blocked: false,
          loaded: null, attempted: null, observing: null, writer: null, revocations: new Map() };
      }
      const current = runtimeGlobal[RUNTIME_KEY];
      return current?.version === VERSION && current.dir === dir && !current.blocked &&
        current.revocations instanceof Map ? current : null;
    } catch { return null; }
  }

  const tombstone = (s, row) => `${s.dir}/revoked-${row.generation}.json`;
  const disabled = (row, reason) => Object.freeze({ ...row, enabled: false, invalidated: reason });
  const active = (s, key, job, now = time()) => s[key] === job && runtimeGlobal[RUNTIME_KEY] === s &&
    !s.blocked && live() && within(job.started, now, IO_LEASE_MS);

  function update(s) {
    // Keep a durable revocation overlaid until any earlier read settles or expires.
    if (!s.observing) {
      s.rows = s.rows?.map((row) => {
        const entry = s.revocations.get(row.generation);
        return entry?.confirmed && row.enabled ? disabled(row, entry.reason) : row;
      }) ?? null;
      for (const [generation, entry] of s.revocations) {
        if (entry.confirmed) s.revocations.delete(generation);
      }
    }
    s.view = s.rows === null ? null : Object.freeze(s.rows.map((row) => {
      const entry = s.revocations.get(row.generation);
      return entry && row.enabled ? disabled(row, entry.reason) : row;
    }));
  }

  function readEnrollments() {
    const s = state();
    if (!s) return null;
    const now = time();
    return s.loaded !== null && within(s.loaded, now, MAX_AGE_MS) ? s.view : null;
  }

  async function load(s, job) {
    try {
      if (!active(s, "observing", job)) return null;
      const config = `${s.dir}/enrollments.json`;
      const text = await readTextFile(config);
      if (!active(s, "observing", job)) return null;
      const grants = decode(text);
      if (!grants) return null;
      const rows = [];
      for (let i = 0; i < grants.length; i += READ_BATCH) {
        const group = await Promise.allSettled(grants.slice(i, i + READ_BATCH).map(async (row) => {
          if (!row.enabled) return row;
          const saved = await readTextFile(tombstone(s, row));
          if (saved === null) return row;
          const reason = MARKERS.get(saved);
          return reason ? disabled(row, reason) : null;
        }));
        if (!active(s, "observing", job) ||
          group.some((result) => result.status !== "fulfilled" || !result.value)) return null;
        rows.push(...group.map((result) => result.value));
      }
      return grants.length && await readTextFile(config) !== text ? null : { grants, rows };
    } catch {
      // The caller invalidates the snapshot without exposing native error text.
      return null;
    }
  }

  function finishObservation(s, job, result) {
    if (s.observing !== job) return;
    const accepted = result && active(s, "observing", job);
    if (accepted) s.grants = result.grants;
    s.rows = accepted ? result.rows : null;
    s.loaded = accepted ? job.started : null;
    s.observing = null;
    update(s);
    job.finish(accepted ? true : null);
  }

  async function observe() {
    const s = state(true);
    if (!s) return null;
    const now = time();
    if (now === null) return null;
    // The originating view's native task may never resolve after disposal.
    if (s.observing && !active(s, "observing", s.observing, now)) finishObservation(s, s.observing, null);
    pumpWrites(s, now);
    if (s.observing) return s.observing.promise;
    if (s.attempted !== null && within(s.attempted, now, ENROLLMENT_OBSERVE_MS)) {
      return readEnrollments() === null ? null : true;
    }
    s.attempted = now;
    const job = operation(now);
    s.observing = job;
    void load(s, job).then((result) => finishObservation(s, job, result));
    return job.promise;
  }

  async function persist(s, job) {
    if (!active(s, "writer", job)) return null;
    const { entry } = job;
    const path = tombstone(s, entry);
    // An expired native write can finish, but can only create this immutable tombstone.
    try { await writeTextFile(path, marker(entry.reason), null); } catch { /* Another viewer may have won. */ }
    if (!active(s, "writer", job)) return null;
    try { return MARKERS.get(await readTextFile(path)) ?? null; } catch { return null; }
  }

  function finishWrite(s, job, reason) {
    if (s.writer !== job) return;
    const accepted = !!reason && active(s, "writer", job);
    if (accepted) {
      const { entry } = job;
      entry.reason = reason;
      entry.confirmed = true;
    }
    s.writer = null;
    update(s);
    job.finish(accepted);
  }

  function pumpWrites(s, now) {
    if (s.writer && !active(s, "writer", s.writer, now)) finishWrite(s, s.writer, null);
    if (s.writer) return s.writer;
    // Retry authorized intents only. Rotate attempts so one stalled generation
    // cannot take every recovered slot ahead of the other pending intents.
    let entry;
    for (const item of s.revocations.values()) {
      if (item.confirmed) continue;
      if (item.attempted === null) {
        entry = item;
        break;
      }
      if (!within(item.attempted, now, ENROLLMENT_OBSERVE_MS)) entry ??= item;
    }
    if (!entry) return null;
    entry.attempted = now;
    s.revocations.delete(entry.generation);
    s.revocations.set(entry.generation, entry);
    const job = { ...operation(now), entry };
    s.writer = job;
    void persist(s, job).then((reason) => finishWrite(s, job, reason));
    return job;
  }

  async function invalidateEnrollment(intent) {
    const s = state();
    if (!s) return false;
    const { route, generation, reason } = intent ?? {};
    const now = time();
    if (now === null || !REASONS.includes(reason) ||
      !s.grants?.some((row) => row.enabled && row.route === route && row.generation === generation)) return false;
    if (s.rows?.some((row) => row.generation === generation && row.invalidated)) return true;
    let entry = s.revocations.get(generation);
    if (!entry) {
      if (s.revocations.size >= MAX_REVOCATIONS) {
        s.blocked = true;
        return false;
      }
      entry = { generation, reason, confirmed: false, attempted: null };
      s.revocations.set(generation, entry);
      update(s);
    }
    if (entry.confirmed) return true;
    const writer = pumpWrites(s, now);
    // A queued intent already blocks this runtime, but is not durable yet.
    return writer?.entry === entry ? writer.promise : false;
  }

  return Object.freeze({ observe, readEnrollments, invalidateEnrollment });
}
