import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { Element as XMLElement } from "../src/xml/index.js";
import type { Element } from "../types/index.js";
// @ts-expect-error ltx ships no declarations for its ES module constructor.
import SourceElement from "ltx/src/Element.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const SERVER = "jabber:server";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const SM = "urn:xmpp:sm:3";
const PING = "urn:xmpp:ping";
const FOREIGN = "urn:test:outgoing-iq";
const OTHER = "urn:test:other-payload";
const METHODS: ("send" | "sendMany")[] = ["send", "sendMany"];
const REQUEST_TYPES = ["get", "set"];

// Literal replies settle even malformed requests, so RED evidence is not a timeout.
async function session() {
  const enabled = Promise.withResolvers<void>();
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="outgoing-iq" version="1.0"/>`,
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
      remote.send(`<enabled xmlns="${SM}" id="iq-sm" resume="true"/>`);
    } else if (root.open === `{${CONTENT}}iq`) {
      const id = root.attributes["{}id"];
      if (id !== undefined) {
        const escapedId = id.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
        remote.send(`<iq xmlns="${CONTENT}" type="result" id="${escapedId}"/>`);
      }
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
  xmpp.on("nonza", (element: Element) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    }
  });
  try {
    await xmpp.start();
    await enabled.promise;
    await xmpp.iqCaller.request(
      xml("iq", { id: "barrier", type: "get" }, xml("ping", { xmlns: PING })),
    );
    expect(xmpp.streamManagement.enabled).toBe(true);
    await flushWire(xmpp, peer);
  } catch (error) {
    await xmpp.stop();
    await peer.stop();
    throw error;
  }
  return { xmpp, peer, errors };
}

// A foreign frame proves preceding sends reached the peer without adding a stanza.
async function flushWire(xmpp: ReturnType<typeof client>, peer: ScriptedPeer) {
  await xmpp.send(xml("sync", { xmlns: FOREIGN }));
  while (true) {
    const root = readFrame(await peer.next())[0];
    if ("open" in root && root.open === `{${FOREIGN}}sync`) {
      return;
    }
  }
}

function iqShape(frame: string) {
  const events = readFrame(frame);
  const root = events[0];
  if (!("open" in root)) {
    throw new Error("Expected an element");
  }
  const children: string[] = [];
  let depth = 0;
  for (const event of events) {
    if ("open" in event) {
      depth += 1;
      if (depth === 2) {
        children.push(event.open);
      }
    } else if ("close" in event) {
      depth -= 1;
    }
  }
  return { root: root.open, attributes: root.attributes, children };
}

const malformed = [
  {
    name: "missing id",
    element: () => xml("iq", { type: "get" }, xml("query", FOREIGN)),
  },
  {
    name: "null id",
    element: () => new XMLElement("iq", { id: null, type: "result" }),
  },
  {
    name: "missing type",
    element: () => xml("iq", { id: "invalid" }, xml("query", FOREIGN)),
  },
  { name: "empty type", element: () => xml("iq", { id: "invalid", type: "" }) },
  {
    name: "qualified extension id cannot replace core id",
    element: () =>
      xml(
        "iq",
        { type: "get", "xmlns:a": FOREIGN, "a:id": "invalid" },
        xml("query", FOREIGN),
      ),
  },
  {
    name: "qualified extension type cannot replace core type",
    element: () =>
      xml(
        "iq",
        { id: "invalid", "xmlns:a": FOREIGN, "a:type": "get" },
        xml("query", FOREIGN),
      ),
  },
  {
    name: "unknown type",
    element: () => xml("iq", { id: "invalid", type: "subscribe" }),
  },
  ...REQUEST_TYPES.flatMap((type) => [
    {
      name: `${type} without a child`,
      element: () => xml("iq", { id: "invalid", type }),
    },
    {
      name: `${type} with two direct children`,
      element: () =>
        xml(
          "iq",
          { id: "invalid", type },
          xml("query", FOREIGN),
          xml("other", OTHER),
        ),
    },
    ...["", CONTENT, SERVER, STREAM].map((xmlns) => ({
      name: `${type} payload in ${xmlns || "the empty namespace"}`,
      element: () =>
        xml("iq", { id: "invalid", type }, xml("query", { xmlns })),
    })),
  ]),
  {
    name: "result with two direct children",
    element: () =>
      xml(
        "iq",
        { id: "invalid", type: "result" },
        xml("query", FOREIGN),
        xml("other", OTHER),
      ),
  },
  {
    name: "core error inside result",
    element: () =>
      xml(
        "iq",
        { id: "invalid", type: "result" },
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
      ),
  },
  {
    name: "error without a child",
    element: () => xml("iq", { id: "invalid", type: "error" }),
  },
  {
    name: "error with only a foreign error child",
    element: () =>
      xml("iq", { id: "invalid", type: "error" }, xml("error", FOREIGN)),
  },
  {
    name: "error with two core error children",
    element: () =>
      xml(
        "iq",
        { id: "invalid", type: "error" },
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
      ),
  },
  {
    name: "error with three direct children",
    element: () =>
      xml(
        "iq",
        { id: "invalid", type: "error" },
        xml("query", FOREIGN),
        xml("other", OTHER),
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
      ),
  },
  {
    name: "error hidden below the payload",
    element: () =>
      xml(
        "iq",
        { id: "invalid", type: "error" },
        xml(
          "query",
          FOREIGN,
          xml(
            "error",
            { xmlns: CONTENT, type: "cancel" },
            xml("forbidden", STANZAS),
          ),
        ),
      ),
  },
  {
    name: "ESM second direct child",
    element: () =>
      xml(
        "iq",
        { id: "invalid", type: "get" },
        xml("query", FOREIGN),
        new SourceElement("other", { xmlns: OTHER }),
      ),
  },
  {
    name: "serialized second request child",
    element: () => {
      const value = xml(
        "iq",
        { id: "invalid", type: "get" },
        xml("query", FOREIGN),
      );
      value.toString = () =>
        `<iq xmlns="${CONTENT}" id="invalid" type="get"><query xmlns="${FOREIGN}"/><other xmlns="${OTHER}"/></iq>`;
      return value;
    },
  },
  {
    name: "serialized reserved request namespace",
    element: () => {
      const value = xml(
        "iq",
        { id: "invalid", type: "get" },
        xml("query", FOREIGN),
      );
      value.toString = () =>
        `<iq xmlns="${CONTENT}" id="invalid" type="get"><query/></iq>`;
      return value;
    },
  },
  {
    name: "serialized missing core error",
    element: () => {
      const value = xml(
        "iq",
        { id: "invalid", type: "error" },
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
      );
      value.toString = () =>
        `<iq xmlns="${CONTENT}" id="invalid" type="error"><error xmlns="${FOREIGN}"/></iq>`;
      return value;
    },
  },
];

// RFC 6120 §8.2.3 rules 1/2/5–7, §8.3.1 rule 7, and §8.4.
for (const { name, element } of malformed) {
  test.each(METHODS)(
    `RFC 6120 §§8.2.3/8.4: %s rejects ${name} before wire/SM`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      const value = element();
      const sent: unknown[] = [];
      xmpp.on("send", (stanza: unknown) => {
        if (stanza === value) {
          sent.push(stanza);
        }
      });
      try {
        const before = peer.transcript.length;
        const queued = xmpp.streamManagement.outbound_q.length;
        const outcome = await (
          method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
        ).catch((error: Error) => error);
        await flushWire(xmpp, peer);
        const frames = peer.transcript
          .slice(before)
          .filter((frame) => iqShape(frame).root === `{${CONTENT}}iq`);
        expect(frames).toEqual([]);
        expect(outcome).toBeInstanceOf(TypeError);
        expect(sent).toEqual([]);
        expect(xmpp.streamManagement.outbound_q).toHaveLength(queued);
        expect(xmpp.iqCaller.handlers.size).toBe(0);
        const recovery = xml("message", { id: "recovery" });
        await xmpp.send(recovery);
        await flushWire(xmpp, peer);
        const queue = xmpp.streamManagement.outbound_q as { stanza: unknown }[];
        expect(queue).toHaveLength(queued + 1);
        expect(queue.at(-1)?.stanza).toBe(recovery);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

const legal = [
  ...[0, false].map((value) => ({
    name: `scalar opaque ID ${value}`,
    id: String(value),
    type: "get",
    children: [`{${FOREIGN}}query`],
    element: () => {
      const element = new XMLElement("iq", { id: value, type: "get" });
      element.append(xml("query", FOREIGN));
      return element;
    },
  })),
  {
    name: "opaque whitespace ID",
    id: "   ",
    type: "result",
    children: [],
    element: () => xml("iq", { id: "   ", type: "result" }),
  },
  {
    name: "foreign request payload named error",
    type: "get",
    children: [`{${FOREIGN}}error`],
    element: () =>
      xml("iq", { id: "valid", type: "get" }, xml("error", FOREIGN)),
  },
  {
    name: "single result child without guessing its extension schema",
    type: "result",
    children: [`{${CONTENT}}query`],
    element: () => xml("iq", { id: "valid", type: "result" }, xml("query")),
  },
  {
    name: "foreign error payload and core error",
    type: "error",
    children: [`{${FOREIGN}}error`, `{${CONTENT}}error`],
    element: () =>
      xml(
        "iq",
        { id: "valid", type: "error" },
        xml("error", FOREIGN),
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
      ),
  },
  ...[0, false].map((value) => ({
    name: `scalar foreign payload namespace ${value}`,
    type: "get",
    children: [`{${value}}query`],
    element: () =>
      xml(
        "iq",
        { id: "valid", type: "get" },
        new XMLElement("query", { xmlns: value }),
      ),
  })),
  {
    name: "prefixed foreign IQ-named payload",
    type: "get",
    children: [`{${FOREIGN}}iq`],
    element: () =>
      xml("iq", { id: "valid", type: "get", "xmlns:x": FOREIGN }, xml("x:iq")),
  },
  ...REQUEST_TYPES.map((type) => ({
    name: `${type} with foreign payload`,
    type,
    children: [`{${FOREIGN}}query`],
    element: () => xml("iq", { id: "valid", type }, xml("query", FOREIGN)),
  })),
  {
    name: "empty opaque ID",
    type: "result",
    children: [],
    element: () => xml("iq", { id: "", type: "result" }),
  },
  {
    name: "empty result",
    type: "result",
    children: [],
    element: () => xml("iq", { id: "valid", type: "result" }),
  },
  {
    name: "foreign result payload named error",
    type: "result",
    children: [`{${FOREIGN}}error`],
    element: () =>
      xml("iq", { id: "valid", type: "result" }, xml("error", FOREIGN)),
  },
  {
    name: "one core error",
    type: "error",
    children: [`{${CONTENT}}error`],
    element: () =>
      xml(
        "iq",
        { id: "valid", type: "error" },
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
      ),
  },
  {
    name: "original payload and core error",
    type: "error",
    children: [`{${FOREIGN}}query`, `{${CONTENT}}error`],
    element: () =>
      xml(
        "iq",
        { id: "valid", type: "error" },
        xml("query", FOREIGN),
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
      ),
  },
  {
    name: "prefix inherited from IQ",
    type: "get",
    children: [`{${FOREIGN}}query`],
    element: () =>
      xml(
        "iq",
        { id: "valid", type: "get", "xmlns:q": FOREIGN },
        xml("q:query"),
      ),
  },
  {
    name: "prefix rebound on payload",
    type: "set",
    children: [`{${OTHER}}query`],
    element: () =>
      xml(
        "iq",
        { id: "valid", type: "set", "xmlns:q": CONTENT },
        xml("q:query", { "xmlns:q": OTHER }),
      ),
  },
  {
    name: "nested extension children do not affect direct count",
    type: "get",
    children: [`{${FOREIGN}}query`],
    element: () =>
      xml(
        "iq",
        { id: "valid", type: "get" },
        xml("query", FOREIGN, xml("one", OTHER), xml("two", OTHER)),
      ),
  },
  {
    name: "ESM payload",
    type: "set",
    children: [`{${FOREIGN}}query`],
    element: () =>
      xml(
        "iq",
        { id: "valid", type: "set" },
        new SourceElement("query", { xmlns: FOREIGN }),
      ),
  },
  {
    name: "ESM core error",
    type: "error",
    children: [`{${CONTENT}}error`],
    element: () =>
      xml(
        "iq",
        { id: "valid", type: "error" },
        new SourceElement("error", { xmlns: CONTENT, type: "cancel" })
          .c("forbidden", { xmlns: STANZAS })
          .up(),
      ),
  },
  {
    name: "serialized legal children instead of invalid tree children",
    type: "get",
    children: [`{${FOREIGN}}query`],
    element: () => {
      const value = xml("iq", { id: "valid", type: "get" });
      value.toString = () =>
        `<iq xmlns="${CONTENT}" id="valid" type="get"><q:query xmlns:q="${FOREIGN}"><q:one/><q:two/></q:query></iq>`;
      return value;
    },
  },
];

for (const scenario of legal) {
  const { name, type, children, element } = scenario;
  test.each(METHODS)(
    `RFC 6120 §§8.2.3/8.4: %s preserves ${name}`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      const value = element();
      try {
        const before = peer.transcript.length;
        const queued = xmpp.streamManagement.outbound_q.length;
        await (method === "send" ? xmpp.send(value) : xmpp.sendMany([value]));
        await flushWire(xmpp, peer);
        const frames = peer.transcript
          .slice(before)
          .filter((frame) => iqShape(frame).root === `{${CONTENT}}iq`);
        expect(frames).toHaveLength(1);
        const shape = iqShape(frames[0]);
        expect(shape.attributes["{}id"]).toBe(
          "id" in scenario
            ? scenario.id
            : name === "empty opaque ID"
              ? ""
              : "valid",
        );
        expect(shape.attributes["{}type"]).toBe(type);
        expect(shape.children).toEqual(children);
        const queue = xmpp.streamManagement.outbound_q as { stanza: unknown }[];
        expect(queue).toHaveLength(queued + 1);
        expect(queue.at(-1)?.stanza).toBe(value);
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
  "RFC 6120 §4.8.4: %s leaves foreign IQ-named nonzas outside IQ rules",
  async (method) => {
    const { xmpp, peer, errors } = await session();
    const value = xml(
      "iq",
      { xmlns: FOREIGN },
      xml("one", FOREIGN),
      xml("two", FOREIGN),
    );
    try {
      const before = peer.transcript.length;
      const queued = xmpp.streamManagement.outbound_q.length;
      const outcome = await (
        method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
      ).catch((error: Error) => error);
      expect(outcome).toBe(undefined);
      await flushWire(xmpp, peer);
      const frames = peer.transcript
        .slice(before)
        .filter((frame) => iqShape(frame).root === `{${FOREIGN}}iq`);
      expect(frames).toHaveLength(1);
      expect(iqShape(frames[0]).children).toEqual([
        `{${FOREIGN}}one`,
        `{${FOREIGN}}two`,
      ]);
      expect(xmpp.streamManagement.outbound_q).toHaveLength(queued);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

const invalidRequests = [
  {
    name: "missing type",
    element: () => xml("iq", { id: "caller-invalid" }, xml("query", FOREIGN)),
  },
  {
    name: "empty request",
    element: () => xml("iq", { id: "caller-invalid", type: "get" }),
  },
  {
    name: "two-child request",
    element: () =>
      xml(
        "iq",
        { id: "caller-invalid", type: "set" },
        xml("query", FOREIGN),
        xml("other", OTHER),
      ),
  },
  {
    name: "reserved payload",
    element: () =>
      xml("iq", { id: "caller-invalid", type: "get" }, xml("query", CONTENT)),
  },
];

for (const { name, element } of invalidRequests) {
  test(`RFC 6120 §8.2.3: request rejects ${name} and removes pending state`, async () => {
    const { xmpp, peer, errors } = await session();
    try {
      const before = peer.transcript.length;
      const queued = xmpp.streamManagement.outbound_q.length;
      const outcome = await xmpp.iqCaller
        .request(element())
        .catch((error: Error) => error);
      await flushWire(xmpp, peer);
      expect(
        peer.transcript
          .slice(before)
          .filter((frame) => iqShape(frame).root === `{${CONTENT}}iq`),
      ).toEqual([]);
      expect(outcome).toBeInstanceOf(TypeError);
      expect(xmpp.iqCaller.handlers.size).toBe(0);
      expect(xmpp.streamManagement.outbound_q).toHaveLength(queued);
      const reply = await xmpp.iqCaller.request(
        xml("iq", { id: "caller-invalid", type: "get" }, xml("query", FOREIGN)),
      );
      expect(reply.attrs.id).toBe("caller-invalid");
      expect(xmpp.iqCaller.handlers.size).toBe(0);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  });
}

for (const method of ["get", "set"] as const) {
  test.each(["", CONTENT, SERVER, STREAM])(
    `RFC 6120 §8.4: ${method} rejects payload namespace %s and cleans pending state`,
    async (xmlns) => {
      const { xmpp, peer, errors } = await session();
      try {
        const before = peer.transcript.length;
        const queued = xmpp.streamManagement.outbound_q.length;
        const outcome = await xmpp.iqCaller[method](
          xml("query", { xmlns }),
        ).catch((error: Error) => error);
        await flushWire(xmpp, peer);
        expect(
          peer.transcript
            .slice(before)
            .filter((frame) => iqShape(frame).root === `{${CONTENT}}iq`),
        ).toEqual([]);
        expect(outcome).toBeInstanceOf(TypeError);
        expect(xmpp.iqCaller.handlers.size).toBe(0);
        expect(xmpp.streamManagement.outbound_q).toHaveLength(queued);
        await xmpp.iqCaller[method](xml("query", FOREIGN));
        expect(xmpp.iqCaller.handlers.size).toBe(0);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

test.each([undefined, "", "caller-supplied"])(
  "RFC 6120 §8.2.3: caller uses a valid correlated ID for %s",
  async (id) => {
    const { xmpp, peer, errors } = await session();
    const value = xml("iq", { id, type: "get" }, xml("query", FOREIGN));
    try {
      const before = peer.transcript.length;
      const reply = await xmpp.iqCaller.request(value);
      await flushWire(xmpp, peer);
      const frames = peer.transcript
        .slice(before)
        .filter((frame) => iqShape(frame).root === `{${CONTENT}}iq`);
      expect(frames).toHaveLength(1);
      const shape = iqShape(frames[0]);
      expect(shape.attributes["{}id"]).toBeString();
      expect(shape.attributes["{}id"]).toBe(reply.attrs.id);
      if (id) {
        expect(shape.attributes["{}id"]).toBe(id);
      }
      expect(shape.children).toEqual([`{${FOREIGN}}query`]);
      expect(xmpp.iqCaller.handlers.size).toBe(0);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
