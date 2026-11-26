import { VERSION, PROVIDERS, HISTORY_SECONDS, STALE_SECONDS, fingerprintCore, readGrants, safeRoute,
  parseMachineRegistry, parseQuotaReply, projectReading, projectLocal } from "./protocol.mjs";

export const REVISION_KEY = "fleet-quota.owner";
export const OWNER_KEY = REVISION_KEY;
export const TICK_MS = 250;
export const LEASE_MS = 2_000;
export const REGISTRY_TIMEOUT_MS = 2_000;
export const EXEC_TIMEOUT_MS = 22_000;
export const FLIGHT_MS = 28_000;
const REGISTRY_EVERY_MS = 5_000;
const NORMAL_S = 300;
const SHORT_RETRY_S = 30;
const MAX_IN_FLIGHT = 4;
const RUNTIME_KEY = Symbol.for("usage-insights.fleet-quota.runtime");
// Core 0.1.20 addr::check_name, including its terminal ID alphabet.
const coreName = (value) => safeRoute(value) && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(value) &&
  !/^t[1-9][0123456789bcdfghjkmnpqrstvwxyz]*$/.test(value);
const seconds = () => Math.floor(Date.now() / 1000);
const pairKey = (route, provider) => `${route}/${provider}`;
const grantKey = (grant) => grant && JSON.stringify(grant);
const signature = (map) => map ? JSON.stringify([...map].sort(([a], [b]) => a < b ? -1 : Number(a !== b))) : null;
const validRevision = (n) => Number.isSafeInteger(n) && n >= 0;
const uuid = (value) => typeof value === "string" && value.length === 36 &&
  /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(value);
const validSignal = (value) => value == null || (value.version === VERSION &&
  (validRevision(value.revision) || (uuid(value.runtime) && validRevision(value.term))));
const isActive = (grant, provider) => grant?.enabled && grant.providers.includes(provider);
const stateReason = (state) => ({
  unreachable: "offline", needs_login: "connection-login-required", needs_update: "connection-update-required",
  connecting: "connecting",
})[state] ?? "registry-unavailable";

function emptyPair(route, provider, grant) {
  return { route, provider, grant: grantKey(grant), nextRead: 0, nextRefresh: 0, result: null, refresh: null };
}

function machineHints(machines) {
  let hints;
  try { hints = machines(); } catch { return []; }
  if (!Array.isArray(hints) || hints.length > 129) return [];
  return [...new Set(hints.map((row) => row?.name).filter(coreName))];
}

/**
 * Use one copy per mounted, compatible view. Call tick() every TICK_MS until
 * dispose(), including while hidden. snapshot() never starts work or mutates.
 * Subscribe to REVISION_KEY in render and schedule one UI-only reread at
 * snapshot().nextUpdateAt (epoch seconds); do not notify from the tick timer.
 *
 * readEnrollments(): synchronous authoritative private array, [] if absent,
 * null if unreadable. See readGrants() for the record shape.
 * invalidateEnrollment({route,generation,reason}): atomically disable the
 * matching enabled generation (no-op on replacement). May return a promise;
 * return true once committed. Record the reason as `invalidated`. Required
 * to activate configured grants. Re-enroll with a fresh generation.
 * readLocal(): optional override for existing shared("usage-limits.state").
 * refresh(route, provider): queue or report the selected pair; the resulting
 * outcome is under snapshot().remotes[].providers[].refresh.
 * registered reflects the authoritative registry; enrolled is a live grant,
 * independent of connectivity. refreshable is false while a refresh is queued.
 */
