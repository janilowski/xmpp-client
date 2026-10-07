// RFC3987 §§2.2/4.1: URI/IRI syntax, without resolution or scheme-specific rules.
const UCSCHAR =
  "\\u00A0-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFEF" +
  "\\u{10000}-\\u{1FFFD}\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}" +
  "\\u{40000}-\\u{4FFFD}\\u{50000}-\\u{5FFFD}\\u{60000}-\\u{6FFFD}" +
  "\\u{70000}-\\u{7FFFD}\\u{80000}-\\u{8FFFD}\\u{90000}-\\u{9FFFD}" +
  "\\u{A0000}-\\u{AFFFD}\\u{B0000}-\\u{BFFFD}\\u{C0000}-\\u{CFFFD}" +
  "\\u{D0000}-\\u{DFFFD}\\u{E1000}-\\u{EFFFD}";
const IPRIVATE = "\\uE000-\\uF8FF\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}";
const UNRESERVED = "A-Za-z0-9._~";
const SUB_DELIMS = "!$&'()*+,;=";
const PCT_ENCODED = "%[0-9A-Fa-f]{2}";
const IPCHAR = `(?:[${UNRESERVED}${UCSCHAR}${SUB_DELIMS}:@-]|${PCT_ENCODED})`;
const PATH = new RegExp(`^(?:${IPCHAR}|/)*$`, "u");
const QUERY = new RegExp(`^(?:${IPCHAR}|[/?${IPRIVATE}])*$`, "u");
const FRAGMENT = new RegExp(`^(?:${IPCHAR}|[/?])*$`, "u");
const USERINFO = new RegExp(
  `^(?:[${UNRESERVED}${UCSCHAR}${SUB_DELIMS}:-]|${PCT_ENCODED})*$`,
  "u",
);
const REG_NAME = new RegExp(
  `^(?:[${UNRESERVED}${UCSCHAR}${SUB_DELIMS}-]|${PCT_ENCODED})*$`,
  "u",
);
const IPV_FUTURE = /^[vV][0-9A-Fa-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/u;
const H16 = /^[0-9A-Fa-f]{1,4}$/u;
const DEC_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const IPV4 = new RegExp(`^${DEC_OCTET}(?:\\.${DEC_OCTET}){3}$`, "u");
const PORT = /^[0-9]*$/u;
const IRI =
  /^([A-Za-z][A-Za-z0-9+.-]*):([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/u;
const IPV6_GROUPS = 8;
const BIDI_CONTROL = /[\u200E\u200F\u202A-\u202E]/u;

function isIPLiteral(value) {
  if (IPV_FUTURE.test(value)) {
    return true;
  }
  const compressed = value.includes("::");
  if (compressed && value.indexOf("::") !== value.lastIndexOf("::")) {
    return false;
  }
  const groups = value
    .split("::")
    .flatMap((side) => (side ? side.split(":") : []));
  let length = groups.length;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group.includes(".")) {
      if (
        i !== groups.length - 1 ||
        !value.endsWith(group) ||
        !IPV4.test(group)
      ) {
        return false;
      }
      length += 1; // A final dotted IPv4 address occupies two h16 groups.
    } else if (!H16.test(group)) {
      return false;
    }
  }
  return compressed ? length < IPV6_GROUPS : length === IPV6_GROUPS;
}

function isAuthority(value) {
  const at = value.indexOf("@");
  if (at !== -1) {
    if (!USERINFO.test(value.slice(0, at))) {
      return false;
    }
    value = value.slice(at + 1);
  }
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    const port = value.slice(close + 1);
    return (
      close !== -1 &&
      isIPLiteral(value.slice(1, close)) &&
      (!port || (port.startsWith(":") && PORT.test(port.slice(1))))
    );
  }
  const colon = value.indexOf(":");
  return colon === -1
    ? REG_NAME.test(value)
    : REG_NAME.test(value.slice(0, colon)) && PORT.test(value.slice(colon + 1));
}

export default function isIRI(value) {
  if (BIDI_CONTROL.test(value)) {
    return false;
  }
  const parts = IRI.exec(value);
  if (!parts || !QUERY.test(parts[3] ?? "") || !FRAGMENT.test(parts[4] ?? "")) {
    return false;
  }
  let path = parts[2];
  if (path.startsWith("//")) {
    const slash = path.indexOf("/", 2);
    const authority = slash === -1 ? path.slice(2) : path.slice(2, slash);
    if (!isAuthority(authority)) {
      return false;
    }
    path = slash === -1 ? "" : path.slice(slash);
  }
  return PATH.test(path);
}
