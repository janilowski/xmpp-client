import { expect, test } from "bun:test";
import isIRI from "../lib/isIRI.js";

// RFC3986 §3 / RFC3987 §2.2 generic syntax, not scheme-specific resolution.
const valid = [
  "foo:",
  "foo:?",
  "foo:#",
  "foo:?#",
  "foo:/",
  "foo:///path",
  "foo://///path",
  "a+1.-:rootless/path",
  "XMPP:user@example.test/r?message#part",
  "http://example.test/path?x=1&y=2#fragment",
  "mailto:user@example.test",
  "urn:example:animal:ferret:nose",
  "foo://",
  "foo://:/",
  "foo://user@/path",
  "foo://user:password@host:999999/path",
  "foo://host:/path",
  "foo://user%40name@host/path",
  "foo://reg!$&'()*+,;=name/path",
  "foo://999.999.999.999/path",
  "foo://01.2.3.4/path",
  "foo://%FF/path",
  "foo:%00%ff%2F",
  "foo:path:with@reserved!$&'()*+,;=._~-",
  "foo:path?query/with?slash#fragment/with?query",
  "foo://bücher.example/私",
  "foo:\u00A0\u200D\u2010",
  "foo:𐀀#𐀀",
  "foo:path?\uE000\uF8FF\u{F0000}\u{FFFFD}\u{100000}\u{10FFFD}",
  "foo://[v1.name]/path",
  "foo://[VF.a:b!$&'()*+,;=._~-]:999999/path",
  "foo://[::]/",
  "foo://[::1]/",
  "foo://[2001:DB8::1]/",
  "foo://[1:2:3:4:5:6:7:8]/",
  "foo://[::ffff:192.0.2.128]/",
  "foo://[1:2:3:4:5:6:192.0.2.128]/",
];
const invalid = [
  "",
  "relative/path",
  "//host/path",
  "#fragment",
  "?query",
  ":path",
  "1bad:path",
  "+bad:path",
  "é:path",
  "bad_scheme:path",
  "foo :path",
  " foo:path",
  "foo:path ",
  "foo:path\t",
  "foo:path\n",
  "foo:path\r",
  "foo:a b",
  "foo:a\\b",
  "foo:%",
  "foo:%0",
  "foo:%GG",
  "foo:100%",
  "foo:path[part]",
  "foo:path<part>",
  "foo:path|part",
  "foo:path^part",
  "foo:path`part",
  "foo:path{part}",
  'foo:path"part',
  "foo:path#fragment#again",
  "foo:path?bad%GG",
  "foo:path#bad%GG",
  "foo://user@@host/path",
  "foo://host:abc/path",
  "foo://host:-3/path",
  "foo://host:3:4/path",
  "foo://host\\name/path",
  "foo://host[part]/path",
  "foo://[not-an-ip]/",
  "foo://[127.0.0.1]/",
  "foo://[::1",
  "foo://[::1]junk/",
  "foo://[::1]:abc/",
  "foo://[::1]:42\n",
  "foo://[v.name]/",
  "foo://[v1.]/",
  "foo://[v1.é]/",
  "foo://[v1.name%20]/",
  "foo://[v1.name@tail]/",
  "foo://[::1%25zone]/",
  "foo://[1:2:3:4:5:6:7]/",
  "foo://[1:2:3:4:5:6:7:8:9]/",
  "foo://[1:2:3:4:5:6:7:8::]/",
  "foo://[1::2::3]/",
  "foo://[:::]/",
  "foo://[:1:2:3:4:5:6:7]/",
  "foo://[1:2:3:4:5:6:7:]/",
  "foo://[12345::]/",
  "foo://[::ffff:192.0.2.256]/",
  "foo://[::ffff:192.0.2.01]/",
  "foo://[192.0.2.1::]/",
  "foo://[1:2:3:4:5:192.0.2.1]/",
  "foo:\uE000",
  "foo:path#\uE000",
  "foo://\uE000/path",
  "foo:\uD800",
  "foo:\uDFFF",
  "foo:\u{1FFFE}",
  "foo:path?\u{FFFFE}",
];

test.each(valid)("RFC3987 §2.2 accepts generic IRI %j", (value) => {
  expect(isIRI(value)).toBe(true);
});
test.each(invalid)("RFC3987 §2.2 rejects malformed generic IRI %j", (value) => {
  expect(isIRI(value)).toBe(false);
});

