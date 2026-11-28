import { ago } from "../lib/format.js";
import { effectivePrefs, isShown } from "../lib/prefs.js";
import { errorReport } from "../lib/report.js";
import { DENSITY, NO_READING, barModel, cardModel, groupWidth, isStale, pillWidth, sessionNumbersWidth, tightest } from "../lib/view.js";
import { PROVIDERS, REMOTE_PROVIDERS } from "../providers/index.js";
import { THIS_COMPUTER, chipText } from "./identity.js";
import { resourcePills } from "./resources.js";

const NO_IDENTITY = { localOs: null, localName: null, remoteOs: () => null };
// Not a valid route (routes start with a letter or digit), so it can share the collapsed list with them.
export const LOCAL_COLLAPSE_KEY = "@local";
// Optional providers appear only where a remote machine reports them, or where this computer's helper
// has found them; the others always do.
const providersFor = (machine) => REMOTE_PROVIDERS.filter((p) => !p.optional || machine.states?.[p.id]);
const localProviders = (states) => PROVIDERS.filter((p) => !p.optional || states[p.id]?.installed === true);
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
const tightGroup = (g) => ({ ...g, segments: g.tight ? [g.tight] : [] });
const tightSummary = (groups) => groups.filter((g) => g.spend == null).map(tightGroup);

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

const isAgy = (group) => group.providerId === "agy";

// What one machine's Antigravity can offer the bar, or null where it never had a reading. A reading is
// current when it has something to show, unless the caller judges that apart from what is shown.
function agyReading(host, state, current) {
  const group = host.groups.find(isAgy);
  if (!group) return null;
  const live = current ?? group.segments.length > 0;
  if (live) return { host, group, live, observedAt: state.report.observedAt };
  const times = [state.lastGood, state.historyDetail]
    .filter((reading) => reading?.windows?.length).map((reading) => reading.observedAt);
  return times.length ? { host, group, live, observedAt: Math.max(...times) } : null;
}

// Which machines the bar shows must not hide Antigravity: when none of them has a current reading, the
// freshest one elsewhere joins under its own machine's chip. A dated one joins only if they hold none at all.
function withLentAgy(shown, readings) {
  const onBar = readings.filter(({ host }) => shown.includes(host));
  if (onBar.some((reading) => reading.live)) return shown;
  const live = readings.filter((reading) => reading.live && reading.group.segments.length);
  if (!live.length && onBar.length) return shown;
  const lenders = live.length ? live : readings.filter((reading) => !reading.live);
  if (!lenders.length) return shown;
  const { host: { label, chip }, group } = lenders.reduce((best, next) => (next.observedAt > best.observedAt ? next : best));
  // No route: only this computer's own segment has the null route that keeps session numbers on the bar.
  return [...shown.map((host) => ({ ...host, groups: host.groups.filter((g) => !isAgy(g)) })),
    { label, chip, groups: [group], lent: true }];
}

export function fleetModels(projection, prefs, selection, localSource, identity = NO_IDENTITY) {
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
      route, label, chip: chipText(identity.remoteOs(route), label), machine, groups, summary: tightSummary(groups), collapsed: collapsed.has(route),
      panel: providerDetails(states, providers, remotePrefs, now, true),
      fable: states.claude.fable,
    };
  };
  const states = localSource.local ?? {};
  const localFable = currentWindows(states.claude, localSource.now).find(isFable);
  const localDetails = states.claude && !(localFable && fableEnabled(prefs)) ? { ...states, claude: {
    ...states.claude, report: withoutFable(states.claude.report), lastGood: withoutFable(states.claude.lastGood),
  } } : states;
  const providers = localProviders(states);
  const localGroups = compactGroups(states, providers, prefs, localSource.now);
  const local = { route: null, label: THIS_COMPUTER, meterName: identity.localName ?? "Local", chip: identity.localName ? chipText(identity.localOs, identity.localName) : THIS_COMPUTER, groups: localGroups, summary: tightSummary(localGroups),
    collapsed: collapsed.has(LOCAL_COLLAPSE_KEY),
    panel: providerDetails(localDetails, providers, prefs, localSource.now, false), fable: localFable };
  const remotes = machines.map(forRemote);
  const groupFor = (machine) => remotes.find(({ route }) => route === machine.route) ?? forRemote(machine);
  const groups = mode === "combined"
    ? [local, selected ? groupFor(selected) : { label: choices.length ? "Choose remote" : "No remote available", groups: [] }]
    : [activeRemote ? groupFor(activeRemote) : activeMachine === null ? local : { label: "Active machine unknown", groups: [] }];
  // This computer's is judged on every window, so hiding them does not bring another machine's onto the bar.
  const currentHere = currentWindows(states.agy, localSource.now).length > 0;
  const agyReadings = [agyReading(local, states.agy, currentHere),
    ...remotes.map((host) => agyReading(host, host.machine.states?.agy))];
  const bar = isShown(prefs, "agy") ? withLentAgy(groups, agyReadings.filter(Boolean)) : groups;
  return { local, remotes, groups: bar, selection, resources: resourcePills(localSource.resources, localSource.now) };
}

