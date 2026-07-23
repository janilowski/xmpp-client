import type { Element, XMLAttributes, XMLChild } from "./index.js";

export const Fragment: unique symbol;

export function jsx(
  type: string,
  props: XMLAttributes & { children?: XMLChild },
): Element;
export function jsxs(
  type: string,
  props: XMLAttributes & { children?: XMLChild },
): Element;

export namespace JSX {
  type ElementType = string | typeof Fragment;
  type Element = import("./index.js").Element;

  interface IntrinsicElements {
    [name: string]: XMLAttributes & { children?: XMLChild };
  }
}
