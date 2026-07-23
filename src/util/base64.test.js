import { decode, encode } from "./base64.js";

test("encodes and decodes ASCII", () => {
  expect(encode("hello")).toBe("aGVsbG8=");
  expect(decode("aGVsbG8=")).toBe("hello");
});

test("round-trips a SASL PLAIN payload", () => {
  const payload = "\0username\0password";

  expect(decode(encode(payload))).toBe(payload);
});

test.each([
  "æøå",
  "äöüß",
  "Привет",
  "日本語",
  "مرحبا",
  "שלום",
  "🎉",
  "Hello æøå Привет 日本語 🎉",
])("round-trips UTF-8 text: %s", (input) => {
  expect(decode(encode(input))).toBe(input);
});

test("encodes non-ASCII text as UTF-8 rather than Latin-1", () => {
  expect(encode("ø")).toBe("w7g=");
  expect(encode("æ")).toBe("w6Y=");
  expect(encode("å")).toBe("w6U=");
});

test("round-trips non-ASCII SASL PLAIN credentials", () => {
  const payload = "\0øyvindranda@example.com\0session-token";

  expect(decode(encode(payload))).toBe(payload);
});
