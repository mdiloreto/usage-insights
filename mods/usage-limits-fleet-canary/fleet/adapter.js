import { LOCAL_COLLAPSE_KEY, fleetModels } from "./model.js";
import { REMOTE_PROVIDERS } from "../providers/index.js";
import { selectable } from "./selection.js";

export const FLEET_PREFS_KEY = "usage-limits.fleet.prefs.v1";

const isRoute = (route) => typeof route === "string" && route.trim() !== "";
const isCollapseKey = (key) => key === LOCAL_COLLAPSE_KEY || isRoute(key);

export function sharedFleetPrefs(readShared, writeShared) {
  return {
    readPrefs() {
      const record = readShared(FLEET_PREFS_KEY);
      const { route, label } = record?.selected ?? {};
      return {
        mode: record?.mode === "combined" ? "combined" : "follow",
        selected: isRoute(route) && isRoute(label) ? { route, label } : null,
        collapsed: Array.isArray(record?.collapsed) ? [...new Set(record.collapsed.filter(isCollapseKey))] : [],
      };
    },
    writePrefs(prefs) {
      writeShared(FLEET_PREFS_KEY, prefs);
    },
  };
}

const providers = new Set(REMOTE_PROVIDERS.map((p) => p.id));
const refreshStatuses = new Set(["accepted", "rejected", "busy", "paused", "disabled", "unavailable", "deferred", "failed", "fresh"]);
export const canRefreshRemote = (machine, provider) => providers.has(provider) && selectable(machine)
  && (machine.refreshable == null || machine.refreshable[provider] === true);

export function refreshOutcome(projection, previous) {
  if (!projection || (previous?.status !== "accepted" && previous?.status !== "busy")) return previous;
  const target = projection.machines.find((m) => m.route === previous.route && m.registered === true);
  const { route, provider, label } = previous;
  if (!target) return { status: "unavailable", route, provider, label };
  const observed = target.refresh?.[provider];
  return observed ? { ...observed, route, provider, label: target.label } : previous;
}

export function fleetAdapter({ readProjection, readPrefs, writePrefs, refresh }) {
  const known = (machines, route) => {
    const matches = machines.filter((m) => m.route === route);
    return matches.length === 1 ? matches[0] : null;
  };
  const remember = ({ route, label }) => ({ route, label });
  const save = (change) => writePrefs({ ...readPrefs(), ...change });
  const available = (projection) => projection?.machines.filter(selectable) ?? [];
  const missing = (route, label) =>
    ({ route, label, registered: false, enabled: false, availability: "unavailable", reason: "Machine not registered" });
  return {
    readProjection,
    model(projection, activeMachine, prefs, localSource, identity) {
      const machines = projection?.machines.filter((m) => m.registered === true) ?? [];
      if (!machines.length) return null;
      const { mode, selected: saved, collapsed } = readPrefs();
      const choices = available(projection);
      let selected = saved && (known(machines, saved.route) ?? missing(saved.route, saved.label));
      if (!selected && mode === "combined" && choices.length === 1) {
        selected = choices[0];
        save({ selected: remember(selected) });
      }
      if (selected && !selected.registered) machines.push(selected);
      const activeRemote = isRoute(activeMachine)
        ? known(machines, activeMachine) ?? missing(activeMachine, activeMachine) : null;
      return fleetModels(projection, prefs, { mode, selected, activeRemote, activeMachine, machines, choices, collapsed }, localSource, identity);
    },
    dispatch(intent) {
      if (intent.type === "mode" && (intent.mode === "combined" || intent.mode === "follow")) {
        const { selected } = readPrefs();
        const choices = intent.mode === "combined" ? available(readProjection()) : [];
        save({ mode: intent.mode, selected: selected ?? (choices.length === 1 ? remember(choices[0]) : null) });
        return { status: "accepted" };
      }
      if (intent.type === "collapse") {
        if (!isCollapseKey(intent.key)) return { status: "rejected" };
        const { collapsed } = readPrefs();
        save({ collapsed: collapsed.includes(intent.key) ? collapsed.filter((key) => key !== intent.key) : [...collapsed, intent.key] });
        return { status: "accepted" };
      }
      const projection = readProjection();
      const target = projection && known(projection.machines, intent.route);
      if (intent.type === "select") {
        if (readPrefs().mode !== "combined" || !selectable(target)) return { status: "unavailable" };
        save({ mode: "combined", selected: remember(target) });
        return { status: "accepted" };
      }
      const { provider } = intent;
      if (intent.type !== "refresh" || !providers.has(provider)) return { status: "rejected" };
      if (!target?.registered) return { status: "unavailable" };
      const named = (status) => ({ status, route: target.route, label: target.label, provider });
      if (target.availability !== "ready" || !target.enabled) return named("unavailable");
      if (!canRefreshRemote(target, provider)) return named("paused");
      const outcome = refresh({ type: "refresh", route: target.route, provider });
      return { ...named(refreshStatuses.has(outcome?.status) ? outcome.status : "rejected"),
        ...(outcome?.reason ? { reason: outcome.reason } : {}),
        ...(outcome?.retryAt ? { retryAt: outcome.retryAt } : {}) };
    },
  };
}