export function createQuotaCoordinator({
  shared, setShared, exec, machines, checking, readEnrollments = () => [],
  invalidateEnrollment, readLocal = () => shared("usage-limits.state"),
  now = seconds, monotonic = () => globalThis.performance.now(),
  randomUUID = () => globalThis.crypto.randomUUID(), runtimeGlobal = globalThis, version = VERSION,
} = {}) {
  let r;
  let copy;
  let closed = false;
  let checkMode = true;

  function current() {
    return r && !r.blocked && runtimeGlobal[RUNTIME_KEY] === r && r.version === VERSION ? r : null;
  }

  function signalCompatible(block = true) {
    try {
      if (validSignal(shared(REVISION_KEY))) return true;
    } catch { /* Shared revision support is required. */ }
    if (block && r) r.blocked = true;
    return false;
  }

  function changed() {
    if (!current() || r.pendingSignal) return;
    r.pendingSignal = true;
    void Promise.resolve().then(() => {
      r.pendingSignal = false;
      if (!current() || !signalCompatible()) return;
      try {
        const prior = shared(REVISION_KEY)?.revision;
        setShared(REVISION_KEY, { version: VERSION, revision: validRevision(prior) && prior < Number.MAX_SAFE_INTEGER ?
          prior + 1 : 1 });
      } catch { r.blocked = true; }
    });
  }

  function live(s, t) {
    if (!s?.lease) return false;
    try {
      const time = t ?? monotonic();
      return Number.isFinite(time) && s.lease.until > time && s.lease.until <= time + LEASE_MS;
    } catch { return false; }
  }

  function owns(term) {
    if (closed || !r || runtimeGlobal[RUNTIME_KEY] !== r) return false;
    const s = current();
    return live(s) && s.lease.copy === copy && s.term === term;
  }

  function grants() {
    try {
      const config = readGrants(readEnrollments());
      return typeof invalidateEnrollment === "function" || ![...(config?.values() ?? [])].some((g) => g.enabled) ?
        config : null;
    } catch { return null; }
  }

  function enrolled(grant) {
    return grant?.enabled === true && !grant.invalidated &&
      r?.invalid.get(grant.route)?.generation !== grant.generation;
  }

  function grantStatus(grant, provider, registry = r?.registry) {
    if (grant?.invalidated || (grant && r?.invalid.get(grant.route)?.generation === grant.generation)) {
      return "reenrollment-required";
    }
    if (!isActive(grant, provider)) return grant?.enabled ? "paused" : "not-enrolled";
    if (!registry) return "registry-unavailable";
    const row = registry.get(grant.route);
    if (!row || row.temporary) return "reenrollment-required";
    if (row.id && fingerprintCore(row.id, grant.generation) !== grant.coreDigest) return "reenrollment-required";
    if (row.state !== "connected") return stateReason(row.state);
    if (registry.has(row.id) || [...registry.values()].some((candidate) =>
      candidate.route !== row.route && candidate.id === row.id)) return "route-ambiguous";
    return null;
  }

  function invalidate(grant, reason) {
    if (r.invalid.get(grant.route)?.generation !== grant.generation) {
      r.invalid.set(grant.route, { generation: grant.generation, reason, saved: false, pending: false });
      changed();
    }
    for (const provider of PROVIDERS) r.pairs.delete(pairKey(grant.route, provider));
  }

  function persistInvalidations(config) {
    for (const [route, failure] of r.invalid) {
      const grant = config?.get(route);
      if (!grant || grant.generation !== failure.generation) continue;
      if (!grant.enabled || failure.saved || failure.pending || !invalidateEnrollment) continue;
      const { generation, reason } = failure;
      failure.pending = true;
      // Block immediately; a failed durable CAS can be retried on a later observation.
      void Promise.resolve().then(() => invalidateEnrollment({ route, generation, reason })).then(
        (saved) => { failure.saved = saved === true; failure.pending = false; },
        () => { failure.pending = false; },
      );
    }
  }

  function applyRegistry(registry) {
    const previous = r.registry;
    const config = grants();
    if ((previous?.size || registry?.size || r.hints || config?.size) &&
      signature(previous) !== signature(registry)) changed();
    r.registry = registry;
    for (const grant of config?.values() ?? []) {
      if (grant.enabled && registry) {
        const row = registry.get(grant.route);
        if (!row || row.temporary || (row.id && fingerprintCore(row.id, grant.generation) !== grant.coreDigest)) {
          invalidate(grant, !row || row.temporary ? "route-removed" : "core-replaced");
        }
      }
    }
    persistInvalidations(config);
    // Versions stay unchanged across byte-equivalent observations. A known
    // offline/ambiguous/unknown interval fences even a subsequent reconnect.
    for (const [key, pair] of r.pairs) {
      const grant = config?.get(pair.route);
      const reason = grantStatus(grant, pair.provider, registry);
      if (grantKey(grant) !== pair.grant) {
        r.pairs.delete(key);
        changed();
      } else if (reason || grantStatus(grant, pair.provider, previous)) {
        if (pair.result || pair.refresh?.status === "in-flight") changed();
        pair.result = null;
        if (reason && pair.refresh?.status === "in-flight") {
          pair.refresh = { status: "failed", reason, retryAt: null };
        }
        if (pair.verified) {
          pair.verified = false;
          pair.nextRead = 0;
          pair.nextRefresh = 0;
        }
      }
    }
  }

  async function invoke(command, args, options) {
    try { return await exec(command, args, options); } catch { return null; }
  }

  function observe(term) {
    if (!owns(term) || !signalCompatible()) return Promise.resolve(false);
    const t = monotonic();
    if (r.scan && r.scan.until > t) return r.scan.promise;
    const scan = { until: t + REGISTRY_TIMEOUT_MS + TICK_MS };
    r.scan = scan;
    scan.promise = invoke("hc", ["machine", "ls", "--json"], { timeout: REGISTRY_TIMEOUT_MS }).then((result) => {
      if (r.scan !== scan) return false;
      r.scan = null;
      if (!owns(term) || !signalCompatible()) return false;
      const ended = monotonic();
      r.nextScan = ended + REGISTRY_EVERY_MS;
      const registry = ended < scan.until ? parseMachineRegistry(result) : null;
      r.scanBlockedUntil = registry ? 0 : r.nextScan;
      applyRegistry(registry);
      return registry !== null;
    });
    return scan.promise;
  }

  function getPair(grant, provider) {
    const key = pairKey(grant.route, provider);
    let pair = r.pairs.get(key);
    if (pair?.grant !== grantKey(grant)) {
      pair = emptyPair(grant.route, provider, grant);
      r.pairs.set(key, pair);
    }
    return pair;
  }

  function canPublish(flight, pair) {
    const grant = grants()?.get(pair.route);
    return r.flights.get(flight.key) === flight && monotonic() < flight.until && owns(flight.term) && signalCompatible() &&
      r.pairs.get(flight.key) === pair && pair.verified &&
      grantKey(grant) === pair.grant && !grantStatus(grant, pair.provider) &&
      r.registry.get(pair.route).id === flight.id;
  }

  function outcome(pair, flight, data, reason) {
    const time = now();
    const next = data?.retryAt ? time + Math.max(0, data.retryAt - data.readAt) : null;
    const ok = data && ["fresh", "cached", "cooldown", "stale", "waiting-reset"].includes(data.status);
    const suggested = data?.status === "in-flight" ? 5 : ok ? NORMAL_S : SHORT_RETRY_S;
    pair.nextRead = Math.max(time + (flight.operation === "refresh" && ok ? NORMAL_S : 1), next ?? time + suggested);
    pair.nextRefresh = ok && data.attemptedAt !== null ?
      time + Math.max(0, data.attemptedAt + SHORT_RETRY_S - data.readAt) : next ?? time + suggested;
    // Only the helper may attest older evidence for the current account. The
    // parser discards the opaque identity; prior viewer evidence is not reused.
    pair.result = data ? { ...data, term: flight.term } :
      { status: reason, readAt: null, attemptedAt: null, retryAt: null, reading: null };
    if (pair.refresh?.status === "in-flight") {
      const hasCurrent = projectReading(pair.result.reading, time, ok).current;
      pair.refresh = { status: data?.status === "fresh" && hasCurrent ? "fresh" :
        ok || data?.status === "in-flight" ? "deferred" : "failed",
      reason: data?.status ?? reason, retryAt: next ?? pair.nextRefresh };
    }
    changed();
  }

  function release(flight) {
    if (r.flights.get(flight.key) === flight) {
      r.flights.delete(flight.key);
      changed();
    }
  }

  async function collect(flight, pair, binding) {
    const result = await invoke("sh", ["-c", LAUNCHER, "herdr-quota-v1", flight.operation, pair.provider, binding],
      { on: flight.id, timeout: EXEC_TIMEOUT_MS });
    if (!canPublish(flight, pair)) {
      if (result) release(flight);
      return;
    }
    const parsed = parseQuotaReply(result, { provider: pair.provider, binding, now: now(), sentAt: flight.sentAt });
    // A registry call started before the command returned is not a post-check.
    if (r.scan) await r.scan.promise;
    const observed = canPublish(flight, pair) && await observe(flight.term);
    if (observed && canPublish(flight, pair)) {
      if (parsed.reason === "receiver-not-enrolled") {
        const config = grants();
        const grant = config?.get(pair.route);
        if (grantKey(grant) === pair.grant) {
          invalidate(grant, "receiver-binding-mismatch");
          persistInvalidations(config);
        }
      } else {
        outcome(pair, flight, parsed.data, parsed.reason);
      }
    }
    if (result) release(flight);
  }

  function candidates(config, t = now()) {
    const due = [];
    for (const grant of config?.values() ?? []) {
      for (const provider of grant.enabled ? grant.providers : []) {
        if (r.invalid.get(grant.route)?.generation === grant.generation) continue;
        const key = pairKey(grant.route, provider);
        if (r.flights.has(key)) continue;
        const pair = getPair(grant, provider);
        const queued = pair.refresh?.status === "queued";
        if (queued || pair.nextRead <= t) due.push({ pair, grant, queued });
      }
    }
    return due.sort((a, b) => Number(b.queued) - Number(a.queued));
  }

  function dispatch(term) {
    if (!owns(term) || !signalCompatible()) return;
    for (const { pair, grant, queued } of candidates(grants())) {
      if (r.flights.size >= MAX_IN_FLIGHT) return;
      const reason = grantStatus(grant, pair.provider);
      if (reason) {
        pair.nextRead = now() + 5;
        if (queued) {
          pair.refresh = { status: "failed", reason, retryAt: null };
          changed();
        }
        continue;
      }
      const id = r.registry.get(pair.route).id;
      const key = pairKey(pair.route, pair.provider);
      const flight = { key, id, term, pair, operation: queued ? "refresh" : "read", sentAt: now(),
        until: monotonic() + FLIGHT_MS };
      r.flights.set(key, flight);
      changed();
      pair.verified = true;
      if (queued) pair.refresh = { status: "in-flight", reason: null, retryAt: null };
      void collect(flight, pair, grant.binding);
    }
  }

  function mount() {
    if (closed || r) return !!r && !closed;
    try { checkMode = checking() !== false; } catch { return false; }
    if (checkMode || version !== VERSION) return false;
    try {
      if (!signalCompatible()) return false;
      const t = monotonic();
      if (!Number.isFinite(t)) return false;
      if (!(RUNTIME_KEY in runtimeGlobal)) {
        const token = randomUUID();
        if (!uuid(token)) return false;
        runtimeGlobal[RUNTIME_KEY] = { version: VERSION, token, seq: 0, term: 0, lease: null,
          ready: t + FLIGHT_MS, registry: null, nextScan: t, scanBlockedUntil: 0, initialScan: false,
          hints: "", config: "unread", pairs: new Map(), flights: new Map(), invalid: new Map() };
      }
      const runtime = runtimeGlobal[RUNTIME_KEY];
      if (runtime?.version !== VERSION || !uuid(runtime.token) || runtime.blocked || !validRevision(runtime.seq) ||
        !validRevision(runtime.term) || !(runtime.pairs instanceof Map) ||
        !(runtime.flights instanceof Map) || !(runtime.invalid instanceof Map)) return false;
      r = runtime;
      copy = ++r.seq;
      return true;
    } catch { return false; }
  }

  function tick() {
    if (!r || closed) return;
    const s = current();
    if (!s) return;
    const t = monotonic();
    if (!Number.isFinite(t)) return;
    const active = live(s, t);
    if (active && s.lease.copy !== copy) return;
    if (!active) {
      if (!signalCompatible() || s.term === Number.MAX_SAFE_INTEGER) return;
      s.term++;
      s.lease = { copy, until: t + LEASE_MS };
      changed();
    } else if (s.lease.until - t <= LEASE_MS / 2) {
      if (!signalCompatible()) return;
      s.lease.until = t + LEASE_MS;
    }
    const term = s.term;
    for (const [key, flight] of r.flights) {
      if (flight.until <= t) {
        release(flight);
        const pair = r.pairs.get(key);
        if (flight.term === term && pair === flight.pair && pair.verified && pair.nextRead <= now()) {
          outcome(pair, flight, null, "transport-unknown");
        }
        if (pair === flight.pair && pair.refresh?.status === "in-flight") {
          pair.refresh = { status: "failed", reason: "transport-unknown", retryAt: now() + SHORT_RETRY_S };
        }
      }
    }
    if (r.scan && r.scan.until <= t) {
      r.scan = null;
      r.nextScan = t + REGISTRY_EVERY_MS;
      r.scanBlockedUntil = r.nextScan;
      applyRegistry(null);
    }
    const config = grants();
    const hints = machineHints(machines).sort();
    const hintSignature = hints.join(",");
    const hintsChanged = r.hints !== hintSignature;
    const configSignature = signature(config);
    if (hintsChanged || r.config !== configSignature) {
      r.hints = hintSignature;
      r.config = configSignature;
      changed();
    }
    const due = t >= r.ready && r.flights.size < MAX_IN_FLIGHT && candidates(config).length > 0;
    const discover = !r.initialScan || hints.length > 0 || r.registry?.size > 0 ||
      [...(config?.values() ?? [])].some((grant) => grant.enabled);
    if (!r.scan && t >= r.scanBlockedUntil && (due || (discover && (hintsChanged || t >= r.nextScan)))) {
      r.initialScan = true;
      void observe(term).then((valid) => { if (valid && monotonic() >= r.ready) dispatch(term); });
    }
  }

  function refresh(route, provider) {
    const s = r && current();
    if (closed || !live(s) || !signalCompatible()) return { status: "unavailable", reason: "owner-unavailable" };
    if (!coreName(route) || !PROVIDERS.includes(provider)) return { status: "unavailable", reason: "invalid-pair" };
    const config = grants();
    if (!config) return { status: "unavailable", reason: "enrollments-unavailable" };
    const grant = config.get(route);
    const reason = grantStatus(grant, provider);
    if (reason) return { status: "unavailable", reason };
    const pair = getPair(grant, provider);
    const flight = r.flights.get(pairKey(route, provider));
    if (flight && flight.until > monotonic()) {
      if (flight.pair === pair && flight.term === s.term && pair.refresh?.status !== "in-flight") {
        pair.refresh = { status: "in-flight", reason: null, retryAt: null };
        changed();
      }
      return { status: "in-flight", reason: null, retryAt: null };
    }
    if (pair.nextRefresh > now()) {
      const status = pair.result?.status;
      const reason = ["fresh", "cached", "stale", "waiting-reset", "cooldown"].includes(status) ? "cooldown" : status;
      return { status: "deferred", reason: reason ?? "cooldown", retryAt: pair.nextRefresh };
    }
    if (pair.refresh?.status !== "queued") {
      pair.refresh = { status: "queued", reason: null, retryAt: null };
      changed();
    }
    return { ...pair.refresh };
  }

  function snapshot() {
    const time = now();
    let local = [];
    if (!checkMode) {
      try { local = projectLocal(readLocal(), time); } catch { local = projectLocal(null, time); }
    }
    const runtime = !closed && r && signalCompatible(false) ? current() : null;
    const owner = live(runtime) ? "ready" : "unavailable";
    const config = runtime ? grants() : null;
    const routes = new Set(!checkMode && !closed ? machineHints(machines) : []);
    for (const route of runtime?.registry?.keys() ?? []) routes.add(route);
    for (const route of config?.keys() ?? []) routes.add(route);
    let nextUpdateAt = null;
    const next = (at) => {
      if (at > time && (nextUpdateAt === null || at < nextUpdateAt)) nextUpdateAt = at;
    };
    const remotes = [...routes].sort().map((route) => {
      const grant = config?.get(route);
      const row = runtime?.registry?.get(route);
      return { route, label: row?.label ?? route, state: row?.state ?? "unknown",
        registered: row !== undefined, enrolled: enrolled(grant),
        providers: PROVIDERS.map((provider) => {
          const key = pairKey(route, provider);
          const pair = runtime?.pairs.get(key);
          const sameGrant = !!pair && pair.grant === grantKey(grant);
          const flight = runtime?.flights.get(key);
          const guarded = owner === "ready" && !!flight && flight.until > monotonic();
          const inFlight = sameGrant && guarded;
          const reason = !config ? (owner === "ready" ? "enrollments-unavailable" : "owner-unavailable") :
            grantStatus(grant, provider) ?? (owner === "ready" ? null : "owner-unavailable");
          const result = sameGrant ? pair.result : null;
          const eligible = !reason || reason === "owner-unavailable";
          const evidence = projectReading(eligible ? result?.reading : null, time, !reason && result?.term === runtime?.term &&
            ["fresh", "cached", "cooldown"].includes(result?.status));
          const status = reason && reason !== "owner-unavailable" ? "unavailable" :
            inFlight || (!reason && result?.status === "in-flight" && pair.nextRead > time) ? "in-flight" :
              evidence.current ? "ready" : evidence.history ? "stale" :
              reason ? "unavailable" : result ? "unavailable" : "waiting";
          const reading = result?.reading;
          const age = reading && time - reading.observedAt;
          if (eligible) next(reading?.observedAt);
          if (sameGrant) next(pair.nextRefresh);
          let detail = result?.status;
          if (!reason && reading && !evidence.current) {
            if (age >= HISTORY_SECONDS) detail = "expired";
            else if (["fresh", "cached", "cooldown"].includes(detail)) {
              if (reading.windows.every((w) => w.resetsAt !== null && w.resetsAt <= time)) detail = "waiting-reset";
              else detail = result.term !== runtime?.term || age >= STALE_SECONDS ? "stale" : "waiting";
            }
          }
          const refreshable = coreName(route) && !reason && !guarded &&
            !(sameGrant && (pair.nextRefresh > time || pair.refresh?.status === "queued"));
          return { provider, status, reason: reason ?? detail ?? null, refreshable, ...evidence,
            readAt: result?.readAt ?? null, attemptedAt: result?.attemptedAt ?? null,
            retryAt: sameGrant && pair.nextRead > time ? pair.nextRead : null,
            refreshAvailableAt: sameGrant && pair.nextRefresh > time ? pair.nextRefresh : null,
            refresh: sameGrant && pair.refresh ? { ...pair.refresh } : null };
        }) };
    });
    for (const pair of [...local, ...remotes.flatMap((row) => row.providers)]) {
      if (pair.current) {
        next(pair.current.observedAt + STALE_SECONDS);
        pair.current.windows.forEach((window) => next(window.resetsAt));
      }
      if (pair.history) next(pair.history.observedAt + HISTORY_SECONDS);
      next(pair.retryAt);
      next(pair.refresh?.retryAt);
    }
    return { version: VERSION, owner, local, remotes, nextUpdateAt };
  }

  function dispose() {
    if (closed) return;
    const s = r && current();
    closed = true;
    if (s?.lease?.copy === copy && s?.lease) {
      s.lease = null;
      changed();
    }
  }

  return { mount, tick, refresh, snapshot, dispose };
}

