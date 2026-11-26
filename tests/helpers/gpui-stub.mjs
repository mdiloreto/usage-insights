// Recording stand-ins for the gpui modules, so the canary's UI code can be rendered under node:test.
const wrap = (type, id) => {
  const node = { type, id, calls: [], kids: [], texts: [], handlers: {} };
  const methods = {
    id(value) { node.id = value; return element; },
    child(value) { return take(value); },
    children(values) { for (const value of values) take(value); return element; },
    when(condition, branch) { if (condition) branch(element); return element; },
  };
  const take = (value) => {
    if (value?.__node) node.kids.push(value.__node);
    else if (value != null) node.texts.push(String(value));
    return element;
  };
  const element = new Proxy({}, {
    get(_target, property) {
      if (property === "__node") return node;
      if (typeof property === "symbol") return undefined;
      if (property in methods) return methods[property];
      return (...args) => {
        node.calls.push([property, args]);
        if (/^on_|^hover$/.test(property)) node.handlers[property] = args.at(-1);
        for (const arg of args) if (arg?.__node) node.kids.push(arg.__node);
        return element;
      };
    },
  });
  return element;
};

export const div = () => wrap("div");
export const image = (path) => wrap("image").asset(path);
export const svg = (path) => wrap("svg").asset(path);
export const v_flex = () => wrap("v_flex");
export const h_flex = () => wrap("h_flex");
export class View {}
export const Button = { new: (id) => wrap("Button", id) };
export const Popover = { new: (id) => wrap("Popover", id) };
export const HoverCard = { new: (id) => wrap("HoverCard", id) };

export const nodeOf = (element) => element.__node;
export const walk = (node, visit) => {
  visit(node);
  for (const kid of node.kids) walk(kid, visit);
};
export const textOf = (node) => [...node.texts, ...node.kids.map(textOf)].join(" ");
export const findAll = (node, test) => {
  const out = [];
  walk(node, (n) => { if (test(n)) out.push(n); });
  return out;
};
export const findById = (node, id) => findAll(node, (n) => n.id === id)[0];
export const assets = (node) => findAll(node, (n) => n.calls.some(([name]) => name === "asset"))
  .map((n) => n.calls.find(([name]) => name === "asset")[1][0]);
export const theme = new Proxy({}, { get: () => "#808080" });
