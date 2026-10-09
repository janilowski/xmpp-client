import { expect, test } from "bun:test";
import { once } from "node:events";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const STANZA_ERRORS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const FOREIGN = "urn:test:xml";
const OPTIONS = { domain: "example.test", lang: "en" };
const CLOSE = `<close xmlns="${FRAMING}"/>`;
const CLOSE_TIMEOUT_MS = 250;
const EVENT_TIMEOUT_MS = 2000;
const ROOT_DEPTH = 0;
const CORE_ERROR_DEPTH = 1;

// Error conditions are direct children; text/application detail may precede them.
function directChildNames(
  events: ReturnType<typeof readFrame>,
  parent: string,
  parentDepth = ROOT_DEPTH,
) {
  const names: string[] = [];
  let depth = ROOT_DEPTH;
  let found = false;
  for (const event of events) {
    if ("open" in event) {
      if (found && depth === parentDepth + 1) {
        names.push(event.open);
      }
      if (depth === parentDepth && event.open === parent) {
        found = true;
      }
      depth += 1;
      continue;
    }
    if ("close" in event) {
      depth -= 1;
      if (found && depth === parentDepth) {
        break;
      }
    }
  }
  return names;
}

test("RFC 6120 §8.3.2 XML oracle: inspect the direct error, not a nested namesake", () => {
  const events = readFrame(
    `<message xmlns="${CONTENT}" type="error"><detail xmlns="${FOREIGN}"><error xmlns="${CONTENT}"><not-acceptable xmlns="${STANZA_ERRORS}"/></error></detail><error type="cancel">\n<text xmlns="${STANZA_ERRORS}">diagnostic</text><forbidden xmlns="${STANZA_ERRORS}"/></error></message>`,
  );
  expect(directChildNames(events, `{${CONTENT}}message`)).toEqual([
    `{${FOREIGN}}detail`,
    `{${CONTENT}}error`,
  ]);
  expect(
    directChildNames(events, `{${CONTENT}}error`, CORE_ERROR_DEPTH),
  ).toEqual([`{${STANZA_ERRORS}}text`, `{${STANZA_ERRORS}}forbidden`]);
});

