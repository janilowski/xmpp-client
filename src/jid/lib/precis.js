import * as unicode from "./unicode.js";

export const MAX_PART_BYTES = 1023;
const MAX_PROFILE_PASSES = 4; // RFC 8265 §5: first pass plus three retries.
const encoder = new TextEncoder();
const supportsUnicode16 =
  "\u1c89".toLowerCase() === "\u1c8a" && "\u{1ccf0}".normalize("NFKC") === "0";

export function checkRepertoire(value) {
  if (!supportsUnicode16 && /[\u0080-\u{10ffff}]/u.test(value)) {
    throw new TypeError("Unicode 16 normalization and case mapping required.");
  }
  // Pin input as well as output: a newer runtime can case-map future letters.
  if (unicode.unassigned.test(value)) {
    throw new TypeError("Unassigned JID code point.");
  }
}

export function checkLength(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_PART_BYTES ||
    (/[\u0080-\u{10ffff}]/u.test(value) &&
      encoder.encode(value).length > MAX_PART_BYTES)
  ) {
    throw new TypeError("Invalid JID part length.");
  }
  return value;
}

export function mapWidth(value) {
  if (!unicode.width.test(value)) {
    return value;
  }
  return [...value]
    .map((char) => (unicode.width.test(char) ? char.normalize("NFKC") : char))
    .join("");
}

// RFC 5892 Appendix A, shared by IDNA and both PRECIS classes.
export function validateClass(value, allowed) {
  const chars = [...value];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (
      unicode.identifier.test(char) ||
      (allowed === "opaque" && unicode.freeform.test(char))
    ) {
      continue;
    }
    const before = chars[i - 1] ?? "";
    const after = chars[i + 1] ?? "";
    let valid = false;
    switch (char) {
      case "\u200c": {
        let left = i - 1;
        let right = i + 1;
        while (left >= 0 && unicode.joinTransparent.test(chars[left])) {
          left--;
        }
        while (
          right < chars.length &&
          unicode.joinTransparent.test(chars[right])
        ) {
          right++;
        }
        valid =
          unicode.virama.test(before) ||
          (unicode.joinLeft.test(chars[left] ?? "") &&
            unicode.joinRight.test(chars[right] ?? ""));
        break;
      }
      case "\u200d":
        valid = unicode.virama.test(before);
        break;
      case "·":
        valid = before === "l" && after === "l";
        break;
      case "\u0375":
        valid = unicode.greek.test(after);
        break;
      case "\u05f3":
      case "\u05f4":
        valid = unicode.hebrew.test(before);
        break;
      case "・":
        valid = unicode.japanese.test(value);
        break;
      default:
        if (/[\u0660-\u0669]/u.test(char)) {
          valid = !/[\u06f0-\u06f9]/u.test(value);
        } else if (/[\u06f0-\u06f9]/u.test(char)) {
          valid = !/[\u0660-\u0669]/u.test(value);
        }
    }
    if (!valid) {
      throw new TypeError("Invalid JID code point or context.");
    }
  }
}

// RFC 5893 §2. Call for each label of a bidi domain, or an RTL username.
export function validateBidi(value) {
  const chars = [...value];
  const rtl = unicode.rtlStart.test(chars[0] ?? "");
  const start = rtl ? unicode.rtlStart : unicode.ltrStart;
  const last = chars.findLast((char) => !unicode.nsm.test(char)) ?? "";
  // The generator verifies the remaining allowed bidi classes in IdentifierClass.
  const forbidden = rtl ? unicode.ltrStart : unicode.rtl;
  if (
    !start.test(chars[0] ?? "") ||
    forbidden.test(value) ||
    !(
      start.test(last) ||
      unicode.en.test(last) ||
      (rtl && unicode.an.test(last))
    ) ||
    (rtl && unicode.en.test(value) && unicode.an.test(value))
  ) {
    throw new TypeError("Invalid JID directionality.");
  }
}

export function prepareLocal(value) {
  if (/^[\x21-\x7e]+$/u.test(value) && !/["&'/:<>@]/u.test(value)) {
    return checkLength(value.toLowerCase());
  }
  checkRepertoire(value);
  // RFC 8264 §7 and RFC 7622 §4: map before validating the prepared identity.
  for (let pass = 0; ; pass++) {
    const previous = value;
    value = mapWidth(value);
    value = value.toLowerCase().normalize("NFC");
    if (value === previous) {
      break;
    }
    if (pass === MAX_PROFILE_PASSES - 1) {
      throw new TypeError("Unstable JID localpart.");
    }
  }
  checkLength(value);
  validateClass(value, "identifier");
  if (unicode.rtl.test(value)) {
    validateBidi(value);
  }
  if (/["&'/:<>@]/u.test(value)) {
    throw new TypeError("Invalid JID localpart.");
  }
  return checkLength(value);
}

export function prepareResource(value) {
  if (/^[\x20-\x7e]+$/u.test(value)) {
    return checkLength(value);
  }
  checkRepertoire(value);
  // OpaqueString preserves case and width; only non-ASCII spaces are mapped.
  value = value.replace(/\p{Zs}/gu, " ").normalize("NFC");
  checkLength(value);
  validateClass(value, "opaque");
  return checkLength(value);
}