const labelWidth = (label) => Math.ceil(7.5 * label.length + 8);
export const hostChip = (host) => host.chip ?? host.label;
// Between two machines: the 1px divider and the gap on each side of it.
const HOST_GAP_W = 17;
const hostWidth = (host, density) => labelWidth(hostChip(host)) + host.groups.reduce((sum, g) =>
  sum + groupWidth(g, density) + (g.mark == null ? 0 : 16), 0);
const hostsWidth = (hosts, density) => hosts.reduce((sum, host) =>
  sum + hostWidth(host, density), HOST_GAP_W * (hosts.length - 1));
// What the machines have beside the bar's padding, the session numbers and the details button.
const roomFor = (width, sessionWidth) => width - 24 - sessionWidth - 28;

const showsNumbers = (layout) => layout.groups?.some((host) =>
  host.groups.some((g) => g.segments.length > 0 || g.spend != null)) === true;

const METER_NAME_CHARS = 12;
// Cuts the middle, as machine names often differ only at the end, and never inside a character.
const shortName = (name) => {
  const chars = [...name];
  return chars.length > METER_NAME_CHARS ? `${chars.slice(0, 6).join("")}…${chars.slice(-5).join("")}` : name;
};
const meterWidth = ({ label, segments }, density) => pillWidth(segments, density) + (label == null ? 0 : labelWidth(label));

// Meters take only the width the quota layout leaves over, so a reading never changes that layout.
function withMeters(layout, resources, width, showBars) {
  const named = layout.groups.length > 1;
  const meters = layout.groups.filter((host) => resources.has(host.route)).map((host) => {
    const name = host.meterName ?? host.label;
    return { name, label: named ? shortName(name) : null, segments: resources.get(host.route) };
  });
  if (!meters.length) return layout;
  // The space between the bar's two sides, and the divider after any session numbers, each take a host gap.
  const room = roomFor(width, sessionNumbersWidth(layout.numbers)) - hostsWidth(layout.groups, layout.density)
    - HOST_GAP_W * (layout.numbers.length ? 2 : 1);
  const densities = showBars ? [DENSITY.FULL, DENSITY.NO_BARS, DENSITY.NO_LABELS] : [DENSITY.NO_BARS, DENSITY.NO_LABELS];
  const meterDensity = densities.find((d) => meters.reduce((sum, meter) => sum + meterWidth(meter, d), 0) <= room);
  return meterDensity === undefined ? layout : { ...layout, meters, meterDensity };
}

export function fleetBar({ groups, resources }, width, numbers, showBars) {
  const layout = quotaLayout(groups, width, numbers, showBars);
  return layout.labels || !resources ? layout : withMeters(layout, resources, width, showBars);
}

function quotaLayout(groups, width, numbers, showBars) {
  const layout = barLayout(groups, width, numbers, showBars);
  if (!layout.labels) return layout;
  // A lent entry never costs the other machines their numbers.
  const own = barLayout(groups.filter((host) => !host.lent), width, numbers, showBars);
  return showsNumbers(own) ? own : layout;
}

function barLayout(groups, width, numbers, showBars) {
  if (!groups.some((host) => host.route === null)) numbers = [];
  const sessionWidth = sessionNumbersWidth(numbers);
  const room = roomFor(width, sessionWidth);
  const fits = (hosts, density) => hostsWidth(hosts, density) <= room;
  if (showBars && fits(groups, DENSITY.FULL)) return { groups, density: DENSITY.FULL, numbers };
  if (fits(groups, DENSITY.NO_BARS)) return { groups, density: DENSITY.NO_BARS, numbers };
  const tight = groups.map((host) => ({ ...host, groups: host.groups.map(tightGroup) }));
  if (fits(tight, DENSITY.NO_BARS)) return { groups: tight, density: DENSITY.NO_BARS, numbers };

  const padding = width >= 250 ? 12 : width >= 96 ? 4 : 0;
  const labels = groups.map(hostChip);
  const namedControlsWidth = labels.reduce((sum, name) => sum + labelWidth(name), 0) + 8 * (labels.length - 1);
  return { labels, padding, numbers: width >= namedControlsWidth + 2 * padding + sessionWidth ? numbers : [] };
}
