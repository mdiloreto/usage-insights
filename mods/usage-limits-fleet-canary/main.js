import { View } from "gpui-kit";
import { platform } from "os";
import { appHome, checking, exec, focused, machines, readTextFile, settings, spaces, terminals, theme, props, shared, setShared, writeTextFile } from "herdr";
import { PROVIDERS } from "./providers/index.js";
import { KEY_PREFS, KEY_REFRESH, KEY_STATE, nowS, refreshCooling, states, viewActions } from "./actions.js";
import { runProviderHelper, readTerminalSession } from "./io/helpers.js";
import { PANEL, barModel, cardModel, chooseDensity, sessionNumbersWidth, wanted } from "./lib/view.js";
import { effectivePrefs, inPanel } from "./lib/prefs.js";
import { sessionOnBar, sessionView } from "./lib/session.js";
import { NEVER_FETCHED, crashedState, fetchedState } from "./lib/fetch-state.js";
import { statusBar } from "./ui/bar.js";
import { limitsPanel } from "./ui/panel.js";
import { settingsPanel } from "./ui/settings.js";
import { fleetBar } from "./fleet/model.js";
import { RESOURCES_KEY } from "./fleet/resources.js";
import { focusScope } from "./fleet/selection.js";
import { createIdentity } from "./fleet/identity.js";
import { fleetAdapter, refreshOutcome, sharedFleetPrefs } from "./fleet/adapter.js";
import { coordinatorSource } from "./fleet/coordinator-bridge.js";
import { createQuotaCoordinator, REVISION_KEY, TICK_MS as QUOTA_TICK_MS } from "./fleet-quota/coordinator.mjs";
import { createQuotaEnrollmentStore, ENROLLMENT_OBSERVE_MS } from "./fleet-quota/enrollments.mjs";
import { mountQuotaView } from "./quota-projection.mjs";

const FETCH_EVERY_S = 5 * 60;
const NOT_INSTALLED_FETCH_EVERY_S = 60 * 60;
const TICK_MS = 60 * 1000;
const BAR_PADDING_W = 24;

const sessionWanted = (prefs) => inPanel(prefs, "session") || prefs.sessionOnBar.length > 0;
const currentFocus = () => focusScope(spaces(), focused(), terminals);

function panelIsEmpty(view, panel, session, prefs) {
  const sessionPending = inPanel(prefs, "session") && (view.sessionChoices || view.sessionManual || view.sessionScope === "remote");
  return panel.empty && !session && !sessionPending;
}

export default class UsageLimits extends View {
  init(_props, cx) {
    Object.assign(this, {
      width: 0, panel: PANEL.LIMITS, leftAtMs: null, hovered: null,
      terminal: null, session: null, sessionReadAtMs: 0, sessionBusy: false, sessionChoices: null,
      sessionChoosing: false, sessionManual: false, sessionRevision: 0,
      lastFetchAtS: {}, fetching: {}, unwanted: {},
    });
    this.checkMode = checking();
    this.fleet = null;
    if (!this.checkMode) {
      const source = this.fleetSource(cx);
      if (source) this.fleet = fleetAdapter(source);
      this.identity = createIdentity({ exec, platform: platform() });
    }
    this.act = viewActions(this);
    this.sessionWas = sessionWanted(this.prefs());
    this.seenRefresh = shared(KEY_REFRESH) ?? 0;
    if (this.checkMode) return;
    this.tick(cx, true);
    cx.timer.every(TICK_MS, (next) => this.tick(next, false));
  }

  prefs() {
    return effectivePrefs(shared(KEY_PREFS), props());
  }

  fleetSource(cx) {
    const enrollments = createQuotaEnrollmentStore({ appHome, checking, readTextFile, writeTextFile });
    const coordinator = createQuotaCoordinator({ shared, setShared, exec, machines, checking,
      readEnrollments: enrollments.readEnrollments, invalidateEnrollment: enrollments.invalidateEnrollment });
    this.quotaView = mountQuotaView(cx, { coordinator, shared, revisionKey: REVISION_KEY, tickMs: QUOTA_TICK_MS,
      observeEnrollments: enrollments.observe, enrollmentObserveMs: ENROLLMENT_OBSERVE_MS });
    return coordinatorSource({
      coordinator, now: nowS, ...sharedFleetPrefs(shared, setShared),
    });
  }