// Public wire/error evidence complements parser units and outgoing XML grammar cases.
// RFC 7395 §§3.3.1/3.3.3 replace the enclosing XML stream with standalone frames.
async function session() {
  const peer = new ScriptedPeer((frame, remote) => {
    if (frame.startsWith("<open")) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="xml"/>`,
      );
    } else if (frame.startsWith("<close")) {
      remote.send(CLOSE);
    }
  });
  const xmpp = client({
    ...OPTIONS,
    service: peer.url,
    timeout: CLOSE_TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    await xmpp.connect(peer.url);
    await xmpp.open(OPTIONS);
    expect(readFrame(await peer.next())[0]).toMatchObject({
      open: `{${FRAMING}}open`,
    });
    return { xmpp, peer, errors };
  } catch (error) {
    await xmpp.stop();
    await peer.stop();
    throw error;
  }
}

const invalid = [
  [
    "§11.1 comment",
    `<message xmlns="${CONTENT}"><!--comment--></message>`,
    "restricted-xml",
  ],
  [
    "§11.1 processing instruction",
    `<message xmlns="${CONTENT}"><?app instruction?></message>`,
    "restricted-xml",
  ],
  [
    "§11.1 internal DTD",
    `<!DOCTYPE message [<!ENTITY secret "private">]><message xmlns="${CONTENT}"/>`,
    "restricted-xml",
  ],
  [
    "§11.1 external DTD",
    `<!DOCTYPE message SYSTEM "https://invalid.example/xml.dtd"><message xmlns="${CONTENT}"/>`,
    "restricted-xml",
  ],
  [
    "§§11.1/11.3 undeclared entity",
    `<message xmlns="${CONTENT}"><body>&undefined;</body></message>`,
    "not-well-formed",
  ],
  [
    "§11.1 trailing comment",
    `<message xmlns="${CONTENT}"/><!--comment-->`,
    "restricted-xml",
  ],
  [
    "§11.1 trailing processing instruction",
    `<message xmlns="${CONTENT}"/><?app instruction?>`,
    "restricted-xml",
  ],
  [
    "§11.3 incomplete document",
    `<message xmlns="${CONTENT}">`,
    "not-well-formed",
  ],
  [
    "§11.3 mismatched tags",
    `<message xmlns="${CONTENT}"><body></message>`,
    "not-well-formed",
  ],
  [
    "§11.3 unbound prefix",
    `<message xmlns="${CONTENT}" id="invalid"><p:body/></message>`,
    "namespace",
  ],
  [
    "§11.3 duplicate expanded attributes",
    `<message xmlns="${CONTENT}" id="invalid" xmlns:a="urn:test" xmlns:b="urn:test" a:name="one" b:name="two"/>`,
    "namespace",
  ],
  [
    "§11.3 invalid character reference",
    `<message xmlns="${CONTENT}"><body>&#0;</body></message>`,
    "not-well-formed",
  ],
  [
    "§11.5 misplaced declaration",
    `<message xmlns="${CONTENT}"/><?xml version="1.0"?>`,
    "not-well-formed",
  ],
  [
    "§11.5 invalid declaration ordering",
    `<?xml encoding="UTF-8" version="1.0"?><message xmlns="${CONTENT}"/>`,
    "not-well-formed",
  ],
  [
    "§11.6 declared non-UTF-8",
    `<?xml version="1.0" encoding="ISO-8859-1"?><message xmlns="${CONTENT}"/>`,
    "unsupported-encoding",
  ],
  [
    "§11.8 XML 1.1",
    `<?xml version="1.1"?><message xmlns="${CONTENT}"/>`,
    "invalid-xml",
  ],
] as const;

// §4.9.3.1 permits bad-format instead of the more specific XML conditions.
// §11.3 rule 4 also permits a not-acceptable stanza error for namespace violations.
test.each(invalid)(
  "RFC 6120 %s: reject the whole received document",
  async (_name, source, specific) => {
    const { xmpp, peer, errors } = await session();
    const stanzas: Element[] = [];
    xmpp.on("stanza", (stanza: Element) => stanzas.push(stanza));
    try {
      peer.send(source);
      const error = readFrame(await peer.next());
      if (
        specific === "namespace" &&
        error[0] &&
        "open" in error[0] &&
        error[0].open === `{${CONTENT}}message`
      ) {
        expect(error[0]).toMatchObject({
          attributes: { "{}id": "invalid", "{}type": "error" },
        });
        expect(
          directChildNames(error, `{${CONTENT}}message`).filter(
            (name) => name === `{${CONTENT}}error`,
          ),
        ).toHaveLength(1);
        expect(
          directChildNames(error, `{${CONTENT}}error`, CORE_ERROR_DEPTH).filter(
            (name) =>
              name.startsWith(`{${STANZA_ERRORS}}`) &&
              name !== `{${STANZA_ERRORS}}text`,
          ),
        ).toEqual([`{${STANZA_ERRORS}}not-acceptable`]);
        await xmpp.send(xml("barrier", { xmlns: FOREIGN }));
        expect(readFrame(await peer.next())[0]).toMatchObject({
          open: `{${FOREIGN}}barrier`,
        });
        expect(errors).toEqual([]);
      } else {
        expect(error[0]).toMatchObject({ open: `{${STREAM}}error` });
        const conditions = directChildNames(error, `{${STREAM}}error`).filter(
          (name) =>
            name.startsWith(`{${STREAM_ERRORS}}`) &&
            name !== `{${STREAM_ERRORS}}text`,
        );
        expect(conditions).toHaveLength(1);
        expect(conditions[0]).toBeOneOf([
          `{${STREAM_ERRORS}}${specific === "namespace" ? "not-well-formed" : specific}`,
          `{${STREAM_ERRORS}}bad-format`,
          ...(_name.includes("undeclared entity")
            ? [`{${STREAM_ERRORS}}restricted-xml`]
            : []),
        ]);
        expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
        await peer.waitForClose();
        expect(errors).toHaveLength(1);
      }
      expect(stanzas).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

// Well-formedness/namespace generation already has tree, Unicode and SM controls
// in rfc6120-outgoing-xml.test.ts; these add restricted serialized constructs.
for (const [name, source] of invalid.filter(
  ([, , condition]) => condition !== "namespace",
)) {
  // Forbidden code points already have public send/sendMany grammar controls.
  if (name === "§11.3 invalid character reference") {
    continue;
  }
  test.each(["send", "sendMany"] as const)(
    `RFC 6120 ${name}: %s rejects generated serialized XML before writing`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      const stanza = xml("message");
      stanza.toString = () => source;
      const sent: Element[] = [];
      xmpp.on("send", (element: Element) => sent.push(element));
      try {
        const result = await (
          method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza])
        ).catch((error: Error) => error);
        expect(result).toBeInstanceOf(TypeError);
        expect(sent).toEqual([]);

        // The later valid frame proves rejection, not a silent or broken writer.
        await xmpp.send(xml("barrier", { xmlns: FOREIGN }));
        expect(readFrame(await peer.next())[0]).toMatchObject({
          open: `{${FOREIGN}}barrier`,
        });
        expect(peer.transcript).toHaveLength(2);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

test.each([
  [
    "§11.6 literal FEFF is text, not a BOM",
    "\uFEFFmiddle\uFEFF",
    "\uFEFFmiddle\uFEFF",
  ],
  [
    "§11.6 character-reference FEFF",
    "&#xFEFF;middle&#65279;",
    "\uFEFFmiddle\uFEFF",
  ],
  [
    "§§11.3/11.8 XML 1.0 line-end normalization",
    "line\r\nnext\rfinal",
    "line\nnext\nfinal",
  ],
  [
    "§11.1 predefined entities and CDATA",
    "&lt;&gt;&amp;&quot;&apos;<![CDATA[<raw>]]>",
    "<>&\"'<raw>",
  ],
  [
    "§§11.3/11.6 UTF-8 text and numeric references",
    "Zażółć 汉 &#x1F426;&#128578;",
    "Zażółć 汉 🐦🙂",
  ],
] as const)(
  "RFC 6120 %s: preserve received character data",
  async (_name, body, expected) => {
    const { xmpp, peer, errors } = await session();
    const stanzas: Element[] = [];
    xmpp.on("stanza", (stanza: Element) => stanzas.push(stanza));
    const barrier = once(xmpp, "nonza", {
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    try {
      peer.send(
        `<message xmlns="${CONTENT}"><body marker="\uFEFF">${body}</body></message>`,
      );
      peer.send(`<barrier xmlns="${FOREIGN}"/>`);
      await barrier;
      expect(stanzas).toHaveLength(1);
      expect(stanzas[0].getChildText("body")).toBe(expected);
      expect(stanzas[0].getChild("body")?.attrs.marker).toBe("\uFEFF");
      expect(errors).toEqual([]);
      expect(peer.transcript).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

// §11.5 allows ignoring inbound standalone="no" or closing with a stream error.
test("RFC 6120 §11.5: ignore standalone=no or reject it with a stream error", async () => {
  const { xmpp, peer, errors } = await session();
  const received = once(xmpp, "stanza", {
    signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
  }).then(
    ([stanza]: Element[]) => ({ stanza }),
    (error: Error) => ({ error }),
  );
  try {
    peer.send(
      `<?xml version="1.0" standalone="no"?><message xmlns="${CONTENT}"><body>plain</body></message>`,
    );
    const result = await received;
    if ("stanza" in result) {
      expect(result.stanza.getChildText("body")).toBe("plain");
      expect(errors).toEqual([]);
      expect(peer.transcript).toHaveLength(1);
    } else {
      const error = readFrame(await peer.next());
      expect(error[0]).toMatchObject({ open: `{${STREAM}}error` });
      const conditions = directChildNames(error, `{${STREAM}}error`).filter(
        (name) =>
          name.startsWith(`{${STREAM_ERRORS}}`) &&
          name !== `{${STREAM_ERRORS}}text`,
      );
      expect(conditions).toHaveLength(1);
      expect(conditions[0]).toBeOneOf([
        `{${STREAM_ERRORS}}restricted-xml`,
        `{${STREAM_ERRORS}}bad-format`,
      ]);
      expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
      await peer.waitForClose();
      expect(errors).toHaveLength(1);
    }
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

// §11.7 permits separator whitespace; RFC 7395 §3.3.3 still forbids whitespace-only frames.
test("RFC 6120 §11.7 / RFC 7395 §3.3.3: preserve whitespace inside and after a document", async () => {
  const { xmpp, peer, errors } = await session();
  const received = once(xmpp, "stanza", {
    signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
  });
  try {
    peer.send(
      `<message xmlns="${CONTENT}">\n\t<body> </body>\r\n</message> \t\r\n`,
    );
    const [stanza] = await received;
    expect(stanza.getChildText("body")).toBe(" ");
    expect(stanza.children).toHaveLength(3);
    expect(stanza.children[0]).toBe("\n\t");
    expect(stanza.children[2]).toBe("\n");
    expect(errors).toEqual([]);
    expect(peer.transcript).toHaveLength(1);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});
