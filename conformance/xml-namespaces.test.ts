import { expect, test } from "bun:test";
import { once } from "node:events";
import { client, xml } from "../src/client/index.js";
import parseDocument, {
  validateDocument,
  XML_CONTEXT,
} from "../src/xml/lib/parseDocument.js";
import readXML from "../src/resolve/lib/readXML.ts";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

// Namespaces in XML 1.0 Third Edition, §§1–8; errata checked 2026-11-09.
// https://www.w3.org/TR/2009/REC-xml-names-20091208/
// https://www.w3.org/XML/2009/xml-names-errata
// This is the dependency entry point, not a second copy of existing suites:
// §2: rfc6120-namespaces / rfc6120-namespace-uris (exact URI identity).
// §§3/6: rfc6120-namespace-attributes / -scope (aliases, defaults, scoping).
// §§4/5/6.3: rfc6120-outgoing-xml / -xml (QNames and attribute uniqueness).
// §§7/8: processor reporting and the remaining literal/wire controls below.
// XMPP forbids DTDs/PIs; HTTP permits PIs but retains the DTD-free policy.
// DTD declarations/defaults and namespace-validating roles are outside these
// restricted paths; this does not claim general validating-XML conformance.
const CLIENT = "jabber:client";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const XRD = "http://docs.oasis-open.org/ns/xri/xrd-1.0";
const FOREIGN = "urn:test:namespaces";
const TIMEOUT_MS = 1000;
const NEGOTIATION_FRAME_BUDGET = 8;
const METHODS: ("send" | "sendMany")[] = ["send", "sendMany"];

// §3 reserves these prefixes for future specifications but explicitly forbids
// treating their use as a fatal processor error. Only literal xml/xmlns differ.
test.each(["xmlfoo", "XMLtest", "xMl", "XMLNS"])(
  "Namespaces §3: preserve legal xml-like prefix %s",
  (prefix) => {
    const source = `<root><${prefix}:child ${prefix}:marker="value" xmlns:${prefix}="${FOREIGN}"/></root>`;
    for (const context of [XML_CONTEXT.XMPP, XML_CONTEXT.HTTP]) {
      const root = parseDocument(source, context);
      const child = root.getChildElements()[0];
      expect(child.getName()).toBe("child");
      expect(child.getNS()).toBe(FOREIGN);
      expect(child.getAttr("marker", FOREIGN)).toBe("value");
      expect(validateDocument(source, context)).toBeUndefined();
    }
  },
);

const prohibited = [
  ["xml rebound", `<body xmlns:xml="${FOREIGN}"/>`],
  ["xml undeclared", '<body xmlns:xml=""/>'],
  ["XML namespace alias", `<body xmlns:p="${XML}"/>`],
  ["XML namespace default", `<body xmlns="${XML}"/>`],
  ["xmlns prefix declared", `<body xmlns:xmlns="${FOREIGN}"/>`],
  ["xmlns prefix explicitly bound", `<body xmlns:xmlns="${XMLNS}"/>`],
  ["XMLNS namespace alias", `<body xmlns:p="${XMLNS}"/>`],
  ["XMLNS namespace default", `<body xmlns="${XMLNS}"/>`],
  ["xmlns element prefix", "<xmlns:body/>"],
  ["unused prefix undeclared", '<body xmlns:p=""/>'],
  [
    "inherited prefix undeclared",
    `<body xmlns:p="${FOREIGN}"><child xmlns:p=""/></body>`,
  ],
  [
    "sibling declaration leaked",
    `<body><child xmlns:p="${FOREIGN}"/><p:later/></body>`,
  ],
] as const;

test.each(prohibited)(
  "Namespaces §§3/5/6.1/8: input and output reject %s",
  (_name, body) => {
    const source = `<root>${body}</root>`;
    for (const context of [XML_CONTEXT.XMPP, XML_CONTEXT.HTTP]) {
      expect(() => parseDocument(source, context)).toThrow();
      expect(() => validateDocument(source, context)).toThrow();
    }
  },
);

test.each([
  `<p:root p:marker="qualified" marker="plain" xmlns:p="${FOREIGN}"/>`,
  `<p:root xmlns:p="${FOREIGN}" marker="plain" p:marker="qualified"/>`,
  `<root marker="plain" p:marker="qualified" xmlns:p="${FOREIGN}" xmlns="${FOREIGN}"/>`,
])(
  "Namespaces §§6.1/6.2: same-tag declaration order preserves expanded names / %s",
  (source) => {
    for (const context of [XML_CONTEXT.XMPP, XML_CONTEXT.HTTP]) {
      const root = parseDocument(source, context);
      expect(root.getName()).toBe("root");
      expect(root.getNS()).toBe(FOREIGN);
      expect(root.getAttr("marker")).toBe("plain");
      expect(root.getAttr("marker", FOREIGN)).toBe("qualified");
      expect(validateDocument(source, context)).toBeUndefined();
    }
  },
);

test("Namespaces §3: normalized explicit xml binding and implicit binding agree", () => {
  const source =
    '<root xmlns:xml="http://www.w3.org/XML/1998/namespac&#x65;" xml:lang="pl"><xml:child xml:space="preserve"/></root>';
  const root = parseDocument(source, XML_CONTEXT.XMPP);
  expect(root.getAttr("lang", XML)).toBe("pl");
  expect(root.getChildElements()[0].getNS()).toBe(XML);
  expect(root.getChildElements()[0].getAttr("space", XML)).toBe("preserve");
  expect(validateDocument(source, XML_CONTEXT.XMPP)).toBeUndefined();
});

