import jid from "../index.js";

test("RFC 8264 rejects a trailing control character", () => {
  const test = "test\u001A@example.com";

  expect(() => jid(test)).toThrow(TypeError);
});

test("RFC 8264 rejects an embedded control character", () => {
  const test = "test\u001Aa@example.com";

  expect(() => jid(test)).toThrow(TypeError);
});