  close() {
    this.quotaView?.dispose();
  }

  tick(cx, force) {
    const st = states();
    const prefs = this.prefs();
    for (const p of PROVIDERS) {
      if (!wanted(prefs, p, st)) continue;
      const every = st[p.id]?.installed === false ? NOT_INSTALLED_FETCH_EVERY_S : FETCH_EVERY_S;
      if (force || nowS() - (this.lastFetchAtS[p.id] ?? 0) >= every) this.fetch(p, cx);
    }
    this.readSession(cx);
    this.lookUpIdentity(cx);
    cx.notify();
  }

  lookUpIdentity(cx) {
    if (!this.fleet || !this.identity) return;
    const routes = this.fleet.readProjection()?.machines.filter((m) => m.registered === true).map((m) => m.route) ?? [];
    this.identity.lookup(routes, () => cx.notify());
  }

  fetch(p, cx) {
    if (this.checkMode || this.fetching[p.id]) return;
    this.fetching[p.id] = true;
    this.lastFetchAtS[p.id] = nowS();
    cx.spawn(async (later) => {
      const prev = states()[p.id] ?? NEVER_FETCHED;
      const next = await runProviderHelper(p).then((r) => fetchedState(prev, p, r, nowS())).catch((e) => crashedState(prev, p, e, nowS()));
      this.fetching[p.id] = false;
      setShared(KEY_STATE, { ...states(), [p.id]: next });
      later.notify();
    });
  }

  forgetSession() {
    this.session = null;
    this.sessionChoices = null;
  }

  readSession(cx) {
    if (this.checkMode) return undefined;
    if (!sessionWanted(this.prefs())) return this.forgetSession();
    if (this.sessionBusy) return undefined;
    const { terminal, sessionRevision } = this;
    this.sessionReadAtMs = Date.now();
    if (!terminal || terminal !== currentFocus().terminal) return this.forgetSession();
    this.sessionBusy = true;
    cx.spawn(async (later) => {
      if (terminal !== currentFocus().terminal) {
        this.sessionBusy = false;
        return this.readSession(later);
      }
      const read = await readTerminalSession(terminal);
      this.sessionBusy = false;
      if (terminal !== this.terminal || sessionRevision !== this.sessionRevision) return this.readSession(later);
      if (terminal !== currentFocus().terminal) {
        this.forgetSession();
        return later.notify();
      }
      const keep = sessionWanted(this.prefs());
      this.session = keep ? read.session : null;
      this.sessionChoices = keep ? read.choices : null;
      this.sessionManual = read.manual;
      return later.notify();
    });
    return undefined;
  }

  followFocus(cx, prefs) {
    const scope = currentFocus();
    const { terminal, session } = scope;
    this.sessionScope = session;
    const wantedNow = sessionWanted(prefs);
    if (terminal !== this.terminal) {
      this.sessionRevision += 1;
      Object.assign(this, { terminal, session: null, sessionChoices: null, sessionChoosing: false, sessionManual: false });
      this.readSession(cx);
    } else if (wantedNow && !this.sessionWas) {
      this.readSession(cx);
    }
    this.sessionWas = wantedNow;
    return scope;
  }

  onRemoteIntent(intent, cx) {
    if (!this.fleet) return;
    const outcome = this.fleet.dispatch(intent);
    if (intent.type === "refresh") this.remoteOutcome = outcome;
    cx.notify();
  }

