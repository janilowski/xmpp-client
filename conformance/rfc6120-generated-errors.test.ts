import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { Element as XMLElement } from "../src/xml/index.js";
import { jid } from "../src/jid/index.js";
// @ts-expect-error ltx ships no declarations for its ES module constructor.
import SourceElement from "ltx/src/Element.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const SERVER = "jabber:server";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const QUERY = "urn:test:generated-errors";
const DETAIL = "urn:test:error-detail";
const REQUEST_TYPES: ("get" | "set")[] = ["get", "set"];
const ERROR_TYPES = ["auth", "cancel", "continue", "modify", "wait"];
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
const PAYLOAD = `<query xmlns="${QUERY}"><value>original &amp; payload</value></query>`;
const FALLBACK = `<error type="cancel"><internal-server-error xmlns="${STANZAS}"/></error>`;
type WritableElement = Element & {
  write(writer: (chunk: string) => void): void;
};

test("XML oracle compares CDATA with equivalent escaped character data", () => {
  expect(
    readFrame(`<value xmlns="${DETAIL}">one<![CDATA[<&>]]>two</value>`),
  ).toEqual(readFrame(`<value xmlns="${DETAIL}">one&lt;&amp;&gt;two</value>`));
});

const serializedErrors = [
  {
    name: "missing error type",
    source: `<error><forbidden xmlns="${STANZAS}"/></error>`,
  },
  {
    name: "unregistered error type",
    source: `<error type="invalid"><forbidden xmlns="${STANZAS}"/></error>`,
  },
  {
    name: "unregistered standard condition",
    source: `<error type="cancel"><unknown xmlns="${STANZAS}"/></error>`,
  },
  { name: "missing standard condition", source: `<error type="cancel"/>` },
  {
    name: "two standard conditions",
    source: `<error type="cancel"><forbidden xmlns="${STANZAS}"/><conflict xmlns="${STANZAS}"/></error>`,
  },
  {
    name: "cleared error namespace",
    source: `<error xmlns="" type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
  },
  {
    name: "foreign error namespace",
    source: `<error xmlns="${DETAIL}" type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
  },
  {
    name: "rebound condition prefix",
    source: `<error xmlns:e="${STANZAS}" type="cancel"><e:forbidden xmlns:e="${DETAIL}"/></error>`,
  },
  {
    name: "reserved application namespace",
    source: `<error type="cancel"><forbidden xmlns="${STANZAS}"/><detail xmlns="${STREAM}"/></error>`,
  },
  {
    name: "diagnostic markup",
    source: `<error type="cancel"><forbidden xmlns="${STANZAS}"/><text xmlns="${STANZAS}"><value xmlns="${DETAIL}"/></text></error>`,
  },
  {
    name: "URI markup",
    source: `<error type="modify"><gone xmlns="${STANZAS}"><value xmlns="${DETAIL}"/></gone></error>`,
  },
  {
    name: "CDATA invalid URI",
    source: `<error type="modify"><gone xmlns="${STANZAS}"><![CDATA[bad %]]></gone></error>`,
  },
  {
    name: "split CDATA invalid URI",
    source: `<error type="modify"><redirect xmlns="${STANZAS}">xmpp:user<![CDATA[%GG]]>@example.test</redirect></error>`,
  },
  {
    name: "extra root",
    source: `<error type="cancel"><forbidden xmlns="${STANZAS}"/></error><error type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
  },
  {
    name: "valid prefixed condition and application",
    source: `<error xmlns:e="${STANZAS}" xmlns:d="${DETAIL}" type="cancel"><e:forbidden/><d:detail><d:value>one</d:value></d:detail><e:text>detail</e:text></error>`,
    valid: true,
  },
  {
    name: "valid inherited namespace",
    source: `<error xmlns="${CONTENT}" xmlns:e="${STANZAS}" type="modify"><e:gone>xmpp:new@example.test</e:gone></error>`,
    valid: true,
  },
  {
    name: "valid CDATA URI",
    source: `<error type="modify"><gone xmlns="${STANZAS}"><![CDATA[xmpp:new@example.test]]></gone></error>`,
    valid: true,
  },
  {
    name: "valid split CDATA URI",
    source: `<error type="modify"><redirect xmlns="${STANZAS}">xmpp:new<![CDATA[@example.test]]></redirect></error>`,
    valid: true,
  },
  {
    name: "valid CDATA diagnostic",
    source: `<error type="cancel"><forbidden xmlns="${STANZAS}"/><text xmlns="${STANZAS}">one<![CDATA[<&>]]>two</text></error>`,
    valid: true,
  },
  {
    name: "ordinary condition character data",
    source: `<error type="cancel"><forbidden xmlns="${STANZAS}" detail="extra">detail</forbidden></error>`,
    valid: true,
  },
  {
    name: "ordinary condition child content",
    source: `<error type="cancel"><forbidden xmlns="${STANZAS}"><value xmlns="${DETAIL}">detail</value></forbidden></error>`,
    valid: true,
  },
];
for (const { name, source, valid } of serializedErrors) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.2: generated %s checks serialized ${name}`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const error = xml(
          "error",
          { type: "cancel" },
          xml("forbidden", STANZAS),
        );
        let writes = 0;
        error.write = (writer: (chunk: string) => void) => {
          writes += 1;
          writer(source);
        };
        xmpp.iqCallee[type](QUERY, "query", () => error);
        peer.send(
          `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}">${PAYLOAD}</iq>`,
        );
        // An explicit valid ID is the response barrier if the invalid reply is lost.
        peer.send(
          `<iq xmlns="${CONTENT}" type="get" id="barrier"><ping xmlns="urn:xmpp:ping"/></iq>`,
        );
        expect(readFrame(await peer.next())).toEqual(
          expectedReply("error", PAYLOAD + (valid ? source : FALLBACK)),
        );
        expect(readFrame(await peer.next())).toEqual(
          readFrame(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`),
        );
        expect(writes).toBe(1);
        expect(errors).toHaveLength(valid ? 0 : 1);
      });
    },
  );
}

// The normative prose does not require every ordinary condition to be empty.
for (const content of ["text", "child"]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.2: generated %s preserves ordinary condition ${content} content`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const condition = xml(
          "forbidden",
          { xmlns: STANZAS, detail: "extra" },
          content === "text" ? "detail" : xml("value", DETAIL, "detail"),
        );
        xmpp.iqCallee[type](QUERY, "query", () =>
          xml("error", { type: "cancel" }, condition),
        );
        const source =
          content === "text"
            ? "detail"
            : `<value xmlns="${DETAIL}">detail</value>`;
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "error",
            `${PAYLOAD}<error type="cancel"><forbidden xmlns="${STANZAS}" detail="extra">${source}</forbidden></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

// RFC 6120 §§8.3.2/.3: validate the bytes emitted by callbacks, not an earlier tree.
for (const condition of ["gone", "redirect"]) {
  for (const conversion of ["by JID", "application scalar"]) {
    for (const address of ["bad %", "xmpp:new@example.test"]) {
      test.each(REQUEST_TYPES)(
        `RFC 6120 §8.3.3: generated %s ${condition} checks late ${conversion} replacement ${address}`,
        async (type) => {
          await session(async (xmpp, peer, errors) => {
            const destination = xml(
              condition,
              STANZAS,
              "xmpp:old@example.test",
            );
            const error = xml("error", { type: "modify" }, destination);
            let calls = 0;
            const convert = () => {
              calls += 1;
              destination.children = [address];
              return "user@example.test/r";
            };
            if (conversion === "by JID") {
              const by = jid("user@example.test/r");
              by.toString = convert;
              error.attrs.by = by;
            } else {
              error.children.unshift(
                xml("detail", DETAIL, { toString: convert }),
              );
            }
            xmpp.iqCallee[type](QUERY, "query", () => error);
            const detail =
              conversion === "by JID" ? ` by="user@example.test/r"` : "";
            const content =
              conversion === "application scalar"
                ? `<detail xmlns="${DETAIL}">user@example.test/r</detail>`
                : "";
            expect(await exchange(peer, type)).toEqual(
              expectedReply(
                "error",
                address === "bad %"
                  ? PAYLOAD + FALLBACK
                  : `${PAYLOAD}<error type="modify"${detail}>${content}<${condition} xmlns="${STANZAS}">${address}</${condition}></error>`,
              ),
            );
            expect(calls).toBe(1);
            expect(errors).toHaveLength(address === "bad %" ? 1 : 0);
          });
        },
      );
    }
  }
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.3: generated %s ${condition} survives original query writer mutation`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const destination = xml(condition, STANZAS, "xmpp:new@example.test");
        const error = xml("error", { type: "modify" }, destination);
        let observed: Element | undefined;
        xmpp.on("send", (stanza: Element) => {
          if (stanza.attrs.id === "generated") {
            observed = stanza.getChild("error", CONTENT);
          }
        });
        let writes = 0;
        xmpp.iqCallee[type](
          QUERY,
          "query",
          (ctx: { element: WritableElement }) => {
            const originalWrite = ctx.element.write.bind(ctx.element);
            ctx.element.write = (writer) => {
              writes += 1;
              destination.children = ["bad %"];
              originalWrite(writer);
            };
            return error;
          },
        );
        // The public send guard can reject a corrupted replay; that is an exact failure too.
        const unexpected = Promise.withResolvers<Error>();
        xmpp.once("error", unexpected.resolve);
        expect(
          await Promise.race([exchange(peer, type), unexpected.promise]),
        ).toEqual(
          expectedReply(
            "error",
            `${PAYLOAD}<error type="modify"><${condition} xmlns="${STANZAS}">xmpp:new@example.test</${condition}></error>`,
          ),
        );
        expect(observed?.getChild(condition, STANZAS)?.getText()).toBe(
          "xmpp:new@example.test",
        );
        expect(destination.getText()).toBe("bad %");
        expect(Object.keys(observed ?? {})).not.toContain("write");
        expect(writes).toBe(1);
        expect(errors).toEqual([]);
      });
    },
  );
  for (const address of ["bad %", "xmpp:new@example.test"]) {
    test.each(REQUEST_TYPES)(
      `RFC 6120 §8.3.3: generated %s ${condition} checks actual custom write ${address}`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          const error = xml(
            "error",
            { type: "modify" },
            xml(condition, STANZAS, "xmpp:tree@example.test"),
          );
          let writes = 0;
          let strings = 0;
          error.write = (writer: (chunk: string) => void) => {
            writes += 1;
            writer(
              `<error type="modify"><${condition} xmlns="${STANZAS}">${address}</${condition}></error>`,
            );
          };
          error.toString = () => {
            strings += 1;
            return `<error type="modify"><${condition} xmlns="${STANZAS}">xmpp:lie@example.test</${condition}></error>`;
          };
          xmpp.iqCallee[type](QUERY, "query", () => error);
          expect(await exchange(peer, type)).toEqual(
            expectedReply(
              "error",
              address === "bad %"
                ? PAYLOAD + FALLBACK
                : `${PAYLOAD}<error type="modify"><${condition} xmlns="${STANZAS}">${address}</${condition}></error>`,
            ),
          );
          expect(writes).toBe(1);
          expect(strings).toBe(0);
          expect(errors).toHaveLength(address === "bad %" ? 1 : 0);
        });
      },
    );
  }
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §8.3.2: generated %s send observers see the captured writer tree",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      const source = `<error xmlns:e="${STANZAS}" type="wait" by="example.test"><e:redirect><![CDATA[xmpp:new@example.test]]></e:redirect><e:text>one<![CDATA[<&>]]>two</e:text><detail xmlns="${DETAIL}"><value>extra</value></detail></error>`;
      const error = xml(
        "error",
        { type: "modify" },
        xml("gone", STANZAS, "xmpp:tree@example.test"),
      );
      let writes = 0;
      error.write = (writer: (chunk: string) => void) => {
        writes += 1;
        writer(source);
      };
      let observed: Element | undefined;
      xmpp.on("send", (stanza: Element) => {
        if (stanza.attrs.id === "generated") {
          observed = stanza.getChild("error", CONTENT);
        }
      });
      xmpp.iqCallee[type](QUERY, "query", () => error);
      expect(await exchange(peer, type)).toEqual(
        expectedReply("error", PAYLOAD + source),
      );
      expect(observed).not.toBe(error);
      expect(observed?.attrs.type).toBe("wait");
      expect(observed?.attrs.by).toBe("example.test");
      expect(observed?.getChild("redirect", STANZAS)?.getText()).toBe(
        "xmpp:new@example.test",
      );
      expect(observed?.getChild("text", STANZAS)?.getText()).toBe("one<&>two");
      expect(
        observed?.getChild("detail", DETAIL)?.getChildText("value", DETAIL),
      ).toBe("extra");
      expect(observed?.getChild("gone", STANZAS)).toBeUndefined();
      expect(Object.keys(observed ?? {})).not.toContain("write");
      expect(writes).toBe(1);
      expect(errors).toEqual([]);
    });
  },
);

