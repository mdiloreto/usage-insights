import { errorReport, okReport } from "../lib/report.js";
import { STALE_SECONDS } from "../fleet-quota/protocol.mjs";

const providers = new Set(["claude", "codex"]);
const currentStatuses = new Set(["ready", "in-flight"]);
const machineReasons = new Map([
  ["unreachable", "Machine offline"],
  ["connecting", "Connecting"],
  ["needs_login", "Machine needs login"],
  ["needs_update", "Machine needs update"],
  ["unknown", "Machine not verified"],
]);
const reasons = new Map([
  ["paused", "Quota collection not enabled on this machine"],
  ["not-enrolled", "Provider not enrolled"],
  ["offline", "Machine offline"],
  ["unverified", "Machine not verified"],
  ["disabled", "Provider disabled"],
  ["auth-expired", "Provider sign-in expired"],
  ["missing-cli", "Provider CLI not installed"],
  ["unsupported", "No usable quota windows returned"],
  ["estimated", "Estimated reading is not current"],
  ["expired", "Reading expired"],
  ["identity-changed", "Provider account changed"],
  ["enrollments-unavailable", "Could not read quota enrollment"],
  ["loading", "Waiting for a reading"],
  ["failed", "Collection failed"],
  ["unavailable", "Reading unavailable"],
  ["in-flight", "Reading in progress"],
  ["stale", "Reading stale"],
  ["waiting", "Waiting for a reading"],
  ["waiting-reset", "Waiting for a new reading after reset"],
]);
const refreshOutcomes = new Map([
  ["queued", "accepted"], ["in-flight", "busy"], ["deferred", "deferred"], ["failed", "failed"], ["fresh", "fresh"],
  ["unavailable", "unavailable"],
]);
const refreshReasons = new Map([
  ...reasons, ["cooldown", "Cooldown"], ["rate-limited", "Rate limited"],
  ["timeout", "Quota check timed out"], ["transport-unknown", "Could not reach quota helper"],
  ["auth-expired", "Provider sign-in expired"], ["owner-unavailable", "Quota coordinator unavailable"],
  ["connection-login-required", "Herdr connection needs login"],
  ["connection-update-required", "Herdr connection needs update"],
  ["receiver-unavailable", "Quota helper unavailable"], ["helper-missing", "Quota helper not installed"],
  ["binding-mismatch", "Host permission could not be verified"], ["registry-unavailable", "Machine registration unverified"],
  ["malformed", "Invalid quota response"], ["reenrollment-required", "Permission needs renewal"],
]);

const text = (value) => typeof value === "string" && /^[^\p{C}]{1,80}$/u.test(value) && value.trim() !== "";
const safePlans = new Set(["free", "pro", "plus", "max", "team", "business", "enterprise", "edu"]);
const nonPlan = new Map([
  ["frontier_credit", { kind: "credit", label: "Frontier credit" }],
  ["monthly_spend_limit", { kind: "spend", label: "Monthly usage credits" }],
]);
const windows = (value) => (Array.isArray(value) ? value : []).filter((w) =>
  text(w?.id) && !nonPlan.has(w.id) && (w.kind == null || w.kind === "plan") && text(w.short) && text(w.long)
  && Number.isFinite(w.percent) && w.percent >= 0 && w.percent <= 100
  && (w.resetsAt == null || Number.isFinite(w.resetsAt)) && (w.durationSec == null || (Number.isFinite(w.durationSec) && w.durationSec > 0)))
  .map(({ id, short, long, percent, resetsAt, durationSec }) => ({ id, short, long, percent, resetsAt, durationSec }));

const measuredReasons = new Set([null, undefined, "fresh", "cached", "cooldown", "in-flight"]);
const resetLabelPattern = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01])(?:, (?!0000)\d{4})?$/;

function observedMoney(value) {
  const { currency, usedMinor, limitMinor, resetLabel } = value ?? {};
  if ((currency !== "USD" && currency !== "$") || !Number.isSafeInteger(usedMinor) || usedMinor < 0 || Object.is(usedMinor, -0) ||
      !Number.isSafeInteger(limitMinor) || limitMinor <= 0) return undefined;
  return { currency, usedMinor, limitMinor,
    ...(text(resetLabel) && resetLabelPattern.test(resetLabel) ? { resetLabel } : {}) };
}

