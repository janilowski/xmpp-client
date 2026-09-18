import { decode, decodeBytes, encode } from "./base64.js";

test("fallback decoder preserves the same strict Base64 contract", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
  Object.defineProperty(Uint8Array, "fromBase64", {
    configurable: true,
    value: undefined,
  });
  try {
    expect(decodeBytes("AP8=")).toEqual(new Uint8Array([0, 255]));
    expect(decodeBytes("")).toEqual(new Uint8Array());
    for (const value of [" Zg==", "Zg==\n", "Zg", "Zh==", "Zm9=", "=AAA"]) {
      expect(() => decodeBytes(value)).toThrow();
    }
  } finally {
    if (descriptor) {
      Object.defineProperty(Uint8Array, "fromBase64", descriptor);
    } else {
      delete Uint8Array.fromBase64;
    }
  }
});

// RFC 6120 §13.9.1 / RFC 4648 §4: no ignored characters or malformed padding.
test.each([
  " Zg==",
  "Zg==\n",
  "Z\tg==",
  "Zg",
  "Zg=",
  "Zg===",
  "=AAA",
  "AA=A",
  "AA-_",
  "Zh==",
  "Zm9=",
])("rejects invalid SASL Base64: %j", (value) => {
  expect(() => decodeBytes(value)).toThrow();
  expect(() => decode(value)).toThrow();
});

test.each([
  ["", []],
  ["Zg==", [102]],
  ["Zm8=", [102, 111]],
  ["Zm9v", [102, 111, 111]],
  ["AP8=", [0, 255]],
])("accepts canonical Base64: %s", (value, bytes) => {
  expect(decodeBytes(value)).toEqual(Uint8Array.from(bytes));
});

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

test("round-trips arbitrary bytes without UTF-8 conversion", () => {
  const bytes = Uint8Array.from([0, 0x7f, 0x80, 0xff]);

  expect(encode(bytes)).toBe("AH+A/w==");
  expect(decodeBytes(encode(bytes))).toEqual(bytes);
});
