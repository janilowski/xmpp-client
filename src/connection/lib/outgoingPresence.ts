import type { Element } from "../../../types/index.js";

// Private presence preparation, separate from SM admission and replay authority.
export const outgoingPresence = new WeakMap<
  object,
  (source: string, original: Element) => Promise<Element>
>();