  fetchNewlyWanted(cx, prefs) {
    const st = states();
    const want = PROVIDERS.filter((p) => wanted(prefs, p, st));
    for (const p of want) if (this.unwanted[p.id]) this.fetch(p, cx);
    this.unwanted = Object.fromEntries(PROVIDERS.filter((p) => !want.includes(p)).map((p) => [p.id, true]));
    const asked = shared(KEY_REFRESH) ?? 0;
    if (asked === this.seenRefresh) return;
    this.seenRefresh = asked;
    for (const p of want) this.fetch(p, cx);
  }

  drawPanel(t, prefs, combined, st, now) {
    const panel = combined?.local.panel ?? cardModel(st, now, PROVIDERS, prefs);
    const session = inPanel(prefs, "session") ? sessionView(this.session?.data, this.session?.title) : null;
    const empty = !combined && panelIsEmpty(this, panel, session, prefs);
    if (empty) this.panel = PANEL.SETTINGS;
    const draw = {
      t, act: this.act, prefs, hovered: this.hovered, cooling: refreshCooling(),
      choosing: this.sessionChoosing, choices: this.sessionChoices, manual: this.sessionManual,
      showFailedAge: combined != null,
      sessionScope: this.sessionScope,
      remoteOutcome: this.remoteOutcome,
      now,
      onRemoteIntent: (intent, cx) => this.onRemoteIntent(intent, cx),
      canRefreshLocal: (id) => !this.checkMode && !this.fetching[id] && nowS() - (this.lastFetchAtS[id] ?? -Infinity) >= 30,
    };
    draw.refreshLocal = (id, cx) => {
      const p = PROVIDERS.find((provider) => provider.id === id);
      if (p && draw.canRefreshLocal(id)) this.fetch(p, cx);
      cx.notify();
    };
    const fable = combined?.local.fable ?? combined?.remotes.find((remote) => remote.fable)?.fable;
    if (this.panel === PANEL.SETTINGS) return settingsPanel(!empty, st, draw, combined ? fable ?? null : undefined);
    return limitsPanel(panel, session, draw, combined);
  }

  render(cx) {
    this.quotaView?.read(cx);
    const prefs = this.prefs();
    let scope;
    if (!this.checkMode) {
      scope = this.followFocus(cx, prefs);
      this.fetchNewlyWanted(cx, prefs);
    }
    const t = theme();
    const projection = this.fleet?.readProjection() ?? null;
    this.remoteOutcome = refreshOutcome(projection, this.remoteOutcome);
    const now = nowS();
    const st = states();
    const combined = this.fleet?.model(projection, scope?.activeMachine, prefs,
      { local: st, now, resources: shared(RESOURCES_KEY) }, this.identity?.snapshot()) ?? null;
    const numbers = sessionOnBar(this.session?.data, prefs);
    const common = { border: props()?.border, onResize: this.act.resize, onHover: this.act.hover };
    if (combined) {
      const zoom = Number(settings().zoom);
      const width = (this.width || Infinity) / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
      const fleet = fleetBar(combined, width, numbers, prefs.showBars);
      if (this.detailsOpen != null) {
        if (!fleet.labels) this.detailsOpen = "all";
        else if (this.detailsOpen === "all" || Number(this.detailsOpen) >= fleet.labels.length) this.detailsOpen = "0";
      }
      return statusBar({
        ...common, fleet, nameOnHover: prefs.nameOnHover, detailsOpen: this.detailsOpen,
        panel: this.detailsOpen == null ? null : this.drawPanel(t, prefs, combined, st, now),
        toggleDetails: (id, open, clickCx) => {
          if (open) {
            this.detailsOpen = id;
            this.panel = PANEL.LIMITS;
          } else if (this.detailsOpen === id) {
            this.detailsOpen = null;
          }
          clickCx.notify();
        },
      }, t);
    }
    this.detailsOpen = null;
    const model = barModel(st, prefs, now);
    const room = this.width ? this.width - BAR_PADDING_W - sessionNumbersWidth(numbers) : Infinity;
    return statusBar({
      ...common, model, numbers, density: chooseDensity(model, room, prefs.showBars), panel: this.drawPanel(t, prefs, null, st, now),
    }, t);
  }
}
