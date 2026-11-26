import { div, svg } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { SESSION_TITLE, iconButton, levelColor, modIcon, rule, sessionNumberColor, usageBar } from "./kit.js";
import { limitsGroup, spendLine } from "./card.js";
import { providerGroup } from "./bar.js";
import { inPanel } from "../lib/prefs.js";
import { canRefreshRemote } from "../fleet/adapter.js";
import { LOCAL_COLLAPSE_KEY } from "../fleet/model.js";
import { ago, timeLeft } from "../lib/format.js";
import { chooseDensity } from "../lib/view.js";
import { providerName } from "../providers/index.js";

const PANEL_W = 340;
const SESSION_BAR_W = 60;

export function panelShell(panel) {
  const { t, act } = panel;
  return v_flex().id("ul-panel-body").w(PANEL_W).p(12).gap(10).rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_lg()
    .text_size(12).text_color(t.foreground)
    .on_hover((on, cx) => act.hoverPanel(on, cx));
}

function sessionBlock(v, t) {
  const stats = [v.who, v.context.detail, v.calls, v.compactions, v.last].filter(Boolean).join(" · ");
  return v_flex().gap(4)
    .child(h_flex().gap(6).items_center()
      .child(div().flex_none().font_semibold().child(SESSION_TITLE))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(v.title))
      .when(v.context.fill != null, (r) => r.child(usageBar(SESSION_BAR_W, v.context.fill, null, levelColor(v.context.level, t), t)))
      .child(div().flex_none().whitespace_nowrap().text_color(sessionNumberColor(v.context.level, v.context.text, t)).child(`ctx ${v.context.text}`)))
    .child(div().text_size(11).text_color(t.dim).child(stats));
}

function choiceRow(row, panel) {
  return div().id(`ul-session-${row.id}`).py(4).px(6).rounded(4)
    .cursor_pointer().hover((s) => s.bg(panel.t.hover)).on_click((_e, cx) => panel.act.chooseSession(row, cx))
    .child(div().truncate().child(row.title || row.id));
}

function sessionPicker(panel) {
  const { t, act, choosing, choices } = panel;
  return v_flex().gap(5)
    .child(div().font_semibold().child(SESSION_TITLE))
    .child(div().id("ul-pick-session").text_size(11).text_color(t.dim).cursor_pointer()
      .on_click((_e, cx) => act.togglePicker(cx))
      .child(choosing ? "Cancel" : "Choose Codex session…"))
    .when(choosing, (el) => el.children(choices.choices.map((row) => choiceRow(row, panel))));
}

const changeSession = (panel) => div().id("ul-change-session").text_size(11).text_color(panel.t.dim).cursor_pointer()
  .on_click((_e, cx) => panel.act.changeSession(cx)).child("Change Codex session");

function footer(panel) {
  const { t, act, cooling } = panel;
  return h_flex().gap(2).justify_end().items_center()
    .child(iconButton({ id: "ul-refresh", icon: "refresh", label: cooling ? "Refreshing…" : "Refresh now", enabled: !cooling, onClick: act.refresh }, t))
    .child(iconButton({ id: "ul-settings", icon: "gear", label: "Settings", enabled: true, onClick: (cx) => act.show("settings", cx) }, t));
}

function remoteButton(id, text, description, intent, panel, enabled = true) {
  return Button.new(id).h(20).px(4).text_size(11).text_color(enabled ? panel.t.foreground : panel.t.dim).bg(panel.t.raised)
    .accessibility_label(description).tooltip(description).disabled(!enabled)
    .when(enabled, (button) => button.cursor_pointer().on_click((_e, cx) => panel.onRemoteIntent(intent, cx))).child(text);
}

function fleetControls(selection, panel) {
  const { t } = panel;
  const { mode, selected, choices } = selection;
  const status = (text) => div().text_size(11).text_color(t.muted).child(text);
  return v_flex().gap(5)
    .child(h_flex().items_center().justify_between()
      .children([["follow", "Follow Space"], ["combined", "Local + Remote"]].map(([value, label]) =>
        remoteButton(`ul-mode-${value}`, label, mode === value ? `${label} (current)` : label,
          { type: "mode", mode: value }, panel, mode !== value))))
    .when(mode === "combined" && !selected && choices.length > 1, (r) => r.child(status("Choose a remote")))
    .when(panel.remoteOutcome != null, (r) => {
      const { label, provider, status: outcome, reason, retryAt } = panel.remoteOutcome;
      const name = providerName(provider);
      const message = ({ accepted: "Refresh queued", busy: "Refresh in progress", fresh: "Reading current" })[outcome] ?? `Refresh ${outcome}`;
      const retry = retryAt > panel.now ? `Retry in ${timeLeft(retryAt - panel.now)}` : null;
      return r.child(status([label ? `${label} · ${name}: ${message}` : message, reason, retry].filter(Boolean).join(" · ")));
    });
}