function currentMeasurements(value, reason, now) {
  const { observedAt } = value;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || now - observedAt >= STALE_SECONDS ||
      !measuredReasons.has(reason) || !Array.isArray(value.windows)) return [];
  return value.windows.flatMap((w) => {
    const type = nonPlan.get(w?.id);
    if (!type || (w.kind != null && w.kind !== type.kind) || !Number.isInteger(w.percent) || w.percent < 0 || w.percent > 100) return [];
    const { percent, resetsAt } = w;
    if (resetsAt == null ? type.kind === "credit" : !Number.isSafeInteger(resetsAt) || resetsAt <= now) return [];
    return [{ ...type, percent, resetsAt, observedAt, money: observedMoney(w.money) }];
  });
}

function reading(value, now) {
  if (!Number.isFinite(value?.observedAt) || value.observedAt < 0 || value.observedAt > now) return null;
  const plan = typeof value.plan === "string" ? value.plan.toLowerCase() : null;
  const source = value.source === "cli" ? "Provider CLI" : value.source === "history" ? "Dated history" : null;
  return source && okReport(source, now, windows(value.windows), safePlans.has(plan) ? plan : null, value.observedAt);
}

function projectMachine(machine, now) {
  const { state } = machine;
  const registered = machine.registered === true;
  const enabled = registered && machine.enrolled === true;
  const availability = !registered ? "unavailable" : state === "connected" ? "ready"
    : state === "unreachable" ? "offline" : state === "connecting" ? "loading" : "unavailable";
  const machineReason = !registered ? "Machine not registered"
    : state !== "connected" ? machineReasons.get(state) ?? "Machine not verified"
    : !enabled ? "Remote not enrolled" : null;
  const refreshable = {};
  const states = {};
  const refresh = {};
  for (const item of Array.isArray(machine.providers) ? machine.providers : []) {
    if (!providers.has(item?.provider)) continue;
    const { provider, status, reason } = item;
    const blocked = ["paused", "not-enrolled", "offline", "unverified", "disabled"].some((code) => status === code || reason === code);
    const providerGate = machineReason ?? (item.enrolled === false ? "Provider not enrolled" : blocked ? reasons.get(reason) ?? reasons.get(status) : null);
    const current = !providerGate && currentStatuses.has(status) && item.current?.source === "cli" ? reading(item.current, now) : null;
    const history = registered ? reading(item.history, now) : null;
    const measurements = provider === "claude" && current ? currentMeasurements(item.current, reason, now) : [];
    const unavailable = measurements.length ? "No current plan reading"
      : providerGate ?? refreshReasons.get(reason) ?? reasons.get(status) ?? "No current reading";
    const report = current?.windows.length ? current : errorReport("coordinator", unavailable, now);
    states[provider] = { report, lastGood: current ?? history, historyDetail: history,
      ...(measurements.length ? { measurements } : {}) };
    refreshable[provider] = !providerGate && item.refreshable === true;
    if (registered && item.refresh) refresh[provider] = coordinatorRefreshOutcome(item.refresh);
  }
  return { route: machine.route, label: machine.label, availability, registered, enabled, states, refreshable, reason: machineReason, refresh };
}

export function coordinatorProjection(snapshot, now) {
  if (snapshot?.version !== 1 || !Number.isFinite(now) || !Array.isArray(snapshot.remotes)) return null;
  const remotes = snapshot.remotes.filter((machine) => text(machine?.route) && text(machine.label));
  return { now, machines: remotes.filter((m) => remotes.filter(({ route }) => route === m.route).length === 1)
    .map((machine) => projectMachine(machine, now)) };
}

export function coordinatorRefreshOutcome(result) {
  const status = refreshOutcomes.get(typeof result === "string" ? result : result?.status) ?? "rejected";
  const reason = refreshReasons.get(result?.reason);
  const retryAt = result?.retryAt;
  return {
    status, ...(reason ? { reason } : {}),
    ...(Number.isFinite(retryAt) && retryAt > 0 ? { retryAt } : {}),
  };
}

export function coordinatorSource({
  coordinator, readPrefs, writePrefs, now,
  readSnapshot = (owner) => owner.snapshot(),
  requestRefresh = (owner, { route, provider }) => owner.refresh(route, provider),
}) {
  return {
    readPrefs, writePrefs,
    readProjection: () => coordinatorProjection(readSnapshot(coordinator), now()),
    refresh: (intent) => coordinatorRefreshOutcome(requestRefresh(coordinator, intent)),
  };
}