// The peer supplies literal authentication/binding replies, independently of handlers.
async function session(
  exercise: (
    xmpp: ReturnType<typeof client>,
    peer: ScriptedPeer,
    errors: Error[],
  ) => Promise<void>,
) {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="generated-errors" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CONTENT}}iq` && frame.includes(BIND)) {
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
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
  try {
    await xmpp.start();
    await xmpp.send(xml("sync", { xmlns: QUERY }));
    while (true) {
      const root = readFrame(await peer.next())[0];
      if ("open" in root && root.open === `{${QUERY}}sync`) {
        break;
      }
    }
    await exercise(xmpp, peer, errors);
    expect(xmpp.status).toBe("online");
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
}

async function exchange(peer: ScriptedPeer, type: "get" | "set") {
  peer.send(
    `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}">${PAYLOAD}</iq>`,
  );
  return readFrame(await peer.next());
}

function expectedReply(type: "error" | "result", payload: string) {
  return readFrame(
    `<iq xmlns="${CONTENT}" to="sender@remote.test/s" from="user@example.test/r" id="generated" type="${type}">${payload}</iq>`,
  );
}

const malformed: { name: string; error: () => Element }[] = [
  ...["gone", "redirect"].flatMap((condition) =>
    [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e].map((point) => ({
      name: `${condition} cannot contain RFC3987 §4.1 bidi control ${point.toString(16)}`,
      error: () =>
        xml(
          "error",
          { type: "modify" },
          xml(condition, STANZAS, `foo:${String.fromCodePoint(point)}`),
        ),
    })),
  ),
  ...["gone", "redirect"].flatMap((condition) =>
    ["replace sole condition", "rename earlier text"].map((change) => ({
      name: `${condition} scalar conversion can ${change} with an invalid new address`,
      error: () => {
        const address = new SourceElement(condition, { xmlns: STANZAS });
        const previous = xml("text", STANZAS, "bad %");
        const error = xml(
          "error",
          { type: "modify" },
          change === "rename earlier text" ? previous : null,
          address,
        );
        address.append({
          toString() {
            if (change === "replace sole condition") {
              error.children = [xml(condition, STANZAS, "bad %")];
            } else {
              address.name = "text";
              previous.name = condition;
            }
            return "xmpp:new@example.test";
          },
        });
        return error;
      },
    })),
  ),
  ...["gone", "redirect"].flatMap((condition) =>
    ["type", "second condition", "namespace"].map((change) => ({
      name: `${condition} scalar conversion changes generated error ${change}`,
      error: () => {
        const address = new SourceElement(condition, { xmlns: STANZAS });
        const error = xml("error", { type: "modify" }, address);
        address.append({
          toString() {
            if (change === "type") {
              error.attrs.type = "invalid";
            } else if (change === "namespace") {
              error.attrs.xmlns = DETAIL;
            } else {
              error.append(xml("conflict", STANZAS));
            }
            return "xmpp:new@example.test";
          },
        });
        return error;
      },
    })),
  ),
  ...["gone", "redirect"].flatMap((condition) =>
    [
      { name: "boolean", value: () => true },
      { name: "bigint", value: () => 123n },
      { name: "object", value: () => ({ toString: () => "bad %" }) },
    ].map(({ name, value }) => ({
      name: `${condition} rejects invalid serialized ${name} character data`,
      error: () => {
        const address = new SourceElement(condition, { xmlns: STANZAS });
        address.append(value());
        return xml("error", { type: "modify" }, address);
      },
    })),
  ),
  ...["gone", "redirect"].map((condition) => ({
    name: `${condition} cannot trust getText instead of serialized character data`,
    error: () => {
      const address = xml(condition, STANZAS, "bad %");
      address.getText = () => "xmpp:valid@example.test";
      return xml("error", { type: "modify" }, address);
    },
  })),
  ...["gone", "redirect"].flatMap((condition) =>
    [
      "not a valid URI %",
      "/relative/path",
      "1bad:address",
      "xmpp:user%GG@example.test",
      "foo://host:not-a-port/path",
      "foo://[not-an-ip]/path",
      "foo://[1:2:3:4:5:6:7:8:9]/path",
      "foo://[::ffff:192.0.2.999]/path",
      "xmpp:user\\name@example.test",
      "foo:path#fragment#again",
      "foo:\uE000",
      "foo:path#\uE000",
      "foo:\u{1FFFE}",
    ].map((address) => ({
      name: `${condition} contains invalid URI/IRI ${JSON.stringify(address)}`,
      error: () =>
        xml("error", { type: "modify" }, xml(condition, STANZAS, address)),
    })),
  ),
  ...["gone", "redirect"].map((condition) => ({
    name: `${condition} address contains markup instead of character data`,
    error: () =>
      xml(
        "error",
        { type: "modify" },
        xml(
          condition,
          STANZAS,
          xml("address", DETAIL, "xmpp:user@example.test"),
        ),
      ),
  })),
  {
    name: "ESM child adds a second standard condition",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        new SourceElement("conflict", { xmlns: STANZAS }),
      ),
  },
  {
    name: "ESM diagnostic markup is not character data",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        xml("text", STANZAS, new SourceElement("markup", { xmlns: DETAIL })),
      ),
  },
  {
    name: "ESM application child uses a reserved namespace",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        new SourceElement("detail", { xmlns: CONTENT }),
      ),
  },
  {
    name: "unregistered error type",
    error: () => xml("error", { type: "foo" }, xml("forbidden", STANZAS)),
  },
  {
    name: "missing error type",
    error: () => xml("error", {}, xml("forbidden", STANZAS)),
  },
  {
    name: "error root explicitly clears its content namespace",
    error: () =>
      xml("error", { type: "cancel", xmlns: "" }, xml("forbidden", STANZAS)),
  },
  { name: "missing condition", error: () => xml("error", { type: "cancel" }) },
  {
    name: "two standard conditions",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        xml("conflict", STANZAS),
      ),
  },
  {
    name: "unregistered standard condition",
    error: () => xml("error", { type: "cancel" }, xml("custom", STANZAS)),
  },
  {
    name: "foreign condition without a standard condition",
    error: () => xml("error", { type: "cancel" }, xml("forbidden", DETAIL)),
  },
  {
    name: "condition inherits the core content namespace",
    error: () => xml("error", { type: "cancel" }, xml("forbidden")),
  },
  {
    name: "condition prefix is rebound to an application namespace",
    error: () =>
      xml(
        "error",
        { type: "cancel", "xmlns:e": STANZAS },
        xml("e:forbidden", { "xmlns:e": DETAIL }),
      ),
  },
  ...[CONTENT, SERVER, STREAM, ""].map((namespace) => ({
    name: `application detail uses reserved or absent namespace ${namespace}`,
    error: () =>
      xml(
        "error",
        { type: "cancel", xmlns: CONTENT },
        xml("forbidden", STANZAS),
        xml("detail", { xmlns: namespace }),
      ),
  })),
  {
    name: "diagnostic text contains markup",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        xml("text", STANZAS, xml("markup", DETAIL)),
      ),
  },
];

