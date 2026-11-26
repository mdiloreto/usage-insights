import { ago } from "../lib/format.js";
import { effectivePrefs, isShown } from "../lib/prefs.js";
import { errorReport } from "../lib/report.js";
import { DENSITY, NO_READING, barModel, cardModel, groupWidth, isStale, sessionNumbersWidth, tightest } from "../lib/view.js";
import { PROVIDERS, REMOTE_PROVIDERS } from "../providers/index.js";

const thisComputer = "This Computer";
// Not a valid route (routes start with a letter or digit), so it can share the collapsed list with them.
export const LOCAL_COLLAPSE_KEY = "@local";
// Copilot and Antigravity appear only where the machine reports them; Claude and Codex always do.
const providersFor = (machine) => REMOTE_PROVIDERS.filter((p) => !p.optional || machine.states?.[p.id]);
const current = (w, now) => Number.isFinite(w.percent) && w.percent >= 0 && w.percent <= 100
  && (w.resetsAt == null || w.resetsAt > now);
export const isFable = (w) => /^weekly_scoped:fable$/i.test(w.id);
const isFablePreference = (value) => /^claude:weekly_scoped:fable$/i.test(value);
export const fableEnabled = (prefs) => !prefs.hiddenWindows.some(isFablePreference);
const withoutFable = (reading) => reading && { ...reading, windows: reading.windows.filter((w) => !isFable(w)) };

function currentWindows(state, now) {
  const { report } = state ?? {};
  return report?.status === "ok" && !isStale(report, now) ? report.windows.filter((w) => current(w, now)) : [];
}

function compactGroups(states, providers, prefs, now) {
  return barModel(states, prefs, now, providers).groups.map((group) => {
    if (group.spend != null) return group;
    const windows = currentWindows(states[group.providerId], now)
      .filter((w) => isShown(prefs, group.providerId, w.id) && (!isFable(w) || fableEnabled(prefs)));
    const best = tightest(windows, now);
    const segments = best ? group.segments.filter((s) => s.expired ? !isFable(s) : windows.some((w) => w.id === s.id)) : [];
    return { ...group, mark: segments.length ? null : NO_READING, segments, tight: segments.find((s) => s.id === best?.id) };
  });
}

const remoteSource = (report, now) => report?.status === "ok" ? `${report.source} · ${ago(report.observedAt, now)}` : null;

// One compact segment per provider (the tightest window), shown on a collapsed machine header.
const tightSummary = (groups) => groups.filter((g) => g.spend == null)
  .map((g) => ({ ...g, segments: g.tight ? [g.tight] : [] }));

function providerDetails(states, providers, prefs, now, remote) {
  const panel = cardModel(states, now, providers, prefs);
  for (const group of panel.groups) {
    const { report, lastGood, historyDetail } = states[group.providerId] ?? {};
    group.source = remote ? remoteSource(report, now) : (report?.status === "ok" ? report : lastGood)?.source;
    const history = remote ? historyDetail?.windows.filter((w) => !isFable(w) || fableEnabled(prefs)) : null;
    if (history?.length) {
      group.history = `Past reading (${ago(historyDetail.observedAt, now)}): ${history.map((w) => `${w.short} ${w.percent}%`).join(" · ")}`;
    }
    if (remote && group.failed) group.age ??= "No previous reading";
  }
  return panel;
}

function remoteStates(machine, now, prefs, providers) {
  return Object.fromEntries(providers.map(({ id }) => {
    const state = machine.states?.[id];
    const windows = machine.enabled && machine.availability === "ready" ? currentWindows(state, now) : [];
    const reason = machine.reason ?? state?.report?.message ?? (machine.availability === "offline" ? "Machine offline" : "No current reading");
    const history = state?.historyDetail;
    return [id, {
      report: windows.length
        ? { ...state.report, windows: windows.filter((w) => !isFable(w) || fableEnabled(prefs)) }
        : errorReport("remote", reason, now),
      lastGood: history ? { ...history, windows: [] } : null,
      historyDetail: history,
      fable: id === "claude" ? windows.find(isFable) : undefined,
    }];
  }));
}

