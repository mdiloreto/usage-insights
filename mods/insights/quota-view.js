import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { formatDuration, formatTimestamp } from "./analytics.js";
import { G, card, cardHeader, fieldLabel, mutedText } from "./ui.js";

const PROVIDERS = new Map([
  ["codex", { label: "Codex", icon: "openai.svg" }],
  ["claude", { label: "Claude", icon: "anthropic.svg" }],
]);
const METER_WIDTH = 64;

function validPercent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function percent(value) {
  if (value > 0 && value < 0.1) return "<0.1%";
  if (value < 100 && value > 99.9) return ">99.9%";
  return `${Math.round(value * 10) / 10}%`;
}

function dollarAmount(minor) {
  const digits = String(minor).padStart(3, "0");
  return `$${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${digits.slice(-2)}`;
}

function quotaWindow(window, c, now, dated = false) {
  const reset = Number.isFinite(window.resetAtMs) ? window.resetAtMs : null;
  const current = validPercent(window.usedPercent) && (reset === null || reset > now);
  const row = h_flex().items_center().flex_wrap().gap(G.xs)
    .child(mutedText(dated ? `${window.label} (dated)` : window.label, c));
  if (!current && !dated) return row.child(mutedText(reset !== null && reset <= now ? "— Awaiting reset reading" : "— No reading", c));
  if (["$", "USD"].includes(window.money?.currency)) {
    const { usedMinor, limitMinor, resetLabel } = window.money;
    row.child(fieldLabel(`${dollarAmount(usedMinor)} / ${dollarAmount(limitMinor)} ${window.kind === "spend" ? "spent" : "used"}`, c));
    if (resetLabel) row.child(mutedText(`Resets ${resetLabel}`, c));
  } else if (window.kind === "spend" || window.kind === "credit") {
    row.child(mutedText("Amount unavailable", c));
  }
  if (window.kind === "spend" || dated) return row
    .when(validPercent(window.usedPercent), (el) => el.child(mutedText(`${percent(window.usedPercent)} used`, c)));

  const used = window.usedPercent;
  const pace = validPercent(window.pacePercent) ? window.pacePercent : null;
  return row
    .child(div().relative().w(METER_WIDTH).h(4).flex_none().rounded(2).bg(c.border)
      .when(used > 0, (el) => el.child(div().absolute().left(0).top(0).w(METER_WIDTH * used / 100).h_full().rounded(2)
        .bg(used === 100 ? c.destructive : pace !== null && used > pace ? c.accent : c.done)))
      .when(pace !== null, (el) => el.child(div().absolute().left(Math.min(METER_WIDTH - 1, METER_WIDTH * pace / 100))
        .top(-1).w(1).h(6).bg(c.mutedForeground)))
      .tooltip(pace === null ? `${percent(used)} used` : `${percent(used)} used · ${percent(pace)} pace`))
    .child(fieldLabel(percent(used), c))
    .when(reset !== null, (el) => el.child(mutedText(`Resets in ${formatDuration(reset - now)}`, c)
      .tooltip(`Resets ${formatTimestamp(reset)}`)));
}

function quotaProvider(record, provider, c, now) {
  const age = Number.isFinite(record.observedAtMs) ? Math.max(0, now - record.observedAtMs) : null;
  const status = record.status === "current" ? null : record.status === "stale" ? "Stale"
    : record.status === "unobserved" ? "Not observed" : "Unavailable";
  const detail = [
    status, record.reason, record.source, age === null ? null : age === 0 ? "Just observed" : `Observed ${formatDuration(age)} ago`,
  ].filter(Boolean).join(" · ");
  const windows = record.status === "current" && Array.isArray(record.windows) ? record.windows : [];
  const history = record.historyWindows ?? [];
  const hasWindows = windows.length + history.length > 0;
  return h_flex().w_full().items_center().flex_wrap().gap(G.sm)
    .child(h_flex().min_w(132).items_center().gap(G.xs)
      .child(svg(`mods/insights/logos/${provider.icon}`).size(12).text_color(c.mutedForeground))
      .child(fieldLabel(provider.label, c))
      .when(Boolean(record.plan), (el) => el.child(mutedText(record.plan, c))))
    .when(record.planUnavailable === true, (el) => el.child(mutedText("Plan windows unavailable", c)))
    .children(windows.map((window) => quotaWindow(window, c, now)))
    .children(history.map((window) => quotaWindow(window, c, now, true)))
    .when(!hasWindows, (el) => el.child(mutedText(detail ? `— ${detail}` : "— No reading", c)))
    .when(hasWindows && Boolean(detail), (el) => el.child(mutedText(detail, c)));
}

/**
 * Render a sanitized projection, never fetch it. Names are routes (`null` for
 * Local); labels are presentation-only. `null` means no projection wired yet.
 * A provider has { provider, plan?, status, source?, reason?, observedAtMs?,
 * windows: [{ label, usedPercent, resetAtMs?, pacePercent?, kind?, money? }] }.
 */
export function renderQuota(hosts, scope, c, { localLabel, now = Date.now() }) {
  if (!Array.isArray(hosts)) return null;
  const name = scope.kind === "local" ? null : scope.name;
  const selected = scope.kind === "all"
    ? [...hosts.filter((host) => host.name === null), ...hosts.filter((host) => host.name !== null)]
    : hosts.filter((host) => host.name === name);
  if (!selected.length && scope.kind !== "all") selected.push({ name, providers: [] });
  if (!selected.length) return null;
  return card(c, G.md, G.sm).child(cardHeader("Quotas", "", c))
    .children(selected.map((host, index) => {
      const providers = (host.providers ?? []).filter((record) => PROVIDERS.has(record.provider));
      return v_flex().w_full().gap(G.xs)
        .when(index > 0, (el) => el.border_t(1).border_color(c.border).pt(G.sm))
        .child(fieldLabel(host.name === null ? localLabel : host.label || host.name, c))
        .children(providers.map((record) => quotaProvider(record, PROVIDERS.get(record.provider), c, now)))
        .when(providers.length === 0, (el) => el.child(mutedText("— No quota reading", c)));
    }));
}