// RFC 6120 §§8.3.1–8.3.2: the library must not manufacture an invalid error reply.
// Fallback and one local diagnostic are policy; the mandatory error syntax is not.
for (const { name, error } of malformed) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.2: generated %s error falls back / ${name}`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = error();
        let calls = 0;
        xmpp.iqCallee[type](QUERY, "query", () => {
          calls += 1;
          return value;
        });
        expect(await exchange(peer, type)).toEqual(
          expectedReply("error", PAYLOAD + FALLBACK),
        );
        expect(calls).toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);
        peer.send(
          `<iq xmlns="${CONTENT}" type="get" id="recovery"><ping xmlns="urn:xmpp:ping"/></iq>`,
        );
        expect(readFrame(await peer.next())).toEqual(
          readFrame(`<iq xmlns="${CONTENT}" type="result" id="recovery"/>`),
        );
      });
    },
  );
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §§4.8.5/8.3: generated %s rejects a content-prefixed error root without losing the reply",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      const handled = Promise.withResolvers<void>();
      xmpp.iqCallee[type](QUERY, "query", () => {
        handled.resolve();
        return xml(
          "c:error",
          { "xmlns:c": CONTENT, type: "cancel" },
          xml("forbidden", STANZAS),
        );
      });
      peer.send(
        `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}">${PAYLOAD}</iq>`,
      );
      await handled.promise;
      peer.send(
        `<iq xmlns="${CONTENT}" type="get" id="barrier"><ping xmlns="urn:xmpp:ping"/></iq>`,
      );
      expect(readFrame(await peer.next())).toEqual(
        expectedReply("error", PAYLOAD + FALLBACK),
      );
      expect(readFrame(await peer.next())).toEqual(
        readFrame(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
    });
  },
);

