// RFC 5646 §2.1: grandfathered tags are whole-tag alternatives to the grammar.
const GRANDFATHERED = new Set([
  "en-gb-oed",
  "i-ami",
  "i-bnn",
  "i-default",
  "i-enochian",
  "i-hak",
  "i-klingon",
  "i-lux",
  "i-mingo",
  "i-navajo",
  "i-pwn",
  "i-tao",
  "i-tay",
  "i-tsu",
  "sgn-be-fr",
  "sgn-be-nl",
  "sgn-ch-de",
  "art-lojban",
  "cel-gaulish",
  "no-bok",
  "no-nyn",
  "zh-guoyu",
  "zh-hakka",
  "zh-min",
  "zh-min-nan",
  "zh-xiang",
]);

// Validate format and universal constraints, not IANA registration or preference.
export default function isLanguageTag(value) {
  if (typeof value !== "string" || !value || /[^A-Za-z0-9-]/.test(value)) {
    return false;
  }
  const tag = value.toLowerCase();
  if (GRANDFATHERED.has(tag)) {
    return true;
  }

  const subtags = tag.split("-");
  if (subtags.some((subtag) => subtag.length === 0 || subtag.length > 8)) {
    return false;
  }
  if (subtags[0] === "x") {
    return subtags.length > 1;
  }
  if (!/^[a-z]{2,8}$/.test(subtags[0])) {
    return false;
  }

  let index = 1;
  // §2.2.2 reserves the second and third extlang positions permanently.
  if (subtags[0].length <= 3 && /^[a-z]{3}$/.test(subtags[index] ?? "")) {
    index += 1;
  }
  if (/^[a-z]{4}$/.test(subtags[index] ?? "")) {
    index += 1;
  }
  if (/^(?:[a-z]{2}|[0-9]{3})$/.test(subtags[index] ?? "")) {
    index += 1;
  }

  const variants = new Set();
  while (/^(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3})$/.test(subtags[index] ?? "")) {
    const variant = subtags[index];
    if (variants.has(variant)) {
      return false;
    }
    variants.add(variant);
    index += 1;
  }

  const extensions = new Set();
  while (subtags[index]?.length === 1 && subtags[index] !== "x") {
    const singleton = subtags[index];
    if (extensions.has(singleton)) {
      return false;
    }
    extensions.add(singleton);
    index += 1;
    const start = index;
    while (subtags[index]?.length >= 2) {
      index += 1;
    }
    if (index === start) {
      return false;
    }
  }

  // Private-use subtags have no variant or extension uniqueness constraint.
  if (subtags[index] === "x") {
    return index + 1 < subtags.length;
  }
  return index === subtags.length;
}
