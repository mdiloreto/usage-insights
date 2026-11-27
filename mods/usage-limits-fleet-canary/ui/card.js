import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { DIMMED, LEFT_COLUMN_W, NO_READING, PERCENT_COLUMN_W, levelColor, limitNumberColor, modIcon, numberCell, providerIcon, usageBar } from "./kit.js";

const PANEL_BAR_W = 110;
const FOLDED_BAR_W = 44;

function cardRow(r, providerId, t) {
  return v_flex().gap(3)
    .child(h_flex().id(`ul-row-${providerId}-${r.id}`).gap(8).items_center()
      .when(r.hint != null, (e) => e.tooltip(r.hint))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.long))
      .child(usageBar(PANEL_BAR_W, r.fill, r.tick, levelColor(r.level, t), t))
      .child(numberCell(PERCENT_COLUMN_W, r.percent).text_color(limitNumberColor(r.level, r.percent, t)))
      .child(numberCell(LEFT_COLUMN_W, r.left).text_size(11).text_color(t.dim)))
    .when(r.detail !== "", (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(r.detail)));
}

const ageLine = (age, t) => div().text_size(11).text_color(t.dim).child(age);

function groupBody(g, t, scope) {
  const body = [];
  if (g.age != null) body.push(ageLine(g.age, t));
  const id = scope ? `${scope}-${g.providerId}` : g.providerId;
  body.push(v_flex().gap(6).opacity(g.dim ? DIMMED : 1).children(g.rows.map((r) => cardRow(r, id, t))));
  return body;
}

export function failure(text, t) {
  return div().flex_1().min_w(0).truncate().text_size(11).text_color(levelColor("hot", t)).child(`! ${text}`);
}

export function rightLabel(text, t) {
  return div().flex_1().min_w(0).flex().justify_end()
    .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(text));
}

function header(g, arrows, panel, scope) {
  const { t, act } = panel;
  const id = g.providerId;
  const arrow = g.folded ? "chevron-right" : "chevron-down";
  return h_flex().id(`ul-head-${scope ? `${scope}-` : ""}${id}`).gap(6).items_center()
    .when(!scope, (e) => e.cursor_pointer()
      .on_hover((on, cx) => act.hoverHeader(id, on, cx))
      .on_click((_e, cx) => act.fold(id, cx)))
    .child(providerIcon(id, g.name, t.foreground))
    .child(div().flex_none().font_semibold().child(g.name))
    .when(g.plan != null, (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.accent).child(g.plan)))
    .when(!scope && (g.folded || arrows || panel.hovered === id), (e) => e.child(svg(modIcon(arrow)).size(12).text_color(t.dim)));
}

function foldedNumbers(g, s, t) {
  const opacity = g.dim ? DIMMED : 1;
  return h_flex().gap(8).items_center().flex_none()
    .when(!g.failed, (e) => e.child(div().opacity(opacity).child(usageBar(FOLDED_BAR_W, s.fill, s.tick, levelColor(s.level, t), t))))
    .child(numberCell(PERCENT_COLUMN_W, s.percent).opacity(opacity).text_color(limitNumberColor(s.level, s.percent, t)))
    .child(numberCell(LEFT_COLUMN_W, s.left).opacity(opacity).text_size(11).text_color(t.dim));
}

function groupWithoutSummary(g, head, panel, scope) {
  const { t } = panel;
  if (g.folded && g.failed) return v_flex().gap(8).child(head.child(failure(g.status, t)))
    .when(panel.showFailedAge && g.age != null, (e) => e.child(ageLine(g.age, t)));
  head.child(div().flex_1())
    .child(div().min_w(0).truncate().text_size(11).text_color(g.failed ? levelColor("hot", t) : t.dim).child(g.status));
  if (g.folded) return v_flex().gap(8).child(head);
  return v_flex().gap(8).child(head).children(groupBody(g, t, scope));
}

export function limitsGroup(g, arrows, panel, scope = null) {
  const head = header(g, arrows, panel, scope);
  const s = g.folded ? g.summary : null;
  if (!s) return groupWithoutSummary(g, head, panel, scope);
  const { t } = panel;
  return v_flex().gap(8).child(head
    .child(g.failed ? failure(g.status, t) : rightLabel(s.long, t))
    .child(foldedNumbers(g, s, t)));
}

export function spendLine(g, t) {
  const opacity = g.failed ? DIMMED : 1;
  return h_flex().gap(6).items_center().opacity(g.dim && !g.failed ? DIMMED : 1)
    .child(providerIcon(g.providerId, g.name, t.foreground))
    .child(div().flex_none().font_semibold().child(g.name))
    .child(g.failed ? failure(g.status, t) : rightLabel("Tokens today / 7d", t))
    .child(h_flex().gap(8).items_center().flex_none()
      .child(numberCell(PERCENT_COLUMN_W, g.today ?? NO_READING).opacity(opacity).text_color(g.today == null ? t.dim : t.foreground))
      .child(numberCell(LEFT_COLUMN_W, g.week ?? NO_READING).opacity(opacity).text_color(g.week == null ? t.dim : t.muted)));
}