// §8.3.3 recommends usual type/condition pairs but permits other appropriate pairs.
for (const condition of CONDITIONS) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.3: generated %s preserves registered condition ${condition}`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        xmpp.iqCallee[type](QUERY, "query", () =>
          xml("error", { type: "cancel" }, xml(condition, STANZAS)),
        );
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "error",
            `${PAYLOAD}<error type="cancel"><${condition} xmlns="${STANZAS}"/></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

for (const errorType of ERROR_TYPES) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.2: generated %s preserves legal error type ${errorType}`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        xmpp.iqCallee[type](QUERY, "query", () =>
          xml("error", { type: errorType }, xml("forbidden", STANZAS)),
        );
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "error",
            `${PAYLOAD}<error type="${errorType}"><forbidden xmlns="${STANZAS}"/></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §8.3.2: generated %s accepts a legal ESM condition child",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      xmpp.iqCallee[type](QUERY, "query", () =>
        xml(
          "error",
          { type: "cancel" },
          new SourceElement("forbidden", { xmlns: STANZAS }),
        ),
      );
      expect(await exchange(peer, type)).toEqual(
        expectedReply(
          "error",
          `${PAYLOAD}<error type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
        ),
      );
      expect(errors).toEqual([]);
    });
  },
);

for (const core of [false, true]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §§8.3/8.4: generated %s accepts an ESM ${core ? "core error" : "foreign error payload"} root`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = new SourceElement("error", {
          xmlns: core ? CONTENT : DETAIL,
          type: "cancel",
        });
        value.append(new SourceElement("forbidden", { xmlns: STANZAS }));
        xmpp.iqCallee[type](QUERY, "query", () => value);
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            core ? "error" : "result",
            `${core ? PAYLOAD : ""}<error xmlns="${core ? CONTENT : DETAIL}" type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

for (const constructor of ["CJS", "ESM"]) {
  for (const namespace of [0, false, 123, true]) {
    test.each(REQUEST_TYPES)(
      `RFC 6120 §8.4: generated %s preserves ${constructor} scalar foreign namespace ${namespace}`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          const value =
            constructor === "CJS"
              ? new XMLElement("error", {
                  xmlns: namespace,
                  type: "application",
                })
              : new SourceElement("error", {
                  xmlns: namespace,
                  type: "application",
                });
          xmpp.iqCallee[type](QUERY, "query", () => value);
          expect(await exchange(peer, type)).toEqual(
            expectedReply(
              "result",
              `<error xmlns="${namespace}" type="application"/>`,
            ),
          );
          expect(errors).toEqual([]);
        });
      },
    );
  }
}

for (const constructor of ["CJS", "ESM"]) {
  for (const namespace of [0, false]) {
    for (const prefix of [false, true]) {
      test.each(REQUEST_TYPES)(
        `RFC 6120 §8.3.2: generated %s preserves ${constructor} scalar ${prefix ? "prefixed" : "default"} application namespace ${namespace}`,
        async (type) => {
          await session(async (xmpp, peer, errors) => {
            const name = prefix ? "d:detail" : "detail";
            const attributes = {
              [prefix ? "xmlns:d" : "xmlns"]: namespace,
            };
            const detail =
              constructor === "CJS"
                ? new XMLElement(name, attributes)
                : new SourceElement(name, attributes);
            xmpp.iqCallee[type](QUERY, "query", () =>
              xml(
                "error",
                { type: "cancel" },
                xml("forbidden", STANZAS),
                detail,
              ),
            );
            expect(await exchange(peer, type)).toEqual(
              expectedReply(
                "error",
                `${PAYLOAD}<error type="cancel"><forbidden xmlns="${STANZAS}"/>${prefix ? `<d:detail xmlns:d="${namespace}"/>` : `<detail xmlns="${namespace}"/>`}</error>`,
              ),
            );
            expect(errors).toEqual([]);
          });
        },
      );
    }
  }
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §§8.3.1–8.3.4: generated %s preserves error detail, text and original query order",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      xmpp.iqCallee[type](QUERY, "query", () =>
        xml(
          "error",
          { type: "auth", by: "user@example.test/r", code: "403" },
          xml("forbidden", STANZAS),
          xml("text", { xmlns: STANZAS, "xml:lang": "pl" }, "Zażółć <&>"),
          xml(
            "d:detail",
            { "xmlns:d": DETAIL },
            xml("d:value", {}, "one"),
            xml("d:value", { "xmlns:d": QUERY }, "two"),
          ),
        ),
      );
      expect(await exchange(peer, type)).toEqual(
        expectedReply(
          "error",
          `${PAYLOAD}<error type="auth" by="user@example.test/r" code="403"><forbidden xmlns="${STANZAS}"/><text xmlns="${STANZAS}" xml:lang="pl">Zażółć &lt;&amp;&gt;</text><d:detail xmlns:d="${DETAIL}"><d:value>one</d:value><d:value xmlns:d="${QUERY}">two</d:value></d:detail></error>`,
        ),
      );
      expect(errors).toEqual([]);
    });
  },
);

for (const repeated of ["application", "descendant"]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.4: generated %s preserves a shared foreign ${repeated} child as repeated valid XML`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = xml("value", DETAIL, "shared");
        const detail = xml("detail", DETAIL, value);
        if (repeated === "descendant") {
          detail.append(value);
        }
        const error = xml(
          "error",
          { type: "cancel" },
          xml("forbidden", STANZAS),
          detail,
        );
        if (repeated === "application") {
          error.append(detail);
        }
        xmpp.iqCallee[type](QUERY, "query", () => error);
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "error",
            `${PAYLOAD}<error type="cancel"><forbidden xmlns="${STANZAS}"/>${repeated === "application" ? `<detail xmlns="${DETAIL}"><value>shared</value></detail><detail xmlns="${DETAIL}"><value>shared</value></detail>` : `<detail xmlns="${DETAIL}"><value>shared</value><value>shared</value></detail>`}</error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

test.each(["gone", "redirect"])(
  "RFC 6120 §8.3.3: generated error preserves %s URI text",
  async (condition) => {
    await session(async (xmpp, peer, errors) => {
      xmpp.iqCallee.get(QUERY, "query", () =>
        xml(
          "error",
          { type: "modify" },
          xml(condition, STANZAS, "xmpp:new@example.test?join"),
        ),
      );
      expect(await exchange(peer, "get")).toEqual(
        expectedReply(
          "error",
          `${PAYLOAD}<error type="modify"><${condition} xmlns="${STANZAS}">xmpp:new@example.test?join</${condition}></error>`,
        ),
      );
      expect(errors).toEqual([]);
    });
  },
);

// RFC3987 §2.2 defines IRI (not IRI-reference or fragmentless absolute-IRI).
// This matrix tests generic syntax, not scheme-specific reachability.
for (const condition of ["gone", "redirect"]) {
  for (const value of ["example.test", 123, true, 123n, Symbol("a")]) {
    test.each(REQUEST_TYPES)(
      `RFC 6120 §§8.3.3.5/.14: generated %s ${condition} preserves stable replacement ${typeof value} character data`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          const address = new SourceElement(condition, { xmlns: STANZAS });
          const error = xml("error", { type: "modify" }, address);
          let calls = 0;
          address.append({
            toString() {
              calls += 1;
              const replacement = new SourceElement(condition, {
                xmlns: STANZAS,
              });
              replacement.append("foo:", value);
              error.children = [replacement];
              return "xmpp:original@example.test";
            },
          });
          xmpp.iqCallee[type](QUERY, "query", () => error);
          expect(await exchange(peer, type)).toEqual(
            expectedReply(
              "error",
              `${PAYLOAD}<error type="modify"><${condition} xmlns="${STANZAS}">foo:${String(value)}</${condition}></error>`,
            ),
          );
          expect(calls).toBe(1);
          expect(errors).toEqual([]);
        });
      },
    );
  }
  test.each(REQUEST_TYPES)(
    `Generated %s ${condition} replacement policy does not execute a new scalar callback`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const address = new SourceElement(condition, { xmlns: STANZAS });
        const error = xml("error", { type: "modify" }, address);
        let calls = 0;
        let replacementCalls = 0;
        address.append({
          toString() {
            calls += 1;
            const replacement = new SourceElement(condition, {
              xmlns: STANZAS,
            });
            replacement.append({
              toString() {
                replacementCalls += 1;
                return "xmpp:new@example.test";
              },
            });
            error.children = [replacement];
            return "xmpp:original@example.test";
          },
        });
        xmpp.iqCallee[type](QUERY, "query", () => error);
        expect(await exchange(peer, type)).toEqual(
          expectedReply("error", PAYLOAD + FALLBACK),
        );
        expect(calls).toBe(1);
        expect(replacementCalls).toBe(0);
        expect(errors).toHaveLength(1);
      });
    },
  );
}

for (const condition of ["gone", "redirect"]) {
  for (const change of ["text", "application", "address"]) {
    test.each(REQUEST_TYPES)(
      `RFC 6120 §§8.3.2/.3: generated %s ${condition} preserves a legal scalar-converted ${change} condition`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          const address = new SourceElement(condition, { xmlns: STANZAS });
          const error = xml("error", { type: "modify" }, address);
          address.append({
            toString() {
              if (change === "address") {
                address.name = condition === "gone" ? "redirect" : "gone";
              } else {
                address.name = change === "text" ? "text" : "detail";
                address.attrs.xmlns = change === "text" ? STANZAS : DETAIL;
                error.append(xml("forbidden", STANZAS));
              }
              return change === "address" ? "xmpp:new@example.test" : "bad %";
            },
          });
          xmpp.iqCallee[type](QUERY, "query", () => error);
          const expected =
            change === "address"
              ? `<${condition === "gone" ? "redirect" : "gone"} xmlns="${STANZAS}">xmpp:new@example.test</${condition === "gone" ? "redirect" : "gone"}>`
              : `<${change === "text" ? "text" : "detail"} xmlns="${change === "text" ? STANZAS : DETAIL}">bad %</${change === "text" ? "text" : "detail"}><forbidden xmlns="${STANZAS}"/>`;
          expect(await exchange(peer, type)).toEqual(
            expectedReply(
              "error",
              `${PAYLOAD}<error type="modify">${expected}</error>`,
            ),
          );
          expect(errors).toEqual([]);
        });
      },
    );
  }
}

for (const condition of ["gone", "redirect"]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §§8.3.3.5/.14: generated %s ${condition} ignores a lying text accessor`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const address = xml(condition, STANZAS, "xmpp:new@example.test");
        address.getText = () => "bad %";
        xmpp.iqCallee[type](QUERY, "query", () =>
          xml("error", { type: "modify" }, address),
        );
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "error",
            `${PAYLOAD}<error type="modify"><${condition} xmlns="${STANZAS}">xmpp:new@example.test</${condition}></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
  for (const firstValid of [false, true]) {
    test.each(REQUEST_TYPES)(
      `RFC 6120 §§8.3.3.5/.14: generated %s ${condition} converts mutable scalar character data once (${firstValid ? "valid" : "invalid"} first)`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          let calls = 0;
          const address = new SourceElement(condition, { xmlns: STANZAS });
          address.append({
            toString() {
              calls += 1;
              return (calls === 1) === firstValid
                ? "xmpp:new@example.test"
                : "bad %";
            },
          });
          xmpp.iqCallee[type](QUERY, "query", () =>
            xml("error", { type: "modify" }, address),
          );
          expect(await exchange(peer, type)).toEqual(
            firstValid
              ? expectedReply(
                  "error",
                  `${PAYLOAD}<error type="modify"><${condition} xmlns="${STANZAS}">xmpp:new@example.test</${condition}></error>`,
                )
              : expectedReply("error", PAYLOAD + FALLBACK),
          );
          expect(calls).toBe(1);
          expect(errors).toHaveLength(firstValid ? 0 : 1);
        });
      },
    );
  }
  for (const value of [
    true,
    123n,
    Symbol("a"),
    { toString: () => "example.test" },
  ]) {
    test.each(REQUEST_TYPES)(
      `RFC 6120 §§8.3.3.5/.14: generated %s ${condition} preserves legal writer scalar output ${String(value)}`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          const address = new SourceElement(condition, { xmlns: STANZAS });
          address.append("xmpp:", value);
          xmpp.iqCallee[type](QUERY, "query", () =>
            xml("error", { type: "modify" }, address),
          );
          expect(await exchange(peer, type)).toEqual(
            expectedReply(
              "error",
              `${PAYLOAD}<error type="modify"><${condition} xmlns="${STANZAS}">xmpp:${String(value)}</${condition}></error>`,
            ),
          );
          expect(errors).toEqual([]);
        });
      },
    );
  }
}

for (const Constructor of [XMLElement, SourceElement]) {
  for (const condition of ["gone", "redirect"]) {
    test.each(REQUEST_TYPES)(
      `RFC 6120 §§8.3.3.5/.14: generated %s ${condition} accepts split string/number character data (${Constructor === XMLElement ? "CJS" : "ESM"})`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          const address = new Constructor(`e:${condition}`, {
            "xmlns:e": STANZAS,
          });
          address.t("foo:").t(123).t("?a&b#part");
          xmpp.iqCallee[type](QUERY, "query", () =>
            xml("error", { type: "modify" }, address),
          );
          expect(await exchange(peer, type)).toEqual(
            expectedReply(
              "error",
              `${PAYLOAD}<error type="modify"><e:${condition} xmlns:e="${STANZAS}">foo:123?a&amp;b#part</e:${condition}></error>`,
            ),
          );
          expect(errors).toEqual([]);
        });
      },
    );
    test.each(REQUEST_TYPES)(
      `RFC 6120 §§8.3.3.5/.14: generated %s ${condition} rejects malformed split character data (${Constructor === XMLElement ? "CJS" : "ESM"})`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          const address = new Constructor(condition, { xmlns: STANZAS });
          address.t("foo:").t("%").t("GG");
          xmpp.iqCallee[type](QUERY, "query", () =>
            xml("error", { type: "modify" }, address),
          );
          expect(await exchange(peer, type)).toEqual(
            expectedReply("error", PAYLOAD + FALLBACK),
          );
          expect(errors).toHaveLength(1);
          peer.send(
            `<iq xmlns="${CONTENT}" type="get" id="recovery"><ping xmlns="urn:xmpp:ping"/></iq>`,
          );
          expect(readFrame(await peer.next())).toEqual(
            readFrame(`<iq xmlns="${CONTENT}" type="result" id="recovery"/>`),
          );
        });
      },
    );
  }
}