// §7 requires NCNames for PI targets even though XML 1.0 Name permits colons.
// Exercise the actual HTTP decoder/parser path, not an isolated saxes option.
test.each(["p:instruction", ":instruction", "instruction:", "a:b:c"])(
  "Namespaces §§7/8: HTTP XML refuses colon PI target %s",
  async (target) => {
    const source = `<?${target} data?><XRD xmlns="${XRD}"/>`;
    await expect(
      readXML(
        new Response(source, {
          headers: { "Content-Type": "application/xrd+xml; charset=UTF-8" },
        }),
      ),
    ).rejects.toThrow();
    expect(() => validateDocument(source, XML_CONTEXT.HTTP)).toThrow();
  },
);

test.each(["instruction", "żółć", "xml-stylesheet"])(
  "Namespaces §§7/8: valid HTTP PI target %s remains inert, not XMPP-permitted",
  async (target) => {
    const source = `<?${target} data?><XRD xmlns="${XRD}"/>`;
    const root = await readXML(
      new Response(source, {
        headers: { "Content-Type": "application/xrd+xml; charset=UTF-8" },
      }),
    );
    expect(root.getName()).toBe("XRD");
    expect(root.getNS()).toBe(XRD);
    expect(root.getChildElements()).toEqual([]);
    expect(root.getText()).toBe("");
    expect(validateDocument(source, XML_CONTEXT.HTTP)).toBeUndefined();
    expect(() => parseDocument(source, XML_CONTEXT.XMPP)).toThrow(
      "processinginstruction",
    );
    expect(() => validateDocument(source, XML_CONTEXT.XMPP)).toThrow(
      "processinginstruction",
    );
  },
);

async function session() {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!(root && "open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="namespaces"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CLIENT}}iq` && frame.includes(BIND)) {
      remote.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
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
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    await xmpp.start();
    const queued = peer.transcript.length;
    expect(queued).toBeLessThanOrEqual(NEGOTIATION_FRAME_BUDGET);
    for (let index = 0; index < queued; index++) {
      await peer.next();
    }
    return { xmpp, peer, errors };
  } catch (error) {
    await xmpp.stop();
    await peer.stop();
    throw error;
  }
}

const validBody = `<xmlfoo:first xmlfoo:marker="first" xmlns:xmlfoo="urn:test:first"/><XMLtest:second XMLtest:marker="second" xmlns:XMLtest="urn:test:second"/><XMLNS:third XMLNS:marker="third" xmlns:XMLNS="urn:test:third"/>`;

test("Namespaces §§3/6.1/8: public received stanza retains xml-like names and late declarations", async () => {
  const { xmpp, peer, errors } = await session();
  try {
    const received = once(xmpp, "stanza", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    peer.send(
      `<message xmlns="${CLIENT}" id="received">${validBody}</message>`,
    );
    const [stanza] = (await received) as [Element];
    expect(
      stanza
        .getChildElements()
        .map((element) => [element.getName(), element.getNS()]),
    ).toEqual([
      ["first", "urn:test:first"],
      ["second", "urn:test:second"],
      ["third", "urn:test:third"],
    ]);
    expect(
      stanza
        .getChild("first", "urn:test:first")
        ?.getAttr("marker", "urn:test:first"),
    ).toBe("first");
    expect(
      stanza
        .getChild("second", "urn:test:second")
        ?.getAttr("marker", "urn:test:second"),
    ).toBe("second");
    expect(
      stanza
        .getChild("third", "urn:test:third")
        ?.getAttr("marker", "urn:test:third"),
    ).toBe("third");
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each(METHODS)(
  "Namespaces §§3/5/8: %s validates actual serialized bindings before writing",
  async (method) => {
    const { xmpp, peer, errors } = await session();
    try {
      for (const [, body] of prohibited) {
        const element = xml("message", { id: "blocked" });
        element.toString = () =>
          `<message xmlns="${CLIENT}" id="blocked">${body}</message>`;
        await expect(
          method === "send" ? xmpp.send(element) : xmpp.sendMany([element]),
        ).rejects.toThrow();
        // A successful following frame proves local rejection did not write the
        // malformed document, poison the transport or silently substitute XML.
        const source = `<message xmlns="${CLIENT}" id="recovered">${validBody}</message>`;
        const valid = xml("message", { id: "recovered" });
        valid.toString = () => source;
        await (method === "send" ? xmpp.send(valid) : xmpp.sendMany([valid]));
        expect(await peer.next()).toBe(source);
      }
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

// The library selects fatal XML refusal; this is not a claim that §11.3's
// optional not-acceptable stanza-error alternative is generally prohibited.
test("Namespaces §§5/8 / fatal XML policy: a late namespace error exposes no partial stanza", async () => {
  const { xmpp, peer, errors } = await session();
  const stanzas: Element[] = [];
  xmpp.on("stanza", (element: Element) => stanzas.push(element));
  try {
    peer.send(
      `<message xmlns="${CLIENT}" id="blocked"><body>not delivered</body><later xmlns:p=""/></message>`,
    );
    const error = readFrame(await peer.next());
    expect(error[0]).toMatchObject({ open: `{${STREAM}}error` });
    expect(error).toContainEqual({
      open: "{urn:ietf:params:xml:ns:xmpp-streams}not-well-formed",
      attributes: {},
    });
    expect(readFrame(await peer.next())).toEqual(
      readFrame(`<close xmlns="${FRAMING}"/>`),
    );
    await peer.waitForClose();
    expect(stanzas).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});
