import { describe, expect, test } from "bun:test";
import isLanguageTag from "../lib/language.js";

// RFC 5646 §2.1: literal vectors include every fixed grandfathered alternative.
const GRANDFATHERED = [
  "en-GB-oed",
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
  "sgn-BE-FR",
  "sgn-BE-NL",
  "sgn-CH-DE",
  "art-lojban",
  "cel-gaulish",
  "no-bok",
  "no-nyn",
  "zh-guoyu",
  "zh-hakka",
  "zh-min",
  "zh-min-nan",
  "zh-xiang",
];

describe("RFC 5646 — structural language tags", () => {
  test.each(GRANDFATHERED)(
    "§2.1: accept grandfathered %s case-insensitively",
    (tag) => {
      expect(isLanguageTag(tag)).toBe(true);
      expect(isLanguageTag(tag.toUpperCase())).toBe(true);
    },
  );

  test.each([
    "en",
    "EN",
    "de-CH",
    "es-419",
    "zh-Hant-TW",
    "sr-Latn-RS",
    "zh-cmn-Hans-CN",
    "sl-rozaj-biske-1994",
    "de-DE-1901",
    "qaa-Qaaa-QM",
    "abcd",
    "abcdefgh",
    "abcd-Latn-US-abcde",
    "en-u-ca-gregory",
    "en-t-en-us",
    "en-a-12-abcdefgh-b-ab",
    "en-0-foo",
    "x-a",
    "X-Foo-1",
    "en-x-a-b",
    "en-u-ca-gregory-x-u-u",
    "x-1901-1901",
    "en-x-u-ca-u-ca",
    "en-x-abcdefgh",
  ])(
    "§§2.1–2.2: accept the format of %s without claiming registration",
    (tag) => {
      expect(isLanguageTag(tag)).toBe(true);
    },
  );

  test.each([
    "",
    "not a tag",
    "en_US",
    "en US",
    "en\tUS",
    "en\n",
    "en\r\n",
    " en",
    "en ",
    "en\u00a0US",
    "en-🙂",
    "en-ÄA",
    "x-Ä",
    "en-x-Ä",
    "en-u-ÄA",
    "x-🙂",
    "en-x-a_b",
    "en--US",
    "en-",
    "-en",
    "e",
    "abcdefghi",
    "123",
    "en-US-Latn",
    "en-Latn-Latn",
    "en-US-DE",
    "en-US-abcd",
    "x",
    "en-x",
    "en-u",
    "en-u-x-a",
    "en-u-a-bb",
    "i-madeup",
    "sgn-BE-AA",
    "en-GB-oed-x-a",
    "en-x-abcdefghi",
    "abcd-cmn",
  ])("§§2.1–2.2: reject malformed %j", (tag) => {
    expect(isLanguageTag(tag)).toBe(false);
  });

  test.each(["zh-cmn-yue", "zh-cmn-yue-gan"])(
    "§2.2.2: reject permanently reserved extlang positions in %s",
    (tag) => {
      expect(isLanguageTag(tag)).toBe(false);
    },
  );

  test.each([
    "sl-rozaj-ROZAJ",
    "en-abcde-ABCDE",
    "en-1901-1901",
    "en-u-ca-gregory-U-nu-latn",
    "en-a-foo-A-bar",
    "en-0-foo-0-bar",
  ])("§§2.2.5–2.2.6: reject repeated variant or singleton in %s", (tag) => {
    expect(isLanguageTag(tag)).toBe(false);
  });

  test("§2.1: reject non-string values", () => {
    for (const value of [undefined, null, 42, {}, ["en"]]) {
      expect(isLanguageTag(value)).toBe(false);
    }
  });

  test("§4.4: valid private use has no implicit whole-tag length limit", () => {
    // Independent input also catches regular-expression engine repetition limits.
    const tag = "en-x" + "-a".repeat(500_000);
    expect(isLanguageTag(tag)).toBe(true);
    expect(isLanguageTag(tag + "-")).toBe(false);
  });
});
