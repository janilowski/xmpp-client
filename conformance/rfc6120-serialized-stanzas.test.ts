import { expect, test } from "bun:test";
import { client, jid, xml } from "../src/client/index.js";
import { Element as XMLElement } from "../src/xml/index.js";
import type { Element } from "../types/index.js";
// @ts-expect-error ltx ships no declarations for its ES module constructor.
import SourceElement from "ltx/src/Element.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const SERVER = "jabber:server";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const FOREIGN = "urn:test:serialized-stanzas";
const METHODS: ("send" | "sendMany")[] = ["send", "sendMany"];

// Literal peer responses keep the wire oracle independent of caller metadata.
async function session(phase: "binding" | "online") {
  const paused = Promise.withResolvers<void>();
  const enabled = Promise.withResolvers<void>();
  let authenticated = false;
  let bindingId: string | undefined;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="serialization" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CONTENT}}iq` && frame.includes(BIND)) {
      bindingId = root.attributes["{}id"];
      if (phase === "binding") {
        paused.resolve();
      } else {
        completeBinding();
      }
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}" id="serialized-sm" resume="true"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });

  function completeBinding() {
    if (bindingId === undefined) {
      throw new Error("No binding request to complete");
    }
    peer.send(
      `<iq xmlns="${CONTENT}" type="result" id="${bindingId}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
    );
  }

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
  const started = xmpp.start().catch((error: Error) => error);
  if (phase === "binding") {
    await paused.promise;
  } else {
    const result = await started;
    if (result instanceof Error) {
      await xmpp.stop();
      await peer.stop();
      throw result;
    }
    await enabled.promise;
  }
  return { xmpp, peer, errors, started, completeBinding };
}

// Receipt of a later frame proves that earlier writes reached the peer.
async function flushWire(xmpp: ReturnType<typeof client>, peer: ScriptedPeer) {
  await xmpp.send(xml("sync", { xmlns: FOREIGN }));
  while (true) {
    const root = readFrame(await peer.next())[0];
    if ("open" in root && root.open === `{${FOREIGN}}sync`) {
      return;
    }
  }
}

