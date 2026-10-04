import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const FOREIGN = "urn:test:outgoing-framing";
const METHODS: ("send" | "sendMany")[] = ["send", "sendMany"];

async function session() {
  let authenticated = false;
  const enabled = Promise.withResolvers<void>();
  const peer = new ScriptedPeer((frame, remote) => {
    // Record invalid caller output verbatim; parse only known negotiation frames.
    if (frame.startsWith("<open ")) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="framing" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (frame.startsWith("<auth ")) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (frame.startsWith("<iq ") && frame.includes(BIND)) {
      const root = readFrame(frame)[0];
      if (!("open" in root)) {
        throw new Error("Expected a binding request");
      }
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (frame.startsWith("<enable ")) {
      remote.send(`<enabled xmlns="${SM}" id="framing-sm" resume="true"/>`);
    } else if (frame.startsWith("<close ")) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("nonza", (element: Element) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    }
  });
  try {
    await xmpp.start();
    await enabled.promise;
    await flushWire(xmpp, peer);
    expect(xmpp.streamManagement.enabled).toBe(true);
    return { xmpp, peer, errors };
  } catch (error) {
    await xmpp.stop();
    await peer.stop();
    throw error;
  }
}

// A later valid frame proves that earlier writes have reached the peer.
async function flushWire(xmpp: ReturnType<typeof client>, peer: ScriptedPeer) {
  await xmpp.send(xml("sync", { xmlns: FOREIGN }));
  while (true) {
    if ((await peer.next()).startsWith("<sync ")) {
      return;
    }
  }
}

// RFC 7395 §3.3.3: the first character of every frame MUST be '<'.
// A BOM is a frame character here, not an external file-encoding marker.
for (const prefix of [" ", "\t", "\n", "\r", "\r\n", "\uFEFF"]) {
  test.each(METHODS)(
    `RFC 7395 §3.3.3: %s rejects serialized leading ${JSON.stringify(prefix)} without writing`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      const value = xml("message", { id: "invalid-framing" });
      value.toString = () =>
        `${prefix}<message xmlns="${CONTENT}" id="invalid-framing"/>`;
      const sent: Element[] = [];
      xmpp.on("send", (element: Element) => sent.push(element));
      try {
        const result = await (
          method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
        ).then(
          () => undefined,
          (error: Error) => error,
        );
        await flushWire(xmpp, peer);
        expect(result).toBeInstanceOf(TypeError);
        expect(
          peer.transcript.some((frame) => frame.includes("invalid-framing")),
        ).toBe(false);
        expect(sent).not.toContain(value);
        expect(xmpp.streamManagement.outbound_q).toHaveLength(0);
        expect(xmpp.status).toBe("online");
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);

        // Reject only the caller frame; the same negotiated stream still works.
        const recovery = xml("message", { id: "framing-recovery" });
        await xmpp.send(recovery);
        await flushWire(xmpp, peer);
        expect(peer.transcript).toContain(
          `<message id="framing-recovery" xmlns="${CONTENT}"/>`,
        );
        expect(sent).toContain(recovery);
        const queue: { stanza: Element }[] = xmpp.streamManagement.outbound_q;
        expect(queue).toHaveLength(1);
        expect(queue[0].stanza).toBe(recovery);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

const validFrames = [
  {
    name: "a core stanza starting with '<'",
    element: () => xml("message", { id: "valid-framing" }),
    source: `<message xmlns="${CONTENT}" id="valid-framing"/>`,
    stanza: true,
  },
  {
    name: "an XML 1.0 declaration without an encoding",
    element: () => xml("message", { id: "valid-framing" }),
    source: `<?xml version="1.0"?><message xmlns="${CONTENT}" id="valid-framing"/>`,
    stanza: true,
  },
  {
    name: "an XML 1.0 declaration explicitly naming UTF-8",
    element: () => xml("message", { id: "valid-framing" }),
    source: `<?xml version="1.0" encoding="UTF-8"?><message xmlns="${CONTENT}" id="valid-framing"/>`,
    stanza: true,
  },
  {
    name: "a foreign prefixed extension document",
    element: () => xml("p:notice", { "xmlns:p": FOREIGN }),
    source: `<p:notice xmlns:p="${FOREIGN}"><p:value>payload</p:value></p:notice>`,
    stanza: false,
  },
  {
    name: "UTF-8 text with Polish, CJK and supplementary characters",
    element: () => xml("message", { id: "valid-framing" }),
    source: `<message xmlns="${CONTENT}" id="valid-framing"><body>Zażółć 汉 🙂</body></message>`,
    stanza: true,
  },
];

// §3.3.3 allows standalone XML documents, including declarations (not recommended).
// Exact raw frames retain declaration, prefix and UTF-8 alternatives, not a format guess.
for (const { name, element, source, stanza } of validFrames) {
  test.each(METHODS)(
    `RFC 7395 §3.3.3: %s preserves ${name}`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      const value = element();
      value.toString = () => source;
      const sent: Element[] = [];
      xmpp.on("send", (outgoing: Element) => sent.push(outgoing));
      try {
        await (method === "send" ? xmpp.send(value) : xmpp.sendMany([value]));
        await flushWire(xmpp, peer);
        expect(peer.transcript.filter((frame) => frame === source)).toEqual([
          source,
        ]);
        expect(sent).toContain(value);
        const queue: { stanza: Element }[] = xmpp.streamManagement.outbound_q;
        expect(queue).toHaveLength(stanza ? 1 : 0);
        if (stanza) {
          expect(queue[0].stanza).toBe(value);
        }
        expect(xmpp.status).toBe("online");
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

// The raw driver path cannot bypass framing checks in send()/sendMany().
test.each(["", " ", "\t", "\n", "\r", "\r\n", "\uFEFF"])(
  "RFC 7395 §3.3.3: raw write rejects a frame beginning with %j",
  async (prefix) => {
    const { xmpp, peer, errors } = await session();
    const source = prefix
      ? `${prefix}<notice xmlns="${FOREIGN}" id="invalid-raw-framing"/>`
      : "";
    const before = peer.transcript.length;
    try {
      const result = await xmpp.write(source).then(
        () => undefined,
        (error: Error) => error,
      );
      await flushWire(xmpp, peer);
      expect(result).toBeInstanceOf(TypeError);
      expect(peer.transcript.slice(before)).not.toContain(source);
      expect(xmpp.streamManagement.outbound_q).toHaveLength(0);
      expect(xmpp.status).toBe("online");
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 7395 §§3.3.3/3.4/3.6: stock open, restart and close frames start with '<'", async () => {
  const { xmpp, peer, errors } = await session();
  try {
    const opens = peer.transcript.filter((frame) => frame.startsWith("<open "));
    expect(opens).toHaveLength(2);
    for (const frame of opens) {
      expect(frame[0]).toBe("<");
      expect(readFrame(frame)[0]).toMatchObject({ open: `{${FRAMING}}open` });
    }
    await xmpp.stop();
    await peer.waitForClose();
    const closes = peer.transcript.filter((frame) => frame.includes("<close "));
    expect(closes).toEqual([`<close xmlns="${FRAMING}"/>`]);
    expect(peer.transcript.every((frame) => frame[0] === "<")).toBe(true);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    if (xmpp.status !== "offline") {
      await xmpp.stop();
    }
    await peer.stop();
  }
});
