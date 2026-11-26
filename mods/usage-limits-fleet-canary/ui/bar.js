import { div, svg } from "gpui-kit";
import { Button, HoverCard, Popover, h_flex } from "gpui-base";
import { DIMMED, divider, levelColor, limitNumberColor, modIcon, providerIcon, sessionNumberColor, usageBar } from "./kit.js";
import { DENSITY } from "../lib/view.js";
import { PANEL_CLOSE_DELAY_MS } from "../lib/mod.js";
import { hostChip } from "../fleet/model.js";

const BAR_W = 30;
const PANEL_OPEN_DELAY_MS = 350;

const label = (text, t) => div().text_size(10.5).text_color(t.dim).child(text);

function segment(s, density, t) {
  return h_flex().gap(5).items_center().flex_none()
    .when(density < DENSITY.NO_LABELS, (e) => e.child(label(s.short, t)))
    .when(density === DENSITY.FULL, (e) => e.child(usageBar(BAR_W, s.fill, s.tick, levelColor(s.level, t), t)))
    .child(div().whitespace_nowrap().text_color(limitNumberColor(s.level, s.text, t)).child(density === DENSITY.BRIEF ? s.brief : s.text));
}

function spendSegment(today, t) {
  return h_flex().gap(5).items_center().flex_none()
    .child(label("today", t))
    .child(div().whitespace_nowrap().text_color(t.foreground).child(today));
}

export function providerGroup(g, density, t, prefix = "ul", named = prefix !== "ul") {
  return h_flex().id(`${prefix}-${g.providerId}`).gap(density === DENSITY.FULL ? 10 : 8).items_center().flex_none()
    .opacity(g.dim ? DIMMED : 1)
    .child(providerIcon(g.providerId, g.icon, t.foreground))
    .when(named, (e) => e.child(label(g.name, t).whitespace_nowrap()))
    .when(g.mark != null, (e) => e.child(div().text_color(t.dim).child(g.mark)))
    .children(g.segments.map((s) => segment(s, density, t)))
    .when(g.spend != null, (e) => e.child(spendSegment(g.spend, t)));
}

function sessionNumbers(numbers, t) {
  return h_flex().gap(10).items_center().flex_none()
    .children(numbers.map((n) => div().whitespace_nowrap().text_color(sessionNumberColor(n.level, n.text, t)).child(n.text)));
}

function limitsTrigger({ model, numbers, density, onHover }, t) {
  const content = h_flex().id("ul-content").gap(14).items_center().flex_none().on_hover(onHover);
  if (numbers.length) {
    content.child(sessionNumbers(numbers, t));
    if (!model.empty) content.child(divider(t));
  }
  if (model.empty) content.child(div().id("ul-empty").child(svg(modIcon("gauge")).size(14)));
  model.groups.forEach((g, i) => {
    if (i > 0) content.child(divider(t));
    content.child(providerGroup(g, density, t));
  });
  return content;
}

function details(id, name, bar, t) {
  const popup = Popover.new(`ul-fleet-${id}`).anchor("bottom_right").open(bar.detailsOpen === id)
    .on_open_change((open, cx) => bar.toggleDetails(id, open, cx))
    .trigger(Button.new(`ul-fleet-details-${id}`).h(20).min_w(0).px(0).text_color(t.muted).bg(t.chrome).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).accessibility_label(`${name ? `${name} · ` : ""}Quota details`)
      .tooltip(name ? `${name} · Quota details` : "Quota details")
      .child(name ? div().min_w(0).truncate().child(name) : svg(modIcon("gauge")).size(14)));
  if (bar.detailsOpen === id) popup.content(bar.panel);
  return popup;
}

function fleetTrigger(bar, t) {
  const { numbers, groups, density, labels, named } = bar.fleet;
  const content = h_flex().id("ul-content").gap(8).items_center().min_w(0).on_hover(bar.onHover);
  if (numbers.length) content.child(sessionNumbers(numbers, t)).child(divider(t));
  if (labels) {
    return content
      .children(labels.map((name, i) => div().min_w(0).flex_shrink(1).child(details(String(i), name, bar, t))));
  }
  return content.children(groups.map((host, i) => h_flex().id(`ul-machine-${i}`).gap(8).items_center().flex_none()
    .child(div().text_size(10.5).text_color(t.foreground).font_semibold().flex_none().whitespace_nowrap()
      .px(5).py(1).rounded(4).border(1).border_color(t.border).child(hostChip(host)))
    .children(host.groups.map((g) => providerGroup(g, density, t, `ul-fleet-provider-${i}`, named !== false)))))
    .child(details("all", null, bar, t));
}

export function statusBar(bar, t) {
  const root = h_flex().id("root").size_full().px(bar.fleet?.padding ?? 12).items_center().justify_end().overflow_hidden()
    .bg(t.chrome).when(bar.border !== false, (e) => e.border_t(1).border_color(t.border)).text_size(11.8).text_color(t.muted)
    .on_size_change(bar.onResize);
  if (bar.fleet) return root.child(fleetTrigger(bar, t));
  return root
    .child(HoverCard.new("ul-panel").anchor("bottom_right").open_delay(PANEL_OPEN_DELAY_MS).close_delay(PANEL_CLOSE_DELAY_MS)
      .trigger(limitsTrigger(bar, t))
      .content(bar.panel));
}
