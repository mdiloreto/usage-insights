// Pure presentation and command helpers for the Quota auto-resume dashboard card.
//
// Insights is a pure UI consumer of the `quota-resume` daemon via Herdr's
// shared() / setShared() state bus. This module has zero host or gpui imports
// so it can run identically inside Herdr and in Node unit tests.

export const QUOTA_RESUME_STATE_KEY = "quota-resume.state";
export const QUOTA_RESUME_COMMAND_KEY = "quota-resume.command";
export const QUOTA_RESUME_AGENTS = ["claude", "codex", "opencode"];
export const QUOTA_RESUME_MAX_HISTORY = 5;
export const QUOTA_RESUME_TICK_MS = 15_000;

const AGENT_LABELS = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

const OUTCOME_META = {
  resumed: { label: "Resumed", tone: "done" },
  "skipped-replied": { label: "Skipped · replied", tone: "dim" },
  "skipped-closed": { label: "Skipped · closed", tone: "dim" },
  "skipped-busy": { label: "Skipped · busy", tone: "dim" },
  "skipped-session": { label: "Skipped · session changed", tone: "dim" },
  cancelled: { label: "Cancelled", tone: "dim" },
  failed: { label: "Failed", tone: "destructive" },
};

const VALID_ACTIONS = new Set([
  "toggle-enabled",
  "toggle-agent",
  "cancel",
  "resume-now",
  "clear-history",
]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatAgentLabel(agent) {
  const key = String(agent ?? "").trim().toLowerCase();
  if (!key) return "Agent";
  if (AGENT_LABELS[key]) return AGENT_LABELS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function formatMachineLabel(machine) {
  return nonEmptyString(machine) ?? "Local";
}

export function formatOutcome(outcome) {
  const key = String(outcome ?? "").trim().toLowerCase();
  if (OUTCOME_META[key]) return OUTCOME_META[key];
  if (!key) return { label: "Unknown", tone: "dim" };
  return {
    label: key.charAt(0).toUpperCase() + key.slice(1).replaceAll("-", " "),
    tone: "dim",
  };
}

export function formatCountdownMs(diffMs) {
  if (!Number.isFinite(diffMs)) return "";
  if (diffMs <= 0) return "ready";
  if (diffMs < 60_000) return `in ${Math.max(1, Math.ceil(diffMs / 1000))}s`;
  const totalMinutes = Math.ceil(diffMs / 60_000);
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `in ${days}d ${remHours}h` : `in ${days}d`;
}

export function formatQueueCountdown(item, nowMs, enabled = true) {
  const status = String(item?.status ?? "waiting");
  if (status === "resuming") return "resuming…";
  const resumeAtMs = finiteNumber(item?.resumeAtMs);
  const paused = status === "paused" || !enabled;
  if (resumeAtMs === null) return paused ? "paused" : "pending";
  const diffMs = resumeAtMs - nowMs;
  if (paused) {
    return diffMs > 0 ? `paused · ${formatCountdownMs(diffMs)}` : "paused";
  }
  return formatCountdownMs(diffMs);
}

export function formatRelativeAge(atMs, nowMs) {
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return "";
  const ageMs = Math.max(0, nowMs - atMs);
  if (ageMs < 10_000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function compareQueueEntries(left, right) {
  const leftResume = left.resumeAtMs;
  const rightResume = right.resumeAtMs;
  if (leftResume !== null && rightResume !== null && leftResume !== rightResume) {
    return leftResume - rightResume;
  }
  if (leftResume !== null && rightResume === null) return -1;
  if (leftResume === null && rightResume !== null) return 1;
  const leftDetected = left.detectedAtMs ?? Number.POSITIVE_INFINITY;
  const rightDetected = right.detectedAtMs ?? Number.POSITIVE_INFINITY;
  if (leftDetected !== rightDetected) return leftDetected - rightDetected;
  return left.address.localeCompare(right.address);
}

function buildSubtitle(enabled, queue, agents) {
  const count = queue.length;
  const machines = new Set(queue.map((item) => item.machineLabel));
  const machineSuffix = machines.size > 1 ? ` across ${machines.size} machines` : "";
  if (!enabled) {
    return count > 0 ? `Paused · ${count} waiting${machineSuffix}` : "Paused";
  }
  if (count > 0) {
    return `Active · ${count} waiting${machineSuffix}`;
  }
  const watching = agents.filter((agent) => agent.enabled).map((agent) => agent.label);
  return watching.length > 0
    ? `Active · watching ${watching.join(", ")}`
    : "Active · no agents enabled";
}

/**
 * Transform raw `shared("quota-resume.state")` into a compact UI view model.
 * Returns `null` when the daemon is not present or publishes an unsupported version.
 */
export function buildQuotaResumeView(rawState, nowMs = Date.now()) {
  if (!isPlainObject(rawState) || rawState.version !== 1) return null;

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const enabled = Boolean(rawState.enabled);
  const rawSettings = isPlainObject(rawState.settings) ? rawState.settings : {};
  const rawAgents = isPlainObject(rawSettings.agents) ? rawSettings.agents : {};

  const agents = QUOTA_RESUME_AGENTS.map((key) => ({
    key,
    label: formatAgentLabel(key),
    enabled: rawAgents[key] !== false,
  }));

  const queue = [];
  if (Array.isArray(rawState.queue)) {
    for (const entry of rawState.queue) {
      if (!isPlainObject(entry)) continue;
      const address = nonEmptyString(entry.address);
      if (!address) continue;
      const machine = nonEmptyString(entry.machine);
      const machineLabel = formatMachineLabel(machine);
      const agent = String(entry.agent ?? "").trim().toLowerCase() || "unknown";
      const agentLabel = formatAgentLabel(agent);
      const title = nonEmptyString(entry.title) ?? nonEmptyString(entry.where) ?? address;
      const where = nonEmptyString(entry.where);
      const reason = nonEmptyString(entry.reason);
      const resetSource = nonEmptyString(entry.resetSource);
      const detailParts = [];
      if (reason) detailParts.push(reason);
      if (resetSource) detailParts.push(resetSource);
      const statusRaw = nonEmptyString(entry.status);
      const status = statusRaw === "resuming" || statusRaw === "paused" ? statusRaw : "waiting";
      const detectedAtMs = finiteNumber(entry.detectedAtMs);
      const resetsAtMs = finiteNumber(entry.resetsAtMs);
      const resumeAtMs = finiteNumber(entry.resumeAtMs);
      const remainingMs = resumeAtMs !== null ? Math.max(0, resumeAtMs - now) : null;
      const countdown = formatQueueCountdown({ status, resumeAtMs }, now, enabled);

      queue.push({
        address,
        machine,
        machineLabel,
        agent,
        agentLabel,
        provider: nonEmptyString(entry.provider),
        sessionId: nonEmptyString(entry.sessionId),
        title,
        where: where && where !== title ? where : null,
        reason,
        resetSource,
        detail: detailParts.join(" · "),
        status,
        detectedAtMs,
        resetsAtMs,
        resumeAtMs,
        remainingMs,
        countdown,
        attempts: finiteNumber(entry.attempts) ?? 0,
      });
    }
  }
  queue.sort(compareQueueEntries);

  const rawHistory = Array.isArray(rawState.history)
    ? rawState.history.filter((entry) => isPlainObject(entry))
    : [];
  const sortedHistory = rawHistory
    .map((entry, index) => ({ entry, index, atMs: finiteNumber(entry.atMs) }))
    .sort((left, right) => {
      if (left.atMs !== null && right.atMs !== null && left.atMs !== right.atMs) {
        return right.atMs - left.atMs;
      }
      if (left.atMs !== null && right.atMs === null) return -1;
      if (left.atMs === null && right.atMs !== null) return 1;
      return left.index - right.index;
    });

  const history = sortedHistory.slice(0, QUOTA_RESUME_MAX_HISTORY).map(({ entry, index, atMs }) => {
    const address = nonEmptyString(entry.address) ?? "";
    const machine = nonEmptyString(entry.machine);
    const agent = String(entry.agent ?? "").trim().toLowerCase() || "unknown";
    const outcome = String(entry.outcome ?? "").trim().toLowerCase();
    const meta = formatOutcome(outcome);
    return {
      id: nonEmptyString(entry.id) ?? `${atMs ?? 0}-${address || "entry"}-${index}`,
      address,
      machine,
      machineLabel: formatMachineLabel(machine),
      agent,
      agentLabel: formatAgentLabel(agent),
      title: nonEmptyString(entry.title) ?? (address || "Session"),
      outcome,
      outcomeLabel: meta.label,
      outcomeTone: meta.tone,
      detail: nonEmptyString(entry.detail),
      atMs,
      age: formatRelativeAge(atMs, now),
    };
  });

  return {
    version: 1,
    enabled,
    updatedAtMs: finiteNumber(rawState.updatedAtMs),
    delaySec: finiteNumber(rawSettings.delaySec) ?? 60,
    subtitle: buildSubtitle(enabled, queue, agents),
    agents,
    queue,
    history,
    totalHistoryCount: sortedHistory.length,
  };
}

/**
 * Build a version-1 command payload for `setShared("quota-resume.command", ...)`.
 */
export function makeQuotaResumeCommand(action, payload = {}, nowMs = Date.now(), seq = 1) {
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Unsupported quota-resume command action: ${String(action)}`);
  }
  const atMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const sequence = Number.isFinite(seq) ? seq : 1;
  const id = `${atMs}-${sequence}`;

  if (action === "toggle-enabled") {
    return {
      version: 1,
      id,
      action,
      enabled: Boolean(payload?.enabled),
      atMs,
    };
  }
  if (action === "toggle-agent") {
    const agent = String(payload?.agent ?? "").trim().toLowerCase();
    if (!QUOTA_RESUME_AGENTS.includes(agent)) {
      throw new Error(`Unsupported quota-resume agent: ${String(payload?.agent)}`);
    }
    return {
      version: 1,
      id,
      action,
      agent,
      enabled: Boolean(payload?.enabled),
      atMs,
    };
  }
  if (action === "cancel" || action === "resume-now") {
    const address = nonEmptyString(payload?.address);
    if (!address) {
      throw new Error(`Command ${action} requires a non-empty address.`);
    }
    return {
      version: 1,
      id,
      action,
      address,
      atMs,
    };
  }
  return {
    version: 1,
    id,
    action: "clear-history",
    atMs,
  };
}