// RFC 6120 §4.8.3: the outgoing client content contract applies to wire XML.
test.each(METHODS)(
  "RFC 6120 §4.8.3: %s cannot serialize unsupported server content from a client Element",
  async (method) => {
    const { xmpp, peer, errors } = await session("online");
    const element = xml("message", { id: "serialized" });
    element.toString = () => `<message xmlns="${SERVER}" id="serialized"/>`;
    try {
      const result = await (
        method === "send" ? xmpp.send(element) : xmpp.sendMany([element])
      ).then(
        () => undefined,
        (error: Error) => error,
      );
      await flushWire(xmpp, peer);
      expect(result).toBeInstanceOf(TypeError);
      expect(
        peer.transcript.some((frame) => frame.includes('id="serialized"')),
      ).toBe(false);
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

const validSerializers: {
  name: string;
  element: () => Element;
  source: string;
  stanza: boolean;
}[] = [
  {
    name: "consistent custom serializer",
    element: () => {
      const element = xml("message", { id: "custom" });
      element.toString = () =>
        `<message xmlns="${CONTENT}" id="custom"><body>payload</body></message>`;
      return element;
    },
    source: `<message xmlns="${CONTENT}" id="custom"><body>payload</body></message>`,
    stanza: true,
  },
  {
    name: "foreign root switches from default namespace to a prefix",
    element: () => {
      const element = xml("notice", { xmlns: FOREIGN });
      element.toString = () => `<p:notice xmlns:p="${FOREIGN}"/>`;
      return element;
    },
    source: `<p:notice xmlns:p="${FOREIGN}"/>`,
    stanza: false,
  },
  {
    name: "foreign root uses an equivalent prefix alias",
    element: () => {
      const element = xml("a:notice", { "xmlns:a": FOREIGN });
      element.toString = () => `<b:notice xmlns:b="${FOREIGN}"/>`;
      return element;
    },
    source: `<b:notice xmlns:b="${FOREIGN}"/>`,
    stanza: false,
  },
  {
    name: "numeric ID and JID-valued addresses",
    element: () =>
      xml("message", {
        id: 123,
        type: "normal",
        to: jid("Recipient@REMOTE.TEST/r"),
        from: jid("User@EXAMPLE.TEST/r"),
      }),
    source: `<message xmlns="${CONTENT}" id="123" type="normal" to="recipient@remote.test/r" from="user@example.test/r"/>`,
    stanza: true,
  },
  {
    name: "boolean ID",
    element: () => xml("message", { id: true }),
    source: `<message xmlns="${CONTENT}" id="true"/>`,
    stanza: true,
  },
  {
    name: "empty ID and omitted null or undefined attributes",
    element: () =>
      xml("message", { id: "", type: undefined, to: null, from: undefined }),
    source: `<message xmlns="${CONTENT}" id=""/>`,
    stanza: true,
  },
  {
    name: "CJS Element with scalar, JID, null and undefined attributes",
    element: () =>
      new XMLElement("message", {
        id: 123,
        type: undefined,
        to: jid("Recipient@REMOTE.TEST/r"),
        from: null,
      }),
    source: `<message xmlns="${CONTENT}" id="123" to="recipient@remote.test/r"/>`,
    stanza: true,
  },
  {
    name: "ESM Element with scalar, JID, null and undefined attributes",
    element: () =>
      new SourceElement("message", {
        id: true,
        type: undefined,
        to: jid("Recipient@REMOTE.TEST/r"),
        from: null,
      }),
    source: `<message xmlns="${CONTENT}" id="true" to="recipient@remote.test/r"/>`,
    stanza: true,
  },
  ...["CJS", "ESM"].flatMap((constructor) =>
    [0, false, 123, true].flatMap((namespace) =>
      ["default", "prefix"].map((binding) => ({
        name: `${constructor} Element with scalar ${binding} namespace ${namespace}`,
        element: () => {
          const name = binding === "prefix" ? "p:notice" : "notice";
          const attributes = {
            [binding === "prefix" ? "xmlns:p" : "xmlns"]: namespace,
          };
          return constructor === "CJS"
            ? new XMLElement(name, attributes)
            : new SourceElement(name, attributes);
        },
        source:
          binding === "prefix"
            ? `<p:notice xmlns:p="${namespace}" xmlns="${CONTENT}"/>`
            : `<notice xmlns="${namespace}"/>`,
        stanza: false,
      })),
    ),
  ),
  {
    name: "character references preserve the decoded ID",
    element: () => {
      const element = xml("message", { id: 'id&"<>' });
      element.toString = () =>
        `<message xmlns="${CONTENT}" id="id&#x26;&#34;&#x3c;&gt;"/>`;
      return element;
    },
    source: `<message xmlns="${CONTENT}" id="id&amp;&quot;&lt;&gt;"/>`,
    stanza: true,
  },
  {
    name: "character references preserve ID whitespace",
    element: () => {
      const element = xml("message", { id: "a\tb\nc\rd" });
      element.toString = () =>
        `<message xmlns="${CONTENT}" id="a&#x9;b&#xA;c&#xD;d"/>`;
      return element;
    },
    source: `<message xmlns="${CONTENT}" id="a&#x9;b&#xA;c&#xD;d"/>`,
    stanza: true,
  },
  ...["\t", "\n", "\r", "\r\n"].map((whitespace) => ({
    name: `stock serializer preserves ID ${JSON.stringify(whitespace)}`,
    element: () => xml("message", { id: `before${whitespace}after` }),
    source: `<message xmlns="${CONTENT}" id="before${[...whitespace].map((character) => `&#${character.charCodeAt(0)};`).join("")}after"/>`,
    stanza: true,
  })),
];

// XML 1.0 §§2.11/3.3.3: character references retain attribute whitespace.
// RFC 6120 §8.1.3 IDs are opaque; serialization must not change their value.
for (const { name, element, source, stanza } of validSerializers) {
  test.each(METHODS)(
    `RFC 6120 §§4.8/8.1.3: %s preserves a valid serializer and original Element / ${name}`,
    async (method) => {
      const { xmpp, peer, errors } = await session("online");
      const value = element();
      const sent: Element[] = [];
      xmpp.on("send", (outgoing: Element) => sent.push(outgoing));
      try {
        const result = await (
          method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
        ).then(
          () => undefined,
          (error: Error) => error,
        );
        expect(result).toBeUndefined();
        expect(sent).toEqual([value]);
        await flushWire(xmpp, peer);
        expect(peer.transcript.map(readFrame)).toContainEqual(
          readFrame(source),
        );
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

// RFC 6120 §4.3.5: caller metadata cannot conceal a remote wire destination.
for (const to of [undefined, "example.test"]) {
  test.each(METHODS)(
    `RFC 6120 §4.3.5: %s checks the serialized destination during binding / tree to=${to}`,
    async (method) => {
      const { xmpp, peer, errors, started, completeBinding } =
        await session("binding");
      const element = xml("message", { to, id: "serialized" });
      element.toString = () =>
        `<message xmlns="${CONTENT}" to="recipient@remote.test" id="serialized"/>`;
      try {
        expect(xmpp.status).toBe("open");
        const result = await (
          method === "send" ? xmpp.send(element) : xmpp.sendMany([element])
        ).then(
          () => undefined,
          (error: Error) => error,
        );
        await flushWire(xmpp, peer);
        expect(result).toBeInstanceOf(Error);
        expect(
          peer.transcript.some((frame) => frame.includes('id="serialized"')),
        ).toBe(false);
        expect(xmpp.streamManagement.outbound_q).toHaveLength(0);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        completeBinding();
        await started;
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

const queueCases = [
  {
    name: "core tree serializes a foreign nonza",
    namespace: CONTENT,
    id: "serialized",
    source: `<message xmlns="${FOREIGN}" id="serialized"/>`,
    expected: [],
  },
  {
    name: "foreign tree serializes a core stanza",
    namespace: FOREIGN,
    id: "serialized",
    source: `<message xmlns="${CONTENT}" id="serialized"/>`,
    expected: [
      { namespace: CONTENT, name: "message", id: "serialized", to: undefined },
    ],
  },
  {
    name: "core tree differs from the wire ID and destination",
    namespace: CONTENT,
    id: "tree-id",
    source: `<message xmlns="${CONTENT}" id="serialized" to="recipient@remote.test"/>`,
    expected: [
      {
        namespace: CONTENT,
        name: "message",
        id: "serialized",
        to: "recipient@remote.test",
      },
    ],
  },
];

const inconsistentEnvelopes = [
  {
    name: "root name",
    attributes: {},
    source: `<presence xmlns="${CONTENT}" id="serialized"/>`,
  },
  {
    name: "stanza type",
    attributes: { type: "normal" },
    source: `<message xmlns="${CONTENT}" id="serialized" type="chat"/>`,
  },
  {
    name: "sender",
    attributes: { from: "user@example.test/r" },
    source: `<message xmlns="${CONTENT}" id="serialized" from="another@example.test/r"/>`,
  },
];

const mutatingSerializers: {
  name: string;
  phase: "binding" | "online";
  element: () => Element;
}[] = [
  {
    name: "prefixed core tree serializes an unprefixed remote stanza",
    phase: "binding",
    element: () => {
      const element = xml("p:message", {
        "xmlns:p": CONTENT,
        id: "serialized",
        to: "recipient@remote.test",
      });
      element.toString = () =>
        `<message xmlns="${CONTENT}" id="serialized" to="recipient@remote.test"/>`;
      return element;
    },
  },
  {
    name: "tree core name becomes prefixed while wire stays unprefixed",
    phase: "online",
    element: () => {
      const element = xml("message", { id: "serialized" });
      element.toString = () => {
        element.name = "p:message";
        element.attrs["xmlns:p"] = CONTENT;
        return `<message xmlns="${CONTENT}" id="serialized"/>`;
      };
      return element;
    },
  },
  {
    name: "namespace changes to server in both tree and wire",
    phase: "online",
    element: () => {
      const element = xml("message", { id: "serialized" });
      element.toString = () => {
        element.attrs.xmlns = SERVER;
        return `<message xmlns="${SERVER}" id="serialized"/>`;
      };
      return element;
    },
  },
  {
    name: "destination changes to a remote peer in both tree and wire",
    phase: "binding",
    element: () => {
      const element = xml("message", { id: "serialized", to: "example.test" });
      element.toString = () => {
        element.attrs.to = "recipient@remote.test";
        return `<message xmlns="${CONTENT}" id="serialized" to="recipient@remote.test"/>`;
      };
      return element;
    },
  },
  {
    name: "foreign nonza becomes a remote core stanza during binding",
    phase: "binding",
    element: () => {
      const element = xml("message", { xmlns: FOREIGN, id: "serialized" });
      element.toString = () => {
        element.attrs.xmlns = CONTENT;
        element.attrs.to = "recipient@remote.test";
        return `<message xmlns="${CONTENT}" id="serialized" to="recipient@remote.test"/>`;
      };
      return element;
    },
  },
  {
    name: "core stanza becomes a foreign nonza in both tree and wire",
    phase: "online",
    element: () => {
      const element = xml("message", { id: "serialized" });
      element.toString = () => {
        element.attrs.xmlns = FOREIGN;
        return `<message xmlns="${FOREIGN}" id="serialized"/>`;
      };
      return element;
    },
  },
  {
    name: "tree becomes foreign while wire keeps the original core stanza",
    phase: "online",
    element: () => {
      const element = xml("message", { id: "serialized" });
      element.toString = () => {
        element.attrs.xmlns = FOREIGN;
        return `<message xmlns="${CONTENT}" id="serialized"/>`;
      };
      return element;
    },
  },
  {
    name: "tree ID changes while wire keeps the original stanza ID",
    phase: "online",
    element: () => {
      const element = xml("message", { id: "serialized" });
      element.toString = () => {
        element.attrs.id = "changed-after-preflight";
        return `<message xmlns="${CONTENT}" id="serialized"/>`;
      };
      return element;
    },
  },
];

// Serialize after preflight, but reject changes to the validated envelope.
// Both its original and live values matter for send-event/SM metadata.
for (const { name, phase, element } of mutatingSerializers) {
  test.each(METHODS)(
    `RFC 6120 §§4.3.5/4.8.3/8: %s rejects serializer side effects / ${name}`,
    async (method) => {
      const { xmpp, peer, errors, started, completeBinding } =
        await session(phase);
      const sent: Element[] = [];
      xmpp.on("send", (value: Element) => {
        if (
          value.attrs.id?.includes("serialized") ||
          value.attrs.id?.includes("changed-after")
        ) {
          sent.push(value);
        }
      });
      try {
        const value = element();
        const result = await (
          method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
        ).then(
          () => undefined,
          (error: Error) => error,
        );
        await flushWire(xmpp, peer);
        expect(result).toBeInstanceOf(TypeError);
        expect(
          peer.transcript.some((frame) => frame.includes('id="serialized"')),
        ).toBe(false);
        expect(sent).toEqual([]);
        expect(xmpp.streamManagement.outbound_q).toHaveLength(0);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        if (phase === "binding") {
          completeBinding();
        }
        await started;
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

// Local policy keeps wire, send-event and replay metadata consistent.
for (const { name, attributes, source } of inconsistentEnvelopes) {
  test.each(METHODS)(
    `RFC 6120 §8: %s rejects a serializer that changes the stanza ${name}`,
    async (method) => {
      const { xmpp, peer, errors } = await session("online");
      const element = xml("message", { id: "serialized", ...attributes });
      element.toString = () => source;
      try {
        const result = await (
          method === "send" ? xmpp.send(element) : xmpp.sendMany([element])
        ).then(
          () => undefined,
          (error: Error) => error,
        );
        await flushWire(xmpp, peer);
        expect(result).toBeInstanceOf(TypeError);
        expect(
          peer.transcript.some((frame) => frame.includes('id="serialized"')),
        ).toBe(false);
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
}

// XEP-0198 §§1/4: only serialized core stanzas enter the replay/ack queue.
// A local rejection is permitted; accepting inconsistent queue metadata is not.
for (const entry of queueCases) {
  test.each(METHODS)(
    `RFC 6120 §8 / XEP-0198 §4: %s queues the actual serialized stanza / ${entry.name}`,
    async (method) => {
      const { xmpp, peer, errors } = await session("online");
      const element = xml("message", {
        xmlns: entry.namespace,
        id: entry.id,
        to: "example.test",
      });
      element.toString = () => entry.source;
      try {
        expect(xmpp.streamManagement.outbound_q).toHaveLength(0);
        const result = await (
          method === "send" ? xmpp.send(element) : xmpp.sendMany([element])
        ).then(
          () => undefined,
          (error: Error) => error,
        );
        await flushWire(xmpp, peer);
        const written = peer.transcript.filter((frame) =>
          frame.includes('id="serialized"'),
        );
        if (result === undefined) {
          expect(written.map(readFrame)).toEqual([readFrame(entry.source)]);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(written).toEqual([]);
        }
        expect(
          xmpp.streamManagement.outbound_q.map(
            ({ stanza }: { stanza: Element }) => {
              const attributes: Partial<Element["attrs"]> = stanza.attrs;
              return {
                namespace: stanza.getNS(),
                name: stanza.name,
                id: attributes.id,
                to: attributes.to,
              };
            },
          ),
        ).toEqual(result === undefined ? entry.expected : []);
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

// A normal ESM ltx Element has no root metadata/serialization discrepancy.
test.each(METHODS)(
  "RFC 6120 §8 / XEP-0198 §4: %s accepts a consistent external ESM Element",
  async (method) => {
    const { xmpp, peer, errors } = await session("online");
    const element = new SourceElement("message", {
      xmlns: CONTENT,
      id: "serialized",
      to: "recipient@remote.test",
    });
    try {
      await (method === "send" ? xmpp.send(element) : xmpp.sendMany([element]));
      await flushWire(xmpp, peer);
      expect(
        peer.transcript
          .filter((frame) => frame.includes('id="serialized"'))
          .map(readFrame),
      ).toEqual([
        readFrame(
          `<message xmlns="${CONTENT}" id="serialized" to="recipient@remote.test"/>`,
        ),
      ]);
      const queue: { stanza: Element }[] = xmpp.streamManagement.outbound_q;
      expect(queue).toHaveLength(1);
      expect(queue[0].stanza.attrs.id).toBe("serialized");
      expect(xmpp.status).toBe("online");
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