// §4.1 overrides the broad ucschar grammar; encoded forms remain valid URI octets.
test.each([0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e])(
  "RFC3987 §4.1 excludes raw bidi formatting scalar %i",
  (point) => {
    const character = String.fromCodePoint(point);
    for (const value of [
      `foo:${character}`,
      `foo:path?q=${character}`,
      `foo:path#${character}`,
      `foo://host${character}/`,
      `foo://user${character}@host/`,
    ]) {
      expect(isIRI(value)).toBe(false);
    }
  },
);
test.each([
  "%E2%80%8E",
  "%E2%80%8F",
  "%E2%80%AA",
  "%E2%80%AB",
  "%E2%80%AC",
  "%E2%80%AD",
  "%E2%80%AE",
])(
  "RFC3987 §§3.2/4.1 preserves percent-encoded formatting octets %s",
  (encoded) => {
    expect(isIRI(`foo:${encoded}?${encoded}#${encoded}`)).toBe(true);
  },
);
test("RFC3987 §4.2 preserves RTL and mixed-direction text allowed by SHOULD rules", () => {
  expect(isIRI("foo:שלוםabc")).toBe(true);
  expect(isIRI("foo:نامه?שלוםabc#私")).toBe(true);
  expect(isIRI("foo:\u2066")).toBe(true);
});

// Normative scalar intervals; expected values do not use production character classes.
const UCS_RANGES = [
  [0xa0, 0xd7ff],
  [0xf900, 0xfdcf],
  [0xfdf0, 0xffef],
  [0x10000, 0x1fffd],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
  [0x40000, 0x4fffd],
  [0x50000, 0x5fffd],
  [0x60000, 0x6fffd],
  [0x70000, 0x7fffd],
  [0x80000, 0x8fffd],
  [0x90000, 0x9fffd],
  [0xa0000, 0xafffd],
  [0xb0000, 0xbfffd],
  [0xc0000, 0xcfffd],
  [0xd0000, 0xdfffd],
  [0xe1000, 0xefffd],
];
test.each(UCS_RANGES)(
  "RFC3987 §2.2 accepts ucschar boundary %i–%i",
  (first, last) => {
    for (const point of [first, last]) {
      const character = String.fromCodePoint(point);
      expect(isIRI(`foo:${character}?q=${character}#${character}`)).toBe(true);
      expect(isIRI(`foo://user${character}@host${character}/path`)).toBe(true);
    }
  },
);

test.each([
  0x80, 0x9f, 0xd800, 0xdfff, 0xfdd0, 0xfdef, 0xfff0, 0xffff, 0x1fffe, 0x1ffff,
  0x2fffe, 0x3fffe, 0x4fffe, 0x5fffe, 0x6fffe, 0x7fffe, 0x8fffe, 0x9fffe,
  0xafffe, 0xbfffe, 0xcfffe, 0xdfffe, 0xe0000, 0xe0fff, 0xefffe, 0xffffe,
  0x10fffe, 0x10ffff,
])("RFC3987 §2.2 rejects excluded scalar %i", (point) => {
  const character = String.fromCodePoint(point);
  expect(isIRI(`foo:${character}`)).toBe(false);
  expect(isIRI(`foo:path?q=${character}`)).toBe(false);
  expect(isIRI(`foo:path#${character}`)).toBe(false);
});

test.each([0xe000, 0xf8ff, 0xf0000, 0xffffd, 0x100000, 0x10fffd])(
  "RFC3987 §2.2 permits private scalar %i only in query",
  (point) => {
    const character = String.fromCodePoint(point);
    expect(isIRI(`foo:path?q=${character}`)).toBe(true);
    expect(isIRI(`foo:${character}`)).toBe(false);
    expect(isIRI(`foo:path#${character}`)).toBe(false);
    expect(isIRI(`foo://host${character}/path`)).toBe(false);
  },
);

test("RFC3986 §3.2.2 accepts every legal IPv6 compression placement", () => {
  const groups = ["1", "2", "3", "4", "5", "6", "7", "8"];
  for (let start = 0; start < groups.length; start++) {
    for (let count = 1; count <= groups.length - start; count++) {
      const address = `${groups.slice(0, start).join(":")}::${groups.slice(start + count).join(":")}`;
      expect(isIRI(`foo://[${address}]/path`)).toBe(true);
    }
  }
});

test("RFC3986 §3.2.2 counts trailing IPv4 as two IPv6 groups", () => {
  const groups = ["1", "2", "3", "4", "5", "6"];
  for (let start = 0; start < groups.length; start++) {
    for (let count = 1; count <= groups.length - start; count++) {
      const left = groups.slice(0, start).join(":");
      const right = [...groups.slice(start + count), "192.0.2.255"].join(":");
      expect(isIRI(`foo://[${left}::${right}]/path`)).toBe(true);
    }
  }
});

test("RFC3987 §2.2 rejects a bounded hostile suffix without recursive parsing", () => {
  const prefix = "a".repeat(100_000);
  expect(isIRI(`foo:${prefix}%GG`)).toBe(false);
  expect(isIRI(`foo://${prefix}:notaport/path`)).toBe(false);
  expect(isIRI(`foo://[${"1:".repeat(50_000)}::]/path`)).toBe(false);
});