const dollarText = (minor) => `$${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

function measuredDetails(rows, { t, now }) {
  return v_flex().gap(4).p(6).rounded(4).bg(t.raised)
    .child(div().font_semibold().child("Credit and spend"))
    .children(rows.map(({ label, percent, money, resetsAt, observedAt }) => {
      const reset = money?.resetLabel ? `Resets ${money.resetLabel}`
        : resetsAt != null ? `Resets in ${timeLeft(resetsAt - now)}` : null;
      const amount = money ? `${dollarText(money.usedMinor)} / ${dollarText(money.limitMinor)} spent` : null;
      const note = [amount, reset, `Observed ${ago(observedAt, now)}`].filter(Boolean).join(" · ");
      return v_flex().gap(2)
        .child(div().child(`${label} · ${percent}% used`))
        .child(div().text_size(11).text_color(t.muted).child(note));
    }));
}

function hostToggle(key, collapsed, label, title, panel) {
  const { t } = panel;
  return h_flex().id(`ul-host-toggle-${key}`).gap(4).items_center().flex_1().min_w(0).cursor_pointer()
    .tooltip(`${collapsed ? "Expand" : "Collapse"} ${label}`)
    .on_click((_e, cx) => panel.onRemoteIntent({ type: "collapse", key }, cx))
    .child(svg(modIcon(collapsed ? "chevron-right" : "chevron-down")).size(12).flex_none().text_color(t.dim))
    .child(title);
}

function hostSummary(host, key, panel) {
  const density = chooseDensity({ groups: host.summary }, PANEL_W - 24, false);
  return h_flex().gap(10).items_center().flex_wrap().pl(16)
    .children(host.summary.map((g) => providerGroup(g, density, panel.t, `ul-sum-${key}`, false)));
}

function remoteDetails(remote, panel, selection) {
  const { label, route, machine, collapsed } = remote;
  const { t } = panel;
  const selected = selection.mode === "combined" && selection.selected?.route === route;
  const reason = machine.reason ?? ({ offline: "Machine offline", loading: "Connecting" })[machine.availability]
    ?? (!machine.enabled ? "Remote not enrolled" : machine.availability !== "ready" ? "Machine unavailable" : null);
  const title = `${label}${selected ? " (selected)" : ""}`;
  return v_flex().gap(8)
    .child(h_flex().gap(6).items_center()
      .child(hostToggle(route, collapsed, label, div().flex_1().min_w(0).truncate().font_semibold().child(title), panel))
      .when(!selected && selection.mode === "combined" && selection.choices.includes(machine),
        (r) => r.child(remoteButton(`ul-remote-select-${route}`, "Select", `Select ${label}`, { type: "select", route }, panel))))
    .when(reason != null, (r) => r.child(div().text_size(11).text_color(t.muted).child(reason)))
    .when(collapsed, (r) => r.child(hostSummary(remote, route, panel)))
    .when(!collapsed, (r) => r.children(remote.panel.groups.map((g) => {
      const refresh = `Refresh ${label} · ${g.name}`;
      const measurements = g.providerId === "claude" ? machine.states?.claude?.measurements : null;
      return v_flex().gap(4)
        .child(limitsGroup(g, false, panel, route))
        .when(g.source != null, (r) => r.child(div().text_size(11).text_color(t.muted).child(g.source)))
        .when(g.history != null, (r) => r.child(div().text_size(11).text_color(t.dim).child(g.history)))
        .when(measurements?.length > 0, (r) => r.child(measuredDetails(measurements, panel)))
        .child(remoteButton(`ul-remote-refresh-${route}-${g.providerId}`, refresh, refresh,
          { type: "refresh", route, provider: g.providerId }, panel, canRefreshRemote(machine, g.providerId)));
    })));
}

function localSections(body, model, session, panel, combined) {
  const { t } = panel;
  const sessionInPanel = inPanel(panel.prefs, "session");
  if (session) body.child(sessionBlock(session, t)).child(rule(t));
  if (sessionInPanel && (panel.sessionScope === "remote" || (combined && panel.sessionScope === "unknown"))) {
    const message = panel.sessionScope === "remote" ? "Focused session unavailable on remote" : "Focused session unavailable";
    body.child(div().text_size(11).text_color(t.muted).child(message)).child(rule(t));
  }
  if (sessionInPanel && panel.manual) body.child(changeSession(panel));
  if (sessionInPanel && panel.choices) body.child(sessionPicker(panel)).child(rule(t));
  model.groups.forEach((g, i) => {
    if (i > 0) body.child(rule(t));
    body.child(g.kind === "spend" ? spendLine(g, t) : limitsGroup(g, model.arrows, panel));
    if (combined) {
      if (g.source) body.child(div().text_size(11).text_color(t.muted).child(g.source));
      const refresh = `Refresh ${combined.local.label} · ${g.name}`;
      body.child(Button.new(`ul-local-refresh-${g.providerId}`).h(20).px(4).text_size(11).bg(t.raised)
        .accessibility_label(refresh).tooltip(refresh).disabled(!panel.canRefreshLocal(g.providerId))
        .on_click((_e, cx) => panel.refreshLocal(g.providerId, cx)).child(refresh));
    }
  });
}

export function limitsPanel(model, session, panel, combined = null) {
  const { t } = panel;
  const body = panelShell(panel);
  const folded = combined?.local.collapsed === true;
  if (combined) {
    const { label } = combined.local;
    const title = div().font_semibold().text_size(11).text_color(t.muted).child(label);
    body.max_h(520).overflow_y_scroll();
    body.child(fleetControls(combined.selection, panel)).child(rule(t))
      .child(h_flex().items_center().child(hostToggle(LOCAL_COLLAPSE_KEY, folded, label, title, panel)));
    if (folded) body.child(hostSummary(combined.local, LOCAL_COLLAPSE_KEY, panel));
  }
  if (!folded) localSections(body, model, session, panel, combined);
  if (combined) {
    for (const remote of combined.remotes) body.child(rule(t)).child(remoteDetails(remote, panel, combined.selection));
  }
  return body.child(rule(t)).child(footer(panel));
}
