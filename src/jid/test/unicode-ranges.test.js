import { decodeRanges } from "../lib/unicode-ranges.js";

test("decodes gaps and lengths at both Unicode boundaries", () => {
  // Ranges: U+0000..0001, U+10FFFF; pairs: (0, 2), (0x10fffd, 1).
  const property = decodeRanges("AC9__hBB");
  expect(property.source).toBe("[\\u{0}-\\u{1}\\u{10ffff}]");
  expect(property.test("\u0000")).toBe(true);
  expect(property.test("\u0001")).toBe(true);
  expect(property.test("\u0002\ud800\udfff\u{10fffe}")).toBe(false);
  expect(property.test("\u{10ffff}")).toBe(true);
  expect(property.test("prefix\u{10ffff}suffix")).toBe(true);
  expect(property.test("")).toBe(false);
});

test("can represent the full Unicode range", () => {
  const property = decodeRanges("AgggiB");
  expect(property.source).toBe("[\\u{0}-\\u{10ffff}]");
  expect(property.test("\u0000")).toBe(true);
  expect(property.test("\ud800")).toBe(true);
  expect(property.test("\u{10ffff}")).toBe(true);
});

test("can represent an empty property without matching anything", () => {
  const empty = decodeRanges("");
  expect(empty.source).toBe("[]");
  expect(empty.test("\u0000\ud800\u{10ffff}")).toBe(false);
});

for (const data of [
  "B", // Missing range length.
  "!B", // Invalid alphabet character.
  "BA", // Zero-length range.
  "hggiBB", // Start past U+10FFFF.
  "___hBC", // End past U+10FFFF.
  "AgggiBAB", // Cumulative overflow after a full range.
  "Ag", // Unterminated varint.
  "ggggggBB", // Integer overflow.
]) {
  test(`rejects corrupt generated data ${JSON.stringify(data)}`, () => {
    expect(() => decodeRanges(data)).toThrow(Error);
  });
}
