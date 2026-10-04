import { expect, mock, test } from "bun:test";
import Socket from "../lib/Socket.js";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const CONTENT = "jabber:client";
const PREFIXES = [" ", "\t", "\n", "\r", "\r\n", "\uFEFF"];
const DOCUMENTS = [
  ["open", `<open xmlns="${FRAMING}" version="1.0"/>`],
  ["close", `<close xmlns="${FRAMING}"/>`],
  ["stanza", `<message xmlns="${CONTENT}"/>`],
];

// RFC 7395 §3.3.3 applies to every outgoing document, not only stanzas.
for (const [name, document] of DOCUMENTS) {
  test.each(PREFIXES)(
    `reject ${name} leading %j before the native send or callback`,
    async (prefix) => {
      const socket = new Socket();
      const send = mock();
      const written = mock();
      socket.socket = { send };
      expect(() => socket.write(prefix + document, written)).toThrow(TypeError);
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();
      expect(written).not.toHaveBeenCalled();
    },
  );
}

test("reject an empty outgoing frame before the native send or callback", async () => {
  const socket = new Socket();
  const send = mock();
  const written = mock();
  socket.socket = { send };
  expect(() => socket.write("", written)).toThrow(TypeError);
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  expect(written).not.toHaveBeenCalled();
});

test.each([
  ...DOCUMENTS,
  ["XML declaration", `<?xml version="1.0"?><message xmlns="${CONTENT}"/>`],
  [
    "foreign Unicode extension",
    '<p:notice xmlns:p="urn:test:framing"><p:text>Zażółć 汉 🙂</p:text></p:notice>',
  ],
])(
  "write a valid %s unchanged and invoke the callback asynchronously",
  async (_name, document) => {
    const socket = new Socket();
    const send = mock();
    const written = mock();
    socket.socket = { send };
    socket.write(document, written);
    expect(send).toHaveBeenCalledWith(document);
    expect(send).toHaveBeenCalledTimes(1);
    expect(written).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(written).toHaveBeenCalledTimes(1);
  },
);
