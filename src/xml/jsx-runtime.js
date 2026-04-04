import xml from "./index.js";

export const Fragment = Symbol.for("xmpp.xml.fragment");

function toChildren(children) {
  if (children === undefined) return [];
  return Array.isArray(children) ? children : [children];
}

function create(type, props, key) {
  const { children, ...attrs } = props ?? {};
  const xmlChildren = toChildren(children);

  if (type === Fragment) {
    return xmlChildren;
  }

  return xml(type, attrs, ...xmlChildren);
}

export function jsx(type, props, key) {
  return create(type, props, key);
}

export function jsxs(type, props, key) {
  return create(type, props, key);
}
