import { decode, encode } from "punycode/";
import * as unicode from "./unicode.js";
import {
  checkLength,
  checkRepertoire,
  mapWidth,
  validateBidi,
  validateClass,
} from "./precis.js";

const MAX_LABEL_BYTES = 63;
const MAX_DOMAIN_BYTES = 253;
const NON_ASCII = /[\u0080-\u{10ffff}]/u;

export default function prepareDomain(value) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("Invalid domain.");
  }
  // RFC 7622 §3.2 requires removing the final DNS dot before canonicalization.
  value = value.replace(/[.\u3002\uff0e\uff61]$/u, "");
  if (value.startsWith("[")) {
    if (/^\[v[0-9a-f]+\.[a-z0-9._~!$&'()*+,;=:-]+\]$/iu.test(value)) {
      return checkLength(value.toLowerCase());
    }
    // RFC 9844 removes zone identifiers from RFC 7622's wire grammar.
    if (!/^\[[0-9a-f:.]+\]$/iu.test(value)) {
      throw new TypeError("Invalid IP literal.");
    }
    try {
      return new URL(`http://${value}`).hostname;
    } catch {
      throw new TypeError("Invalid IP literal.");
    }
  }

  checkRepertoire(value);
  value = mapWidth(value.toLowerCase()).normalize("NFC").replaceAll("。", ".");
  // Bound contextual scans before processing labels, including hostile U-labels.
  checkLength(value);
  const labels = value.split(".");
  let dnsLength = labels.length - 1;
  for (let i = 0; i < labels.length; i++) {
    let label = labels[i];
    const alabel = label.startsWith("xn--");
    if (alabel) {
      if (label.length > MAX_LABEL_BYTES) {
        throw new TypeError("Domain label too long.");
      }
      try {
        label = decode(label.slice(4));
      } catch {
        throw new TypeError("Invalid A-label.");
      }
      checkRepertoire(label);
      if (
        !NON_ASCII.test(label) ||
        `xn--${encode(label)}` !== labels[i] ||
        label.normalize("NFC") !== label
      ) {
        throw new TypeError("Invalid A-label.");
      }
    }
    if (
      !label ||
      label.startsWith("-") ||
      label.endsWith("-") ||
      label.slice(2, 4) === "--" ||
      unicode.mark.test([...label][0])
    ) {
      throw new TypeError("Invalid domain label.");
    }
    if (/^[a-z0-9-]+$/u.test(label)) {
      if (label.length > MAX_LABEL_BYTES) {
        throw new TypeError("Domain label too long.");
      }
      dnsLength += label.length;
      continue;
    }
    validateClass(label, "identifier");
    if (unicode.idnaDisallowed.test(label)) {
      throw new TypeError("Invalid IDNA code point.");
    }
    const ascii = NON_ASCII.test(label) ? `xn--${encode(label)}` : label;
    if (ascii.length > MAX_LABEL_BYTES) {
      throw new TypeError("Domain label too long.");
    }
    dnsLength += ascii.length;
    labels[i] = label;
  }
  if (dnsLength > MAX_DOMAIN_BYTES) {
    throw new TypeError("Domain too long.");
  }
  value = labels.join(".");
  if (unicode.rtl.test(value)) {
    labels.forEach(validateBidi);
  }
  return checkLength(value);
}