for (const condition of ["gone", "redirect"]) {
  for (const address of [
    "",
    "xmpp:new@example.test?join",
    "https://example.test/path?query=value#fragment",
    "mailto:user@example.test",
    "urn:example:animal:ferret:nose",
    "foo://example.test:999999/path",
    "foo://reg!$&'()*+,;=name/path",
    "foo://user:password@host:/path",
    "foo://[2001:db8::1]:42/path",
    "foo://[::ffff:192.0.2.128]/path",
    "foo://[vF.a:b!$&'()*+,;=]/path",
    "foo:///path",
    "foo:",
    "CUSTOM+v1.a:/path",
    "foo:%00%2F%ff",
    "xmpp:juliet@bücher.example/私",
    "foo:𐀀?\uE000#𐀀",
    "foo:path?\u{F0000}\u{10FFFD}",
    "foo:\u00A0\u200D\u2010\uD7FF\uF900\uFDCF\uFDF0\uFFEF",
    "foo:\u{1FFFD}\u{E1000}\u{EFFFD}",
  ]) {
    test.each(REQUEST_TYPES)(
      `RFC 6120 §§8.3.3.5/.14: generated %s ${condition} preserves legal generic URI/IRI ${JSON.stringify(address)}`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          xmpp.iqCallee[type](QUERY, "query", () =>
            xml("error", { type: "modify" }, xml(condition, STANZAS, address)),
          );
          const escaped = address
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
          expect(await exchange(peer, type)).toEqual(
            expectedReply(
              "error",
              `${PAYLOAD}<error type="modify"><${condition} xmlns="${STANZAS}">${escaped}</${condition}></error>`,
            ),
          );
          expect(errors).toEqual([]);
        });
      },
    );
  }
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §§4.8/8.3.2: generated %s accepts namespace-qualified core error and prefixed standard condition",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      xmpp.iqCallee[type](QUERY, "query", () =>
        xml(
          "error",
          { xmlns: CONTENT, type: "cancel", "xmlns:e": STANZAS },
          xml("e:forbidden"),
          xml("text", DETAIL, xml("markup", DETAIL, "application markup")),
        ),
      );
      expect(await exchange(peer, type)).toEqual(
        expectedReply(
          "error",
          `${PAYLOAD}<error xmlns="${CONTENT}" type="cancel" xmlns:e="${STANZAS}"><e:forbidden/><text xmlns="${DETAIL}"><markup>application markup</markup></text></error>`,
        ),
      );
      expect(errors).toEqual([]);
    });
  },
);

