import { expect, test } from "bun:test";
import jid from "../src/jid/index.js";

// RFC 5893 §2 defines six conditions. RFC 8265 §3.3.1 applies them to
// localparts containing R/AL/AN; a Bidi domain applies them to every label.
// OpaqueString has no directionality rule (RFC 8265 §4.2.2).
// https://www.rfc-editor.org/rfc/rfc5893.html#section-2
// https://www.rfc-editor.org/rfc/rfc8265.html#section-3.3.1
// A-labels are independent literals from Python's Punycode codec. The codec
// supplies encoding only; validity comes from the cited six conditions.
const RTL_DOMAIN = "אב.example";
const vectors = [
  [1, "R initial", "א", "xn--4db", true, true],
  [1, "AL initial", "ب", "xn--ngb", true, true],
  [1, "EN initial before R", "1א", "xn--1-0hc", false, false],
  [1, "NSM initial before R", "\u05b0א", "xn--7cb8d", false, false],
  [2, "L inside RTL", "אaב", "xn--a-zhce", false, false],
  [2, "context-valid BN inside RTL", "ب\u200cب", "xn--ngba799q", true, true],
  [3, "EN then multiple NSM", "אי1\u05b0\u05b1", "xn--1-6fcd5jwb", true, true],
  [3, "AN then multiple NSM", "ב١\u05b0\u05b1", "xn--7cbc8g0z", true, true],
  [3, "ES then multiple NSM", "ב-\u05b0\u05b1", "xn----6fcd9j", false, false],
  [4, "EN before AN", "ب1١", "xn--1-0mc6o", false, false],
  [4, "AN before EN", "ب١1", "xn--1-0mc5o", false, false],
  [5, "R inside LTR", "aאa", "xn--aa-vld", false, false],
  [5, "AN inside LTR", "a١a", "xn--aa-byd", false, false],
  [5, "AL inside LTR", "aبa", "xn--aa-ftd", false, false],
  // Without RTL code points these localparts do not acquire Bidi restrictions.
  [6, "ES then multiple NSM", "a-\u05b0\u05b1", "xn--a--5ide", true, false],
  [6, "EN then multiple NSM", "a1\u05b0\u05b1", "xn--a1-5ide", true, true],
  [6, "L then multiple NSM", "a\u05b0\u05b1", "xn--a-6fcd", true, true],
] as const;

for (const [rule, name, value, alabel, localValid, domainValid] of vectors) {
  for (const [slot, input, expected, valid] of [
    ["localpart", `${value}@example.test`, `${value}@example.test`, localValid],
    ["resourcepart", `example.test/${value}`, `example.test/${value}`, true],
    [
      "U-label Bidi domain",
      `${value}.${RTL_DOMAIN}`,
      `${value}.${RTL_DOMAIN}`,
      domainValid,
    ],
    [
      "A-label Bidi domain",
      `${alabel}.xn--4dbc.example`,
      `${value}.${RTL_DOMAIN}`,
      domainValid,
    ],
  ] as const) {
    test(`RFC 5893 §2 condition ${rule}: ${name} / ${slot}`, () => {
      if (!valid) {
        expect(() => jid(input)).toThrow(TypeError);
        return;
      }
      expect(() => jid(input)).not.toThrow();
      expect(jid(input).toString()).toBe(expected);
    });
  }
}

// These IdentifierClass punctuation characters are permitted by the Bidi rule
// inside RTL localparts, but are not valid IDNA label characters.
for (const [property, character] of [
  ["ES", "-"],
  ["CS", ","],
  ["ET", "$"],
  ["ON", "_"],
]) {
  test(`RFC 5893 §2 condition 2: permits interior ${property} in localparts`, () => {
    const value = `א${character}א@example.test`;
    expect(() => jid(value)).not.toThrow();
    expect(jid(value).toString()).toBe(value);
  });
}

for (const value of ["1", "a-\u05b0\u05b1"]) {
  test(`RFC 8265 §3.3.1 / RFC 5893 §1.1: no RTL trigger / ${value}`, () => {
    expect(() => jid(`${value}@example.test`)).not.toThrow();
    expect(jid(`${value}@example.test`).toString()).toBe(
      `${value}@example.test`,
    );
    expect(() => jid(`${value}.example`)).not.toThrow();
    expect(jid(`${value}.example`).toString()).toBe(`${value}.example`);
  });
}
