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
const APP = "urn:test:outgoing-error";
const METHODS: ("send" | "sendMany")[] = ["send", "sendMany"];
const KINDS = ["message", "presence", "iq"] as const;
const TYPES = ["auth", "cancel", "continue", "modify", "wait"];
// Independent literal inventory: RFC 6120 §8.3.3, not production constants.
const CONDITIONS = [
  "bad-request",
  "conflict",
  "feature-not-implemented",
  "forbidden",
  "gone",
  "internal-server-error",
  "item-not-found",
  "jid-malformed",
  "not-acceptable",
  "not-allowed",
  "not-authorized",
  "policy-violation",
  "recipient-unavailable",
  "redirect",
  "registration-required",
  "remote-server-not-found",
  "remote-server-timeout",
  "resource-constraint",
  "service-unavailable",
  "subscription-required",
  "undefined-condition",
  "unexpected-request",
];
type Kind = (typeof KINDS)[number];
type Scenario = { name: string; element: (kind: Kind) => Element };

// RFC 6120 §§8.3.1/8.3.2/.3.5/.3.14: outgoing syntax, not extension semantics.
// https://www.rfc-editor.org/rfc/rfc6120.html#section-8.3.1
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
        `<open xmlns="${FRAMING}" from="example.test" id="outgoing-error" version="1.0"/>`,
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
      remote.send(`<enabled xmlns="${SM}" id="error-sm" resume="true"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      root.attributes["{}type"] === "get"
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
  xmpp.on("nonza", (element: Element) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    }
  });
  try {
    await xmpp.start();
    await enabled.promise;
    await xmpp.iqCaller.request(
      xml("iq", { id: "barrier", type: "get" }, xml("ping", PING)),
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

// A foreign nonza is a wire barrier without entering the stanza/SM queue.
async function flushWire(xmpp: ReturnType<typeof client>, peer: ScriptedPeer) {
  await xmpp.send(xml("sync", APP));
  while (true) {
    const root = readFrame(await peer.next())[0];
    if ("open" in root && root.open === `{${APP}}sync`) {
      return;
    }
  }
}

function stanzaFrames(peer: ScriptedPeer, offset: number, kind: Kind) {
  return peer.transcript.slice(offset).filter((frame) => {
    const root = readFrame(frame)[0];
    return "open" in root && root.open === `{${CONTENT}}${kind}`;
  });
}

const malformed: Scenario[] = [
  ...["absent", "ordinary non-error", "alternate non-error"].map(
    (name, index) => ({
      name: `core error with stanza type ${name}`,
      element: (kind: Kind) => {
        const type = {
          message: [undefined, "chat", "headline"],
          presence: [undefined, "unavailable", "subscribe"],
          iq: [undefined, "result", "get"],
        }[kind][index];
        return xml(
          kind,
          { id: "invalid", type },
          xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
        );
      },
    }),
  ),
  {
    name: "error stanza without core error",
    element: (kind) => xml(kind, { id: "invalid", type: "error" }),
  },
  {
    name: "foreign error cannot replace core error",
    element: (kind) =>
      xml(kind, { id: "invalid", type: "error" }, xml("error", APP)),
  },
  {
    name: "nested error cannot replace direct core error",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml(
          "query",
          APP,
          xml(
            "error",
            { xmlns: CONTENT, type: "cancel" },
            xml("forbidden", STANZAS),
          ),
        ),
      ),
  },
  {
    name: "two core errors",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
        xml("error", { type: "wait" }, xml("resource-constraint", STANZAS)),
      ),
  },
  ...[undefined, "", "foo", "Cancel"].map((type) => ({
    name: `error type ${type ?? "absent"}`,
    element: (kind: Kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml("error", { type }, xml("forbidden", STANZAS)),
      ),
  })),
  {
    name: "qualified type cannot replace core error type",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml(
          "error",
          { "xmlns:a": APP, "a:type": "cancel" },
          xml("forbidden", STANZAS),
        ),
      ),
  },
  {
    name: "missing condition",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml("error", { type: "cancel" }),
      ),
  },
  {
    name: "text cannot replace condition",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml("error", { type: "cancel" }, xml("text", STANZAS, "diagnostic")),
      ),
  },
  {
    name: "foreign condition cannot replace standard condition",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml("error", { type: "cancel" }, xml("forbidden", APP)),
      ),
  },
  {
    name: "unregistered standard condition",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml(
          "error",
          { type: "cancel" },
          xml("unregistered-condition", STANZAS),
        ),
      ),
  },
  {
    name: "two registered conditions",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml(
          "error",
          { type: "cancel" },
          xml("forbidden", STANZAS),
          xml("not-authorized", STANZAS),
        ),
      ),
  },
  {
    name: "nested standard condition is not a direct condition",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml(
          "error",
          { type: "cancel" },
          xml("detail", APP, xml("forbidden", STANZAS)),
        ),
      ),
  },
  {
    name: "standard text contains a nested element",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml(
          "error",
          { type: "cancel" },
          xml("forbidden", STANZAS),
          xml("text", STANZAS, "diagnostic", xml("detail", APP)),
        ),
      ),
  },
  ...["", CONTENT, SERVER, STREAM].map((xmlns) => ({
    name: `application condition namespace ${xmlns || "empty"}`,
    element: (kind: Kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml(
          "error",
          { type: "cancel" },
          xml("forbidden", STANZAS),
          xml("detail", { xmlns }),
        ),
      ),
  })),
  ...["", CONTENT].map((xmlns) => ({
    name: `unqualified/core text is not standard text ${xmlns || "empty"}`,
    element: (kind: Kind) =>
      xml(
        kind,
        { id: "invalid", type: "error" },
        xml(
          "error",
          { type: "cancel" },
          xml("forbidden", STANZAS),
          xml("text", { xmlns }, "diagnostic"),
        ),
      ),
  })),
  {
    name: "aliased unregistered condition",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error", "xmlns:s": STANZAS },
        xml("error", { type: "cancel" }, xml("s:unregistered-condition")),
      ),
  },
  {
    name: "rebound condition prefix no longer denotes standard condition",
    element: (kind) =>
      xml(
        kind,
        { id: "invalid", type: "error", "xmlns:s": STANZAS },
        xml("error", { type: "cancel", "xmlns:s": APP }, xml("s:forbidden")),
      ),
  },
];

const invalidAddresses = [
  "not a valid URI %",
  "relative/path",
  "/relative",
  "//example.test/path",
  "1invalid:address",
  "xmpp:user@example.test/%",
  "xmpp:user@example.test/%0",
  "xmpp:user@example.test/%GG",
  "xmpp:user@example.test/path with space",
  "https://[::1",
  "https://[::1]tail/path",
  "https://example.test:abc/path",
  "https://example.test/path\\tail",
  "xmpp:user@example.test#one#two",
  "xmpp:user@example.test/\uE000",
  "https://example.test/path?\uFDD0",
];

for (const condition of ["gone", "redirect"]) {
  malformed.push(
    ...["CDATA invalid URI", "malformed CDATA"].map((name) => ({
      name: `${condition} ${name}`,
      element: (kind: Kind) => {
        const value = xml(kind, { id: "invalid", type: "error" });
        const address =
          name === "CDATA invalid URI"
            ? "<![CDATA[not a URI %]]>"
            : "<![CDATA[xmpp:user@example.test]broken>";
        value.toString = () =>
          `<${kind} xmlns="${CONTENT}" id="invalid" type="error"><error type="cancel"><${condition} xmlns="${STANZAS}">${address}</${condition}></error></${kind}>`;
        return value;
      },
    })),
    ...["by attribute", "earlier application scalar"].map((name) => ({
      name: `${condition} invalidated by ${name} during serialization`,
      element: (kind: Kind) => {
        const address = xml(condition, STANZAS, "xmpp:user@example.test");
        const scalar = {
          toString: () => {
            address.children = ["not a URI %"];
            return "example.test";
          },
        };
        const error =
          name === "by attribute"
            ? new XMLElement("error", { type: "cancel", by: scalar })
            : xml("error", { type: "cancel" }, xml("detail", APP, scalar));
        error.append(address);
        return xml(kind, { id: "invalid", type: "error" }, error);
      },
    })),
    ...invalidAddresses.map((address) => ({
      name: `${condition} invalid absolute URI/IRI ${JSON.stringify(address)}`,
      element: (kind: Kind) =>
        xml(
          kind,
          { id: "invalid", type: "error" },
          xml("error", { type: "cancel" }, xml(condition, STANZAS, address)),
        ),
    })),
    {
      name: `${condition} address contains an element`,
      element: (kind) =>
        xml(
          kind,
          { id: "invalid", type: "error" },
          xml(
            "error",
            { type: "cancel" },
            xml(
              condition,
              STANZAS,
              "xmpp:user@example.test",
              xml("detail", APP),
            ),
          ),
        ),
    },
  );
}

for (const scenario of malformed) {
  for (const kind of KINDS) {
    test.each(METHODS)(
      `RFC 6120 §§8.3.1/8.3.2: %s rejects ${kind} ${scenario.name} before wire/SM`,
      async (method) => {
        const { xmpp, peer, errors } = await session();
        const value = scenario.element(kind);
        const sent: unknown[] = [];
        xmpp.on("send", (element: unknown) => {
          if (element === value) {
            sent.push(element);
          }
        });
        try {
          const before = peer.transcript.length;
          const queued = xmpp.streamManagement.outbound_q.length;
          const outcome = await (
            method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
          ).catch((error: Error) => error);
          await flushWire(xmpp, peer);
          // Both outcomes settle via a real wire barrier, so missing validation is an assertion failure.
          expect(outcome).toBeInstanceOf(TypeError);
          expect(stanzaFrames(peer, before, kind)).toEqual([]);
          expect(sent).toEqual([]);
          expect(xmpp.streamManagement.outbound_q).toHaveLength(queued);
          expect(xmpp.iqCaller.handlers.size).toBe(0);
          const recovery = xml("message", { id: "recovery" });
          const after = peer.transcript.length;
          await xmpp.send(recovery);
          await flushWire(xmpp, peer);
          expect(stanzaFrames(peer, after, "message")).toHaveLength(1);
          expect(xmpp.streamManagement.outbound_q).toHaveLength(queued + 1);
          const queue = xmpp.streamManagement.outbound_q as {
            stanza: unknown;
          }[];
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
}

// §8.3.3 recommends customary types; its opening paragraph permits alternatives.
for (const kind of KINDS) {
  test.each(METHODS)(
    `RFC 6120 §§8.3.2/8.3.3: %s preserves ${kind} all conditions and type alternatives`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      try {
        for (const condition of CONDITIONS) {
          for (const type of TYPES) {
            const id = `${condition}-${type}`;
            const value = xml(
              kind,
              { id, type: "error" },
              xml("error", { type }, xml(condition, STANZAS)),
            );
            const before = peer.transcript.length;
            const queued = xmpp.streamManagement.outbound_q.length;
            await expect(
              method === "send" ? xmpp.send(value) : xmpp.sendMany([value]),
            ).resolves.toBeUndefined();
            await flushWire(xmpp, peer);
            const frames = stanzaFrames(peer, before, kind);
            expect(frames).toHaveLength(1);
            expect(readFrame(frames[0])).toEqual(
              readFrame(
                `<${kind} xmlns="${CONTENT}" id="${id}" type="error"><error type="${type}"><${condition} xmlns="${STANZAS}"/></error></${kind}>`,
              ),
            );
            expect(xmpp.streamManagement.outbound_q).toHaveLength(queued + 1);
            const queue = xmpp.streamManagement.outbound_q as {
              stanza: unknown;
            }[];
            expect(queue.at(-1)?.stanza).toBe(value);
          }
        }
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

const legalAddresses = [
  "",
  "xmpp:user@example.test",
  "XMPP:user@example.test/resource?message;subject=Hi",
  "https://example.test:443/path?one=two#fragment",
  "https://[::1]:443/path",
  "https://[v1.example]:443/",
  "mailto:user@example.test",
  "urn:example:opaque",
  "custom:",
  "custom:/path",
  "custom://",
  "xmpp:user@example.test/%20",
  "xmpp:user@example.test/żółw",
  "https://例え.テスト/道?鍵=値#断片",
  "https://example.test/path?\uE000",
  "custom:/\u{1F642}",
];

for (const condition of ["gone", "redirect"]) {
  for (const kind of KINDS) {
    test.each(METHODS)(
      `RFC 6120 §§8.3.3.5/8.3.3.14: %s preserves ${kind} ${condition} generic URI/IRI alternatives`,
      async (method) => {
        const { xmpp, peer, errors } = await session();
        try {
          for (const [index, address] of legalAddresses.entries()) {
            const id = `${condition}-${index}`;
            const value = xml(
              kind,
              { id, type: "error" },
              xml("error", { type: "wait" }, xml(condition, STANZAS, address)),
            );
            const before = peer.transcript.length;
            const queued = xmpp.streamManagement.outbound_q.length;
            await expect(
              method === "send" ? xmpp.send(value) : xmpp.sendMany([value]),
            ).resolves.toBeUndefined();
            await flushWire(xmpp, peer);
            const frames = stanzaFrames(peer, before, kind);
            expect(frames).toHaveLength(1);
            expect(readFrame(frames[0])).toEqual(
              readFrame(
                `<${kind} xmlns="${CONTENT}" id="${id}" type="error"><error type="wait"><${condition} xmlns="${STANZAS}">${address}</${condition}></error></${kind}>`,
              ),
            );
            expect(xmpp.streamManagement.outbound_q).toHaveLength(queued + 1);
            const queue = xmpp.streamManagement.outbound_q as {
              stanza: unknown;
            }[];
            expect(queue.at(-1)?.stanza).toBe(value);
          }
          expect(errors).toEqual([]);
          expect(peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await peer.stop();
        }
      },
    );
  }
}

const legal: (Scenario & { expected: (kind: Kind) => string })[] = [
  {
    name: "ordinary registered condition permits opaque attributes and markup",
    element: (kind) =>
      xml(
        kind,
        { id: "valid", type: "error" },
        xml(
          "error",
          { type: "wait" },
          xml(
            "forbidden",
            { xmlns: STANZAS, reason: "opaque", "xmlns:a": APP },
            "ordinary data",
            xml("a:detail", {}, xml("conflict", STANZAS)),
          ),
        ),
      ),
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="wait"><forbidden xmlns="${STANZAS}" reason="opaque" xmlns:a="${APP}">ordinary data<a:detail><conflict xmlns="${STANZAS}"/></a:detail></forbidden></error></${kind}>`,
  },
  {
    name: "CDATA is character data in ordinary conditions and diagnostic text",
    element: (kind) => {
      const value = xml(kind, { id: "valid", type: "error" });
      value.toString = () =>
        `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="cancel"><forbidden xmlns="${STANZAS}"><![CDATA[<opaque> & data]]></forbidden><text xmlns="${STANZAS}"><![CDATA[<diagnostic> & żółw]]></text></error></${kind}>`;
      return value;
    },
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="cancel"><forbidden xmlns="${STANZAS}"><![CDATA[<opaque> & data]]></forbidden><text xmlns="${STANZAS}"><![CDATA[<diagnostic> & żółw]]></text></error></${kind}>`,
  },
  {
    name: "CDATA and ordinary text form one generic IRI address",
    element: (kind) => {
      const value = xml(kind, { id: "valid", type: "error" });
      value.toString = () =>
        `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="modify"><gone xmlns="${STANZAS}">custom:<![CDATA[/żółw?key=]]>value<![CDATA[#fragment]]></gone></error></${kind}>`;
      return value;
    },
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="modify"><gone xmlns="${STANZAS}">custom:<![CDATA[/żółw?key=]]>value<![CDATA[#fragment]]></gone></error></${kind}>`,
  },
  {
    name: "condition/text/application prefix aliases and arbitrary extension schema",
    element: (kind) =>
      xml(
        kind,
        { id: "valid", type: "error", "xmlns:s": STANZAS, "xmlns:a": APP },
        xml(
          "error",
          { type: "continue", code: "999" },
          xml("s:undefined-condition", { "a:context": "opaque" }),
          xml("s:text", { "xml:lang": "pl" }, "opis & więcej"),
          xml(
            "a:text",
            { type: "anything" },
            xml("a:nested", {}, "extension data"),
          ),
        ),
      ),
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" xmlns:s="${STANZAS}" xmlns:a="${APP}" id="valid" type="error"><error type="continue" code="999"><s:undefined-condition a:context="opaque"/><s:text xml:lang="pl">opis &amp; więcej</s:text><a:text type="anything"><a:nested>extension data</a:nested></a:text></error></${kind}>`,
  },
  {
    name: "application error-named element and rebound standard prefix",
    element: (kind) =>
      xml(
        kind,
        { id: "valid", type: "error", "xmlns:s": APP },
        xml(
          "error",
          { type: "auth", "xmlns:s": STANZAS },
          xml("s:forbidden"),
          xml("error", APP, xml("text", {}, "application")),
        ),
      ),
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" xmlns:s="${APP}" id="valid" type="error"><error type="auth" xmlns:s="${STANZAS}"><s:forbidden/><error xmlns="${APP}"><text>application</text></error></error></${kind}>`,
  },
  {
    name: "foreign sibling payload can contain nested core error data",
    element: (kind) =>
      xml(
        kind,
        { id: "valid", type: "error" },
        xml("query", APP, xml("error", { xmlns: CONTENT, type: "opaque" })),
        xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
      ),
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" id="valid" type="error"><query xmlns="${APP}"><error xmlns="${CONTENT}" type="opaque"/></query><error type="cancel"><forbidden xmlns="${STANZAS}"/></error></${kind}>`,
  },
  {
    name: "text has optional language and arbitrary character data",
    element: (kind) =>
      xml(
        kind,
        { id: "valid", type: "error" },
        xml(
          "error",
          { type: "cancel" },
          xml("forbidden", STANZAS),
          xml("text", STANZAS, "<diagnostic> & żółw"),
        ),
      ),
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="cancel"><forbidden xmlns="${STANZAS}"/><text xmlns="${STANZAS}">&lt;diagnostic&gt; &amp; żółw</text></error></${kind}>`,
  },
  {
    name: "ESM core error and scalar address use writer character data",
    element: (kind) =>
      xml(
        kind,
        { id: "valid", type: "error" },
        new SourceElement("error", { xmlns: CONTENT, type: "cancel" })
          .c("gone", { xmlns: STANZAS })
          .t({ toString: () => "xmpp:user@example.test" })
          .up()
          .up(),
      ),
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="cancel"><gone xmlns="${STANZAS}">xmpp:user@example.test</gone></error></${kind}>`,
  },
  {
    name: "serialized legal error contents replace invalid tree contents",
    element: (kind) => {
      const value = xml(
        kind,
        { id: "valid", type: "error" },
        xml("error", { type: "foo" }),
      );
      value.toString = () =>
        `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="cancel"><forbidden xmlns="${STANZAS}"/></error></${kind}>`;
      return value;
    },
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="cancel"><forbidden xmlns="${STANZAS}"/></error></${kind}>`,
  },
  {
    name: "late scalar conversion preserves the actual valid address",
    element: (kind) => {
      const address = xml("gone", STANZAS, "xmpp:old@example.test");
      const by = {
        toString: () => {
          address.children = ["xmpp:new@example.test"];
          return "example.test";
        },
      };
      const error = new XMLElement("error", { type: "cancel", by });
      error.append(address);
      return xml(kind, { id: "valid", type: "error" }, error);
    },
    expected: (kind) =>
      `<${kind} xmlns="${CONTENT}" id="valid" type="error"><error type="cancel" by="example.test"><gone xmlns="${STANZAS}">xmpp:new@example.test</gone></error></${kind}>`,
  },
];

for (const scenario of legal) {
  for (const kind of KINDS) {
    test.each(METHODS)(
      `RFC 6120 §8.3.2: %s preserves ${kind} ${scenario.name}`,
      async (method) => {
        const { xmpp, peer, errors } = await session();
        const value = scenario.element(kind);
        const sent: unknown[] = [];
        xmpp.on("send", (element: unknown) => {
          if (element === value) {
            sent.push(element);
          }
        });
        try {
          const before = peer.transcript.length;
          const queued = xmpp.streamManagement.outbound_q.length;
          await expect(
            method === "send" ? xmpp.send(value) : xmpp.sendMany([value]),
          ).resolves.toBeUndefined();
          await flushWire(xmpp, peer);
          const frames = stanzaFrames(peer, before, kind);
          expect(frames).toHaveLength(1);
          expect(readFrame(frames[0])).toEqual(
            readFrame(scenario.expected(kind)),
          );
          expect(sent).toEqual([value]);
          expect(xmpp.streamManagement.outbound_q).toHaveLength(queued + 1);
          const queue = xmpp.streamManagement.outbound_q as {
            stanza: unknown;
          }[];
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
}

for (const kind of KINDS) {
  test.each(METHODS)(
    `RFC 6120 §§8.3.1/8.4: %s preserves ${kind} foreign error-named payload`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      const type = kind === "iq" ? "get" : undefined;
      const value = xml(kind, { id: "barrier", type }, xml("error", APP));
      try {
        const before = peer.transcript.length;
        const queued = xmpp.streamManagement.outbound_q.length;
        await expect(
          method === "send" ? xmpp.send(value) : xmpp.sendMany([value]),
        ).resolves.toBeUndefined();
        await flushWire(xmpp, peer);
        const frames = stanzaFrames(peer, before, kind);
        expect(frames).toHaveLength(1);
        expect(readFrame(frames[0])).toEqual(
          readFrame(
            `<${kind} xmlns="${CONTENT}" id="barrier"${type ? ` type="${type}"` : ""}><error xmlns="${APP}"/></${kind}>`,
          ),
        );
        expect(xmpp.streamManagement.outbound_q).toHaveLength(queued + 1);
        const queue = xmpp.streamManagement.outbound_q as { stanza: unknown }[];
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

for (const kind of KINDS) {
  for (const violation of [
    "invalid type",
    "missing condition",
    "nested text",
    "invalid URI",
    "missing error",
  ] as const) {
    test.each(METHODS)(
      `RFC 6120 §8.3.2: %s rejects ${kind} serialized ${violation}`,
      async (method) => {
        const { xmpp, peer, errors } = await session();
        const value = xml(
          kind,
          { id: "writer", type: "error" },
          xml("error", { type: "cancel" }, xml("forbidden", STANZAS)),
        );
        const body =
          violation === "invalid type"
            ? `<error type="foo"><forbidden xmlns="${STANZAS}"/></error>`
            : violation === "missing condition"
              ? `<error type="cancel"/>`
              : violation === "nested text"
                ? `<error type="cancel"><forbidden xmlns="${STANZAS}"/><text xmlns="${STANZAS}"><detail xmlns="${APP}"/></text></error>`
                : violation === "invalid URI"
                  ? `<error type="cancel"><gone xmlns="${STANZAS}">not a URI %</gone></error>`
                  : "";
        let calls = 0;
        value.toString = () => {
          calls += 1;
          return `<${kind} xmlns="${CONTENT}" id="writer" type="error">${body}</${kind}>`;
        };
        const sent: unknown[] = [];
        xmpp.on("send", (element: unknown) => {
          if (element === value) {
            sent.push(element);
          }
        });
        try {
          const before = peer.transcript.length;
          const queued = xmpp.streamManagement.outbound_q.length;
          const outcome = await (
            method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
          ).catch((error: Error) => error);
          await flushWire(xmpp, peer);
          expect(outcome).toBeInstanceOf(TypeError);
          expect(stanzaFrames(peer, before, kind)).toEqual([]);
          expect(sent).toEqual([]);
          expect(xmpp.streamManagement.outbound_q).toHaveLength(queued);
          expect(calls).toBe(1);
          expect(errors).toEqual([]);
          expect(peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await peer.stop();
        }
      },
    );
  }
}

for (const kind of KINDS) {
  test.each(METHODS)(
    `RFC 6120 §8.3.2: %s writes one validated ${kind} snapshot`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      const value = xml(kind, { id: "snapshot", type: "error" });
      const expected = `<${kind} xmlns="${CONTENT}" id="snapshot" type="error"><error type="cancel"><forbidden xmlns="${STANZAS}"/></error></${kind}>`;
      let calls = 0;
      value.toString = () => {
        calls += 1;
        if (calls === 1) {
          return expected;
        }
        return `<${kind} xmlns="${CONTENT}" id="snapshot" type="error"><error type="foo"/></${kind}>`;
      };
      try {
        const before = peer.transcript.length;
        const queued = xmpp.streamManagement.outbound_q.length;
        await expect(
          method === "send" ? xmpp.send(value) : xmpp.sendMany([value]),
        ).resolves.toBeUndefined();
        await flushWire(xmpp, peer);
        const frames = stanzaFrames(peer, before, kind);
        expect(frames).toHaveLength(1);
        expect(readFrame(frames[0])).toEqual(readFrame(expected));
        expect(calls).toBe(1);
        expect(xmpp.streamManagement.outbound_q).toHaveLength(queued + 1);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
  test(`RFC 6120 §8.3.2: sendMany rejects an invalid ${kind} after an admitted stanza`, async () => {
    const { xmpp, peer, errors } = await session();
    const first = xml("message", { id: "first" });
    const invalid = xml(
      kind,
      { id: "invalid", type: "error" },
      xml("error", { type: "cancel" }),
    );
    const sent: unknown[] = [];
    xmpp.on("send", (value: unknown) => {
      if (value === first || value === invalid) {
        sent.push(value);
      }
    });
    try {
      const before = peer.transcript.length;
      const queued = xmpp.streamManagement.outbound_q.length;
      const outcome = await xmpp
        .sendMany([first, invalid])
        .catch((error: Error) => error);
      await flushWire(xmpp, peer);
      expect(outcome).toBeInstanceOf(TypeError);
      const frames = peer.transcript.slice(before).filter((frame) => {
        const root = readFrame(frame)[0];
        return "open" in root && root.open.startsWith(`{${CONTENT}}`);
      });
      expect(frames.map(readFrame)).toEqual([
        readFrame(`<message xmlns="${CONTENT}" id="first"/>`),
      ]);
      expect(sent).toEqual([first]);
      expect(xmpp.streamManagement.outbound_q).toHaveLength(queued + 1);
      const queue = xmpp.streamManagement.outbound_q as { stanza: unknown }[];
      expect(queue.at(-1)?.stanza).toBe(first);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  });
}

test.each(METHODS)(
  "RFC 6120 §4.8.4: %s preserves foreign stanza-named nonzas",
  async (method) => {
    const { xmpp, peer, errors } = await session();
    try {
      for (const kind of KINDS) {
        const value = new XMLElement(kind, { xmlns: APP, type: "error" });
        value.append(xml("error", { xmlns: CONTENT, type: "foo" }));
        const before = peer.transcript.length;
        const queued = xmpp.streamManagement.outbound_q.length;
        await expect(
          method === "send" ? xmpp.send(value) : xmpp.sendMany([value]),
        ).resolves.toBeUndefined();
        await flushWire(xmpp, peer);
        const frames = peer.transcript.slice(before).filter((frame) => {
          const root = readFrame(frame)[0];
          return "open" in root && root.open === `{${APP}}${kind}`;
        });
        expect(frames).toHaveLength(1);
        expect(readFrame(frames[0])).toEqual(
          readFrame(
            `<${kind} xmlns="${APP}" type="error"><error xmlns="${CONTENT}" type="foo"/></${kind}>`,
          ),
        );
        expect(xmpp.streamManagement.outbound_q).toHaveLength(queued);
      }
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