for (const prefix of [false, true]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.4: generated %s preserves an error payload's inherited ${prefix ? "prefixed" : "default"} foreign namespace`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = xml(
          prefix ? "d:error" : "error",
          { type: "application" },
          xml("d:detail"),
          xml("alias:detail"),
          xml("d:detail", { "xmlns:d": QUERY }),
        );
        xml(
          "holder",
          { "xmlns:d": QUERY, "xmlns:alias": DETAIL },
          xml("holder", { xmlns: DETAIL, "xmlns:d": DETAIL }, value),
        );
        const handled = Promise.withResolvers<void>();
        xmpp.iqCallee[type](QUERY, "query", () => {
          handled.resolve();
          return value;
        });
        peer.send(
          `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}">${PAYLOAD}</iq>`,
        );
        await handled.promise;
        // A valid following reply makes missing output an exact assertion, not a timeout.
        peer.send(
          `<iq xmlns="${CONTENT}" type="get" id="barrier"><ping xmlns="urn:xmpp:ping"/></iq>`,
        );
        expect(readFrame(await peer.next())).toEqual(
          expectedReply(
            "result",
            prefix
              ? `<d:error xmlns="${DETAIL}" xmlns:d="${DETAIL}" xmlns:alias="${DETAIL}" type="application"><d:detail/><alias:detail/><d:detail xmlns:d="${QUERY}"/></d:error>`
              : `<error xmlns="${DETAIL}" xmlns:d="${DETAIL}" xmlns:alias="${DETAIL}" type="application"><d:detail/><alias:detail/><d:detail xmlns:d="${QUERY}"/></error>`,
          ),
        );
        expect(readFrame(await peer.next())).toEqual(
          readFrame(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §8.4: generated %s preserves an ordinary result payload's inherited namespace bindings",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      const value = xml("result", {}, xml("d:detail"));
      xml("holder", { xmlns: DETAIL, "xmlns:d": QUERY }, value);
      const handled = Promise.withResolvers<void>();
      xmpp.iqCallee[type](QUERY, "query", () => {
        handled.resolve();
        return value;
      });
      peer.send(
        `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}">${PAYLOAD}</iq>`,
      );
      await handled.promise;
      peer.send(
        `<iq xmlns="${CONTENT}" type="get" id="barrier"><ping xmlns="urn:xmpp:ping"/></iq>`,
      );
      expect(readFrame(await peer.next())).toEqual(
        expectedReply(
          "result",
          `<result xmlns="${DETAIL}" xmlns:d="${QUERY}"><d:detail/></result>`,
        ),
      );
      expect(readFrame(await peer.next())).toEqual(
        readFrame(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`),
      );
      expect(errors).toEqual([]);
    });
  },
);

for (const prefix of [false, true]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.4: generated %s preserves qualified foreign ${prefix ? "prefixed" : "unprefixed"} error as a result`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = prefix
          ? xml("d:error", { "xmlns:d": DETAIL }, xml("d:detail"))
          : xml("error", { xmlns: DETAIL }, xml("detail"));
        xmpp.iqCallee[type](QUERY, "query", () => value);
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "result",
            prefix
              ? `<d:error xmlns:d="${DETAIL}"><d:detail/></d:error>`
              : `<error xmlns="${DETAIL}"><detail/></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

for (const rejected of [false, true]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3: generated %s handler ${rejected ? "rejection" : "throw"} emits its original failure and recovers`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const failure = new Error("Handler failed");
        xmpp.iqCallee[type](QUERY, "query", () => {
          if (rejected) {
            return Promise.reject(failure);
          }
          throw failure;
        });
        expect(await exchange(peer, type)).toEqual(
          expectedReply("error", PAYLOAD + FALLBACK),
        );
        expect(errors).toEqual([failure]);
      });
    },
  );
}