export function fleetModels(projection, prefs, selection, localSource) {
  const { mode, selected, activeRemote, activeMachine, machines, choices } = selection;
  const now = projection.now;
  const collapsed = new Set(selection.collapsed);
  const remotePrefs = effectivePrefs({ showResetTime: prefs.showResetTime, hiddenWindows: prefs.hiddenWindows.filter(isFablePreference) });
  const forRemote = (machine) => {
    const { route, label } = machine;
    const providers = providersFor(machine);
    const states = remoteStates(machine, now, remotePrefs, providers);
    const groups = compactGroups(states, providers, remotePrefs, now);
    return {
      route, label, machine, groups, summary: tightSummary(groups), collapsed: collapsed.has(route),
      panel: providerDetails(states, providers, remotePrefs, now, true),
      fable: states.claude.fable,
    };
  };
  const states = localSource.local ?? {};
  const localFable = currentWindows(states.claude, localSource.now).find(isFable);
  const localDetails = states.claude && !(localFable && fableEnabled(prefs)) ? { ...states, claude: {
    ...states.claude, report: withoutFable(states.claude.report), lastGood: withoutFable(states.claude.lastGood),
  } } : states;
  const localGroups = compactGroups(states, PROVIDERS, prefs, localSource.now);
  const local = { route: null, label: thisComputer, groups: localGroups, summary: tightSummary(localGroups),
    collapsed: collapsed.has(LOCAL_COLLAPSE_KEY),
    panel: providerDetails(localDetails, PROVIDERS, prefs, localSource.now, false), fable: localFable };
  const remotes = machines.map(forRemote);
  const groupFor = (machine) => remotes.find(({ route }) => route === machine.route) ?? forRemote(machine);
  const groups = mode === "combined"
    ? [local, selected ? groupFor(selected) : { label: choices.length ? "Choose remote" : "No remote available", groups: [] }]
    : [activeRemote ? groupFor(activeRemote) : activeMachine === null ? local : { label: "Active machine unknown", groups: [] }];
  return { local, remotes, groups, selection };
}

const labelWidth = (label) => Math.ceil(7.5 * label.length + 8);
const hostWidth = (host, density) => labelWidth(host.label) + host.groups.reduce((sum, g) =>
  sum + labelWidth(g.name) + groupWidth(g, density) + 10 + (g.mark == null ? 0 : 16), 0);

export function fleetBar(models, width, numbers, showBars) {
  const { groups } = models;
  if (!groups.includes(models.local)) numbers = [];
  const sessionWidth = sessionNumbersWidth(numbers);
  const room = width - 24 - sessionWidth - 28;
  const fits = (hosts, density) => hosts.reduce((sum, host) => sum + hostWidth(host, density) + 8, 0) <= room;
  if (showBars && fits(groups, DENSITY.FULL)) return { groups, density: DENSITY.FULL, numbers };
  if (fits(groups, DENSITY.NO_BARS)) return { groups, density: DENSITY.NO_BARS, numbers };
  const tight = groups.map((host) => ({ ...host, groups: host.groups.map((g) => ({
    ...g, segments: g.tight ? [g.tight] : [],
  })) }));
  if (fits(tight, DENSITY.NO_BARS)) return { groups: tight, density: DENSITY.NO_BARS, numbers };

  const padding = width >= 250 ? 12 : width >= 96 ? 4 : 0;
  const labels = groups.map((host) => host.label);
  const namedControlsWidth = labels.reduce((sum, name) => sum + labelWidth(name), 0) + 8 * (labels.length - 1);
  return { labels, padding, numbers: width >= namedControlsWidth + 2 * padding + sessionWidth ? numbers : [] };
}
