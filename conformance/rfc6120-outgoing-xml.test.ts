import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const PING = "urn:xmpp:ping";
const FOREIGN = "urn:test:extension";
const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const METHODS: ("send" | "sendMany")[] = ["send", "sendMany"];
// Existing receive-side policy must not become an outgoing XML grammar limit.
const LARGE_TEXT = "x".repeat(1024 * 1024 + 1);
const DEEP_LEVELS = 65;

async function session() {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    // Keep malformed output as evidence, not an unrelated peer-parser failure.
    if (frame.includes('id="invalid"')) {
      return;
    }
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="xml-output" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CONTENT}}iq` && frame.includes(BIND)) {
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}" id="xml-sm" resume="true"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      root.attributes["{}id"] === "barrier"
    ) {
      remote.send(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
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
  const enabled = new Promise<void>((resolve) => {
    const handler = (element: {
      is(name: string, namespace: string): boolean;
    }) => {
      if (element.is("enabled", SM)) {
        xmpp.off("nonza", handler);
        resolve();
      }
    };
    xmpp.on("nonza", handler);
  });
  try {
    await xmpp.start();
    await enabled;
  } catch (error) {
    await xmpp.stop();
    await peer.stop();
    throw error;
  }
  return { xmpp, peer, errors };
}

// RFC 6120 §§11.3/11.8 require XML 1.0 and namespace well-formed output.
// RFC 7395 §3.3.3 makes each frame independently namespace well-formed.
const malformed = [
  {
    name: "element name contains whitespace",
    element: () => xml("bad name", { id: "invalid" }),
  },
  {
    name: "element name starts with a digit",
    element: () => xml("1notice", { id: "invalid" }),
  },
  {
    name: "attribute name contains whitespace",
    element: () => xml("message", { id: "invalid", "bad name": "value" }),
  },
  {
    name: "attribute name starts with a digit",
    element: () => xml("message", { id: "invalid", "1attribute": "value" }),
  },
  {
    name: "QName has more than one colon",
    element: () => xml("p:a:b", { id: "invalid", "xmlns:p": FOREIGN }),
  },
  {
    name: "QName has an empty local name",
    element: () => xml("p:", { id: "invalid", "xmlns:p": FOREIGN }),
  },
  {
    name: "root prefix is unbound",
    element: () => xml("p:notice", { id: "invalid" }),
  },
  {
    name: "attribute prefix is unbound",
    element: () => xml("message", { id: "invalid", "p:attribute": "value" }),
  },
  {
    name: "descendant prefix is unbound",
    element: () => xml("message", { id: "invalid" }, xml("p:notice")),
  },
  {
    name: "descendant element name is malformed",
    element: () => xml("message", { id: "invalid" }, xml("bad name")),
  },
  {
    name: "descendant attribute name is malformed",
    element: () =>
      xml("message", { id: "invalid" }, xml("body", { "bad name": "value" })),
  },
  {
    name: "two root attributes have the same expanded name",
    element: () =>
      xml("message", {
        id: "invalid",
        "xmlns:p": FOREIGN,
        "xmlns:q": FOREIGN,
        "p:attribute": "first",
        "q:attribute": "second",
      }),
  },
  {
    name: "two descendant attributes inherit the same namespace",
    element: () =>
      xml(
        "message",
        { id: "invalid", "xmlns:p": FOREIGN, "xmlns:q": FOREIGN },
        xml("body", { "p:attribute": "first", "q:attribute": "second" }),
      ),
  },
  {
    name: "reserved xml prefix is rebound",
    element: () => xml("message", { id: "invalid", "xmlns:xml": FOREIGN }),
  },
  {
    name: "reserved xmlns prefix is declared",
    element: () => xml("message", { id: "invalid", "xmlns:xmlns": FOREIGN }),
  },
  {
    name: "XML namespace is bound to a non-xml prefix",
    element: () => xml("message", { id: "invalid", "xmlns:p": XML }),
  },
  {
    name: "XMLNS namespace is used as a content namespace",
    element: () => xml("notice", { id: "invalid", xmlns: XMLNS }),
  },
  {
    name: "descendant undeclares an inherited prefix",
    element: () =>
      xml(
        "message",
        { id: "invalid", "xmlns:p": FOREIGN },
        xml("body", { "xmlns:p": "" }),
      ),
  },
  {
    name: "element name exceeds the XML 1.0 supplementary range",
    element: () => xml("\u{F0000}notice", { id: "invalid" }),
  },
  ...["\u0000", "\u0001", "\u000B", "\uFFFE", "\uFFFF"].flatMap((character) => [
    {
      name: `forbidden U+${character.codePointAt(0)!.toString(16)} in descendant text`,
      element: () =>
        xml("message", { id: "invalid" }, xml("body", {}, character)),
    },
    {
      name: `forbidden U+${character.codePointAt(0)!.toString(16)} in descendant attribute`,
      element: () =>
        xml("message", { id: "invalid" }, xml("body", { value: character })),
    },
  ]),
  ...[
    ["high surrogate before ASCII", "\uD800x"],
    ["high surrogate before NUL", "\uD800\u0000"],
    ["consecutive high surrogates", "\uD800\uD800"],
    ["unpaired low surrogate", "\uDC00"],
  ].flatMap(([name, value]) => [
    {
      name: `${name} in descendant text`,
      element: () => xml("message", { id: "invalid" }, xml("body", {}, value)),
    },
    {
      name: `${name} in descendant attribute`,
      element: () => xml("message", { id: "invalid" }, xml("body", { value })),
    },
  ]),
];

for (const { name, element } of malformed) {
  test.each(METHODS)(
    `RFC 6120 §11.3: %s rejects malformed XML before writing / ${name}`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      const sent: string[] = [];
      xmpp.on("send", (stanza: { attrs: { id?: string } }) => {
        if (stanza.attrs.id) {
          sent.push(stanza.attrs.id);
        }
      });
      try {
        const queue = [...xmpp.streamManagement.outbound_q];
        const pending =
          method === "send" ? xmpp.send(element()) : xmpp.sendMany([element()]);
        const result = await pending.then(
          () => undefined,
          (error: Error) => error,
        );
        expect(result).toBeInstanceOf(TypeError);
        expect(xmpp.streamManagement.outbound_q).toEqual(queue);
        expect(sent).toEqual([]);
        // A valid IQ round trip proves preceding frames reached the wire peer.
        await xmpp.iqCaller.request(
          xml(
            "iq",
            { type: "get", id: "barrier" },
            xml("ping", { xmlns: PING }),
          ),
        );
        expect(
          peer.transcript.some((frame) => frame.includes('id="invalid"')),
        ).toBe(false);
        expect(sent).toEqual(["barrier"]);
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

const valid = [
  {
    name: "valid output exceeds the receive-side byte limit",
    element: () => xml("message", { id: "valid" }, xml("body", {}, LARGE_TEXT)),
    expected: `<message xmlns="${CONTENT}" id="valid"><body>${LARGE_TEXT}</body></message>`,
  },
  {
    name: "valid output exceeds the receive-side depth limit",
    element: () => {
      let nested = xml("leaf", { xmlns: FOREIGN });
      for (let level = 0; level < DEEP_LEVELS; level += 1) {
        nested = xml("container", { xmlns: FOREIGN }, nested);
      }
      return xml("message", { id: "valid" }, nested);
    },
    expected: `<message xmlns="${CONTENT}" id="valid">${`<container xmlns="${FOREIGN}">`.repeat(DEEP_LEVELS)}<leaf xmlns="${FOREIGN}"/>${"</container>".repeat(DEEP_LEVELS)}</message>`,
  },
  {
    name: "Unicode element and attribute names",
    element: () => xml("élève", { xmlns: FOREIGN, id: "valid", 名: "value" }),
    expected: `<élève xmlns="${FOREIGN}" id="valid" 名="value"/>`,
  },
  {
    name: "supplementary XML name boundaries",
    element: () =>
      xml("\u{10000}notice", {
        xmlns: FOREIGN,
        id: "valid",
        "\u{EFFFF}attribute": "value",
      }),
    expected: `<\u{10000}notice xmlns="${FOREIGN}" id="valid" \u{EFFFF}attribute="value"/>`,
  },
  {
    name: "XML 1.0 text, whitespace and supplementary characters",
    element: () =>
      xml(
        "message",
        { id: "valid" },
        xml("body", {}, "\t\n\r\uFDD0\u{10000}\u{10FFFF}"),
      ),
    expected: `<message xmlns="${CONTENT}" id="valid"><body>\t\n\r\uFDD0\u{10000}\u{10FFFF}</body></message>`,
  },
  {
    name: "text and attribute escaping",
    element: () =>
      xml(
        "message",
        { id: "valid" },
        xml("body", { value: "<>&\"'" }, "<>&\"'"),
      ),
    expected: `<message xmlns="${CONTENT}" id="valid"><body value="&lt;&gt;&amp;&quot;&apos;">&lt;&gt;&amp;&quot;&apos;</body></message>`,
  },
  {
    name: "reserved xml prefix bound correctly",
    element: () =>
      xml(
        "message",
        { id: "valid", "xmlns:xml": XML },
        xml("body", { "xml:space": "preserve" }, " spaced "),
      ),
    expected: `<message xmlns="${CONTENT}" id="valid" xmlns:xml="${XML}"><body xml:space="preserve"> spaced </body></message>`,
  },
  {
    name: "same local attribute name in different namespaces",
    element: () =>
      xml("message", {
        id: "valid",
        "xmlns:p": FOREIGN,
        "xmlns:q": "urn:test:other",
        "p:name": "first",
        "q:name": "second",
        name: "third",
      }),
    expected: `<message xmlns="${CONTENT}" id="valid" xmlns:p="${FOREIGN}" xmlns:q="urn:test:other" p:name="first" q:name="second" name="third"/>`,
  },
  {
    name: "prefix rebinding has local scope",
    element: () =>
      xml(
        "message",
        { id: "valid", "xmlns:p": FOREIGN },
        xml("p:first", { "xmlns:p": "urn:test:other" }),
        xml("p:second"),
      ),
    expected: `<message xmlns="${CONTENT}" id="valid" xmlns:p="${FOREIGN}"><p:first xmlns:p="urn:test:other"/><p:second/></message>`,
  },
  {
    name: "descendant default namespace reset",
    element: () =>
      xml(
        "message",
        { id: "valid" },
        xml("container", { xmlns: FOREIGN }, xml("child", { xmlns: "" })),
      ),
    expected: `<message xmlns="${CONTENT}" id="valid"><container xmlns="${FOREIGN}"><child xmlns=""/></container></message>`,
  },
];

for (const { name, element, expected } of valid) {
  test.each(METHODS)(
    `RFC 6120 §§11.3/11.8: %s preserves well-formed XML / ${name}`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      try {
        const pending =
          method === "send" ? xmpp.send(element()) : xmpp.sendMany([element()]);
        const result = await pending.catch((error: Error) => error);
        expect(result).toBeUndefined();
        await xmpp.iqCaller.request(
          xml(
            "iq",
            { type: "get", id: "barrier" },
            xml("ping", { xmlns: PING }),
          ),
        );
        const frames = peer.transcript.filter((frame) =>
          frame.includes('id="valid"'),
        );
        expect(frames).toHaveLength(1);
        expect(readFrame(frames[0])).toEqual(readFrame(expected));
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

test.each(METHODS)(
  "RFC 6120 §11.3: %s writes the exact document validated once",
  async (method) => {
    const { xmpp, peer, errors } = await session();
    const stanza = xml("message", { id: "valid" });
    const expected = `<message xmlns="${CONTENT}" id="valid"><body>first</body></message>`;
    let serializations = 0;
    stanza.toString = () => {
      serializations += 1;
      return serializations === 1
        ? expected
        : expected.replace("first", "second");
    };
    try {
      const result = await (
        method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza])
      ).catch((error: Error) => error);
      expect(result).toBeUndefined();
      expect(serializations).toBe(1);
      await xmpp.iqCaller.request(
        xml("iq", { type: "get", id: "barrier" }, xml("ping", { xmlns: PING })),
      );
      expect(
        peer.transcript.filter((frame) => frame.includes('id="valid"')),
      ).toEqual([expected]);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