// Mirror scripts/quota/launch.sh; the integration fixture checks parity.
export const LAUNCHER = `#!/bin/sh
# Fixed shell body for the viewer's enrolled-host launcher; only argv varies.
[ "$#" -eq 3 ] || exit 64
case "$1:$2" in
    read:codex|read:claude|read:copilot|read:agy|refresh:codex|refresh:claude|refresh:copilot|refresh:agy) ;;
    *) exit 64 ;;
esac
[ "\${#3}" -eq 64 ] || exit 64
case "$3" in *[!0123456789abcdef]*) exit 64 ;; esac

case "$HOME" in /*) ;; *) exit 74 ;; esac
[ "$HOME" != / ] || exit 74
owner=$(/usr/bin/id -u 2>/dev/null) || exit 74
safe_owner_mode() {
    mode=$(/usr/bin/stat -c '%a' -- "$1" 2>/dev/null) || return 1
    case "$mode" in ''|*[!0-7]*) return 1 ;; esac
    [ "$(/usr/bin/stat -c '%u' -- "$1" 2>/dev/null)" = "$owner" ] &&
        [ "$((0$mode & 07022))" -eq 0 ]
}

[ -d "$HOME" ] && [ ! -L "$HOME" ] && [ -x "$HOME" ] && safe_owner_mode "$HOME" || exit 74
for dir in "$HOME/.local" "$HOME/.local/bin"; do
    [ ! -L "$dir" ] || exit 74
    [ -e "$dir" ] || exit 73
    [ -d "$dir" ] && [ -x "$dir" ] && safe_owner_mode "$dir" || exit 74
done

helper=$HOME/.local/bin/herdr-quota-v1
[ ! -L "$helper" ] || exit 74
[ -e "$helper" ] || exit 73
[ -f "$helper" ] && [ -x "$helper" ] && safe_owner_mode "$helper" || exit 74
"$helper" "$1" "$2" "$3" </dev/null 2>/dev/null &
child=$!
trap 'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 75' HUP INT TERM
wait "$child"
result=$?
case "$result" in 126|127) exit 74 ;; *) exit "$result" ;; esac
`;
