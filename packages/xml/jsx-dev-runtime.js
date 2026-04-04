export { Fragment, jsx, jsxs } from "./jsx-runtime.js";

export function jsxDEV(type, props, key) {
  return jsx(type, props, key);
}

import { jsx } from "./jsx-runtime.js";