for (const handler of ["error", "throw", "unhandled"]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §§4.8/8.3.1: generated %s ${handler} reply preserves original query bindings inherited from IQ`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const failure = new Error("Handler failed");
        if (handler !== "unhandled") {
          xmpp.iqCallee[type](QUERY, "query", () => {
            if (handler === "throw") {
              throw failure;
            }
            return xml("error", { type: "cancel" }, xml("forbidden", STANZAS));
          });
        }
        peer.send(
          `<iq xmlns="${CONTENT}" xmlns:q="${QUERY}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}"><q:query><q:value>original</q:value></q:query></iq>`,
        );
        peer.send(
          `<iq xmlns="${CONTENT}" type="get" id="barrier"><ping xmlns="urn:xmpp:ping"/></iq>`,
        );
        expect(readFrame(await peer.next())).toEqual(
          expectedReply(
            "error",
            `<q:query xmlns:q="${QUERY}"><q:value>original</q:value></q:query><error type="cancel"><${handler === "error" ? "forbidden" : handler === "throw" ? "internal-server-error" : "service-unavailable"} xmlns="${STANZAS}"/></error>`,
          ),
        );
        expect(readFrame(await peer.next())).toEqual(
          readFrame(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`),
        );
        expect(errors).toEqual(handler === "throw" ? [failure] : []);
      });
    },
  );
}

test("RFC 6120 §8.3: a child's toString override cannot change generated error wire", async () => {
  await session(async (xmpp, peer, errors) => {
    const value = xml("error", { type: "cancel" }, xml("forbidden", STANZAS));
    value.toString = () =>
      `<error type="foo"><custom xmlns="${STANZAS}"/></error>`;
    xmpp.iqCallee.get(QUERY, "query", () => value);
    expect(await exchange(peer, "get")).toEqual(
      expectedReply(
        "error",
        `${PAYLOAD}<error type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
      ),
    );
    expect(errors).toEqual([]);
  });
});
