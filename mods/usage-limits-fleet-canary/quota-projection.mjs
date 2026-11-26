const REASONS = Object.freeze({
  "auth-expired": "Provider sign-in expired",
  "binding-mismatch": "Host permission could not be verified",
  "connection-login-required": "Herdr connection needs sign-in",
  "connection-update-required": "Herdr connection needs an update",
  "connecting": "Connecting to machine",
  "enrollments-unavailable": "Could not read quota enrollment",
  "estimated": "Estimate only; no verified reading",
  "expired": "Reading expired",
  "helper-missing": "Quota helper not installed",
  "helper-unsafe": "Quota helper not safely executable",
  "identity-changed": "Provider account changed",
  "in-flight": "Checking quota",
  "malformed": "Unrecognized quota response",
  "missing-cli": "Provider CLI not installed",
  "not-enrolled": "Quotas not enabled on this machine",
  "offline": "Machine offline",
  "owner-unavailable": "Quota coordinator unavailable",
  "paused": "Provider not enabled for this machine",
  "rate-limited": "Rate limited",
  "receiver-unavailable": "Could not verify the host quota helper",
  "reenrollment-required": "Quota permission needs renewal",
  "registry-unavailable": "Machine registration unverified",
  "route-ambiguous": "Ambiguous machine route",
  "timeout": "Quota check timed out",
  "transport-unknown": "Could not reach the quota helper",
  "unavailable": "No quota reading available",
  "unsupported": "No usable quota windows returned",
  "waiting": "Waiting for a current quota reading",
  "waiting-reset": "Waiting for a reading after reset",
});

/**
 * One per compatible full view. `read` subscribes the native render and
 * schedules at most one cosmetic repaint; the lease tick never notifies.
 */
export function mountQuotaView(cx, {
  coordinator, shared, revisionKey, tickMs, observeEnrollments, enrollmentObserveMs, now = Date.now,
}) {
  let closed = false;
  let repaintAt = null;
  let repaintTimer = null;
  let enrollmentTask = null;
  const mounted = coordinator.mount();
  const observe = (taskCx) => {
    if (!closed) enrollmentTask = taskCx.spawn(async () => {
      if (!closed) await observeEnrollments();
    });
  };
  const canObserve = mounted && typeof observeEnrollments === "function";
  if (canObserve) observe(cx);
  const enrollmentTimer = canObserve ? cx.timer.every(enrollmentObserveMs, observe) : null;
  const tickTimer = mounted ? cx.timer.every(tickMs, () => {
    if (!closed) coordinator.tick();
  }) : null;
  return {
    read(renderCx) {
      if (closed) return null;
      shared(revisionKey);
      const projection = coordinator.snapshot();
      const next = projection?.version === 1 && Number.isFinite(projection.nextUpdateAt)
        ? projection.nextUpdateAt : null;
      if (next !== repaintAt) {
        repaintTimer?.cancel();
        repaintTimer = null;
        repaintAt = next;
        const delay = next === null ? 0 : next * 1_000 - now();
        if (delay > 0) repaintTimer = renderCx.timer.after(delay, (timerCx) => {
          if (closed || repaintAt !== next) return;
          repaintTimer = null;
          timerCx.notify();
        });
      }
      return projection;
    },
    dispose() {
      if (closed) return;
      closed = true;
      tickTimer?.cancel();
      enrollmentTask?.cancel();
      enrollmentTimer?.cancel();
      repaintTimer?.cancel();
      coordinator.dispose();
    },
  };
}

function windowForDisplay({ short, long, kind, percent, resetsAt, durationSec, money }, now, typed) {
  const resetAtMs = Number.isFinite(resetsAt) ? resetsAt * 1_000 : null;
  const pacePercent = resetAtMs === null || !Number.isFinite(durationSec) || durationSec <= 0
    ? null : Math.max(0, Math.min(100, (1 - (resetAtMs - now) / (durationSec * 1_000)) * 100));
  return { label: typed && kind ? long : short, usedPercent: percent, resetAtMs, pacePercent,
    ...(typed && kind ? { kind } : {}), ...(typed && money ? { money: { ...money } } : {}) };
}

function providerForDisplay(record, now, remote = false) {
  const evidence = record.current ?? record.history;
  const typed = remote && record.provider === "claude";
  const windows = (record.current?.windows ?? []).map((window) => windowForDisplay(window, now, typed));
  const history = typed ? (record.history?.windows ?? []).filter((window) => window.kind)
    .map((window) => windowForDisplay(window, now, typed)) : [];
  const planUnavailable = typed && windows.some(({ kind }) => kind === "credit" || kind === "spend") &&
    !windows.some(({ kind }) => kind === "plan");
  return {
    provider: record.provider,
    status: record.current ? "current" : record.history ? "stale"
      : record.status === "waiting" ? "unobserved" : "unavailable",
    plan: evidence?.plan ?? null,
    source: evidence?.source === "cli" ? "CLI" : evidence?.source === "history" ? "Dated reading" : null,
    reason: Object.hasOwn(REASONS, record.reason) ? REASONS[record.reason] : null,
    observedAtMs: evidence ? evidence.observedAt * 1_000 : null,
    windows,
    ...(planUnavailable ? { planUnavailable: true } : {}),
    ...(history.length ? { historyWindows: history } : {}),
  };
}

export function insightQuotaHosts(projection, localLabel, now = Date.now(), machineHints = []) {
  if (projection?.version !== 1 || !Array.isArray(projection.remotes) || !Array.isArray(projection.local)) return null;
  const local = { name: null, label: localLabel, providers: projection.local.map((record) => providerForDisplay(record, now)) };
  const remotes = projection.remotes.filter(({ registered, route }) => registered === true || machineHints.includes(route)).map((host) => ({
    name: host.route, label: host.registered ? host.label : host.route,
    providers: host.providers.map((record) => providerForDisplay(record, now, true)),
  }));
  return remotes.length || local.providers.some((provider) => provider.observedAtMs !== null) ? [local, ...remotes] : null;
}
