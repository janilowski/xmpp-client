import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { client, xml } from "../src/client/index.js";
// @ts-expect-error ltx does not ship TypeScript declarations.
import { Element as ExternalElement } from "ltx";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const XML = "http://www.w3.org/XML/1998/namespace";
const EXTENSION = "urn:example:language-test";
const TIMEOUT_MS = 500;

let peer: ScriptedPeer;
let xmpp: ReturnType<typeof client>;
let errors: Error[];

// Leave authentication paused: no negotiation writes can disguise a leaked stanza.
async function connectStream(lang: string | undefined = "en") {
  peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!root || !("open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="language"/>`,
      );
    }
    if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  errors = [];
  xmpp = client({
    service: peer.url,
    domain: "example.test",
    lang,
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.on("error", (error: Error) => errors.push(error));
  await xmpp.connect(peer.url);
}

afterEach(async () => {
  try {
    if (xmpp && xmpp.status !== "offline") {
      await xmpp.stop();
    }
  } finally {
    await peer?.stop();
  }
  expect(errors).toEqual([]);
  expect(peer.errors).toEqual([]);
});

// These are independent literal vectors, not output from the implementation.
const MALFORMED = [
  "not a tag",
  "en_US",
  "en-u-ÄA",
  "en\n",
  "en-u",
  "sl-rozaj-ROZAJ",
  "en-u-ca-gregory-U-nu-latn",
  "zh-cmn-yue",
];

// RFC 5646 §2.1: the fixed grandfathered alternatives include deprecated tags.
const GRANDFATHERED = [
  "en-GB-oed",
  "i-ami",
  "i-bnn",
  "i-default",
  "i-enochian",
  "i-hak",
  "i-klingon",
  "i-lux",
  "i-mingo",
  "i-navajo",
  "i-pwn",
  "i-tao",
  "i-tay",
  "i-tsu",
  "sgn-BE-FR",
  "sgn-BE-NL",
  "sgn-CH-DE",
  "art-lojban",
  "cel-gaulish",
  "no-bok",
  "no-nyn",
  "zh-guoyu",
  "zh-hakka",
  "zh-min",
  "zh-min-nan",
  "zh-xiang",
];

describe("RFC 6120 §§4.7.4/8.1.5 — outgoing language tag format", () => {
  for (const method of ["send", "sendMany"] as const) {
    test.each(["external child", "serialized document"] as const)(
      `§8.1.5: ${method} preserves valid serialized language / %s`,
      async (origin) => {
        await connectStream();
        await xmpp.open(xmpp.options);
        await peer.next();
        const stanza = xml("message", { id: "valid", "xml:lang": "pl" });
        if (origin === "external child") {
          stanza.append(
            new ExternalElement("body", { "xml:lang": "EN-gb-oed" }),
          );
        } else {
          stanza.toString = () =>
            '<message xmlns="jabber:client" id="valid" xml:lang="pl"><body xml:lang="EN-gb-oed"/></message>';
        }
        const result = await (
          method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza])
        ).catch((error: Error) => error);
        expect(result).toBeUndefined();
        expect(readFrame(await peer.next())).toEqual(
          readFrame(
            '<message xmlns="jabber:client" id="valid" xml:lang="pl"><body xml:lang="EN-gb-oed"/></message>',
          ),
        );
      },
    );
    test.each(["external child", "serialized document"] as const)(
      `§8.1.5: ${method} validates actual serialized language / %s`,
      async (origin) => {
        await connectStream();
        await xmpp.open(xmpp.options);
        await peer.next();
        const stanza = xml("message", { id: "invalid" });
        if (origin === "external child") {
          stanza.append(new ExternalElement("body", { "xml:lang": "en_US" }));
        } else {
          stanza.toString = () =>
            '<message xmlns="jabber:client" id="invalid" xml:lang="en_US"/>';
        }
        const sent: string[] = [];
        xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
        const result = await (
          method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza])
        ).catch((error: Error) => error);
        expect(result).toBeInstanceOf(TypeError);
        await xmpp.send(xml("message", { id: "barrier" }));
        expect(readFrame(await peer.next())[0]).toMatchObject({
          attributes: { "{}id": "barrier" },
        });
        expect(sent).toEqual(["barrier"]);
        expect(
          peer.transcript.some((frame) => frame.includes('id="invalid"')),
        ).toBe(false);
      },
    );
  }

  test.each(MALFORMED)(
    "§4.7.4 / RFC 5646 §§2.1–2.2: reject malformed configured stream language %j before wire emission",
    async (lang) => {
      await connectStream(lang);
      await expect(xmpp.open(xmpp.options)).rejects.toBeInstanceOf(TypeError);
      expect(peer.transcript).toEqual([]);
      await xmpp.open({ domain: "example.test", lang: "en" });
      const frame = await peer.next();
      expect(readFrame(frame)).toEqual(
        readFrame(
          `<open version="1.0" xmlns="${FRAMING}" to="example.test" xml:lang="en"/>`,
        ),
      );
      expect(peer.transcript).toEqual([frame]);
    },
  );

  for (const location of ["stanza", "child", "descendant"] as const) {
    test.each(MALFORMED)(
      `§8.1.5 / RFC 5646 §§2.1–2.2: reject malformed ${location} language %j without leaking its frame`,
      async (lang) => {
        await connectStream();
        await xmpp.open(xmpp.options);
        await peer.next();
        const sent: string[] = [];
        xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
        const stanza = xml(
          "message",
          {
            id: "invalid",
            ...(location === "stanza" ? { "xml:lang": lang } : {}),
          },
          location === "descendant"
            ? xml(
                "extra",
                { xmlns: EXTENSION },
                xml("label", { "xml:lang": lang }, "text"),
              )
            : xml(
                "body",
                location === "child" ? { "xml:lang": lang } : {},
                "text",
              ),
        );
        await expect(xmpp.send(stanza)).rejects.toBeInstanceOf(TypeError);

        // Ordered receipt of this frame proves no earlier invalid write escaped.
        await xmpp.send(xml("message", { id: "barrier" }));
        expect(readFrame(await peer.next())[0]).toMatchObject({
          open: "{jabber:client}message",
          attributes: { "{}id": "barrier" },
        });
        expect(sent).toEqual(["barrier"]);
        expect(
          peer.transcript.some((frame) => frame.includes('id="invalid"')),
        ).toBe(false);
      },
    );
  }

  test("§8.1.5: sendMany rejects the invalid element before emission, preserving earlier valid writes", async () => {
    await connectStream();
    await xmpp.open(xmpp.options);
    await peer.next();
    await expect(
      xmpp.sendMany([
        xml("message", { id: "first", "xml:lang": "pl" }),
        xml("presence", { id: "invalid", "xml:lang": "en_US" }),
        xml("message", { id: "last", "xml:lang": "fr" }),
      ]),
    ).rejects.toBeInstanceOf(TypeError);
    await xmpp.send(xml("message", { id: "barrier" }));
    for (const id of ["first", "barrier"]) {
      expect(readFrame(await peer.next())[0]).toMatchObject({
        attributes: { "{}id": id },
      });
    }
    expect(peer.transcript).toHaveLength(3);
  });

  test("§4.7.4 / RFC 5646 §§2.1–2.2: preserve all grandfathered and ordinary stream tag alternatives", async () => {
    await connectStream();
    const languages = [
      ...GRANDFATHERED,
      "EN",
      "es-419",
      "zh-cmn-Hans-CN",
      "sl-rozaj-biske-1994",
      "en-u-ca-gregory",
      "x-a-PRIVATE",
      "en-x-u-ca-u-ca",
    ];
    for (const [index, lang] of languages.entries()) {
      if (index > 0) {
        Object.assign(xmpp.options, { lang });
        await xmpp.restart();
      } else {
        await xmpp.open({ domain: "example.test", lang });
      }
      expect(readFrame(await peer.next())[0]).toMatchObject({
        open: `{${FRAMING}}open`,
        attributes: { [`{${XML}}lang`]: lang },
      });
    }
  });

  test("§8.1.5 / RFC 5646 §2.1: preserve grandfathered, private-use and extension stanza tags", async () => {
    await connectStream();
    await xmpp.open(xmpp.options);
    await peer.next();
    for (const lang of [
      ...GRANDFATHERED.map((tag) => tag.toUpperCase()),
      "de-CH-1901",
      "qaa-Qaaa-QM",
      "en-u-ca-gregory-x-u-u",
      "x-1901-1901",
    ]) {
      await xmpp.send(xml("message", { "xml:lang": lang }));
      expect(readFrame(await peer.next())[0]).toMatchObject({
        attributes: { [`{${XML}}lang`]: lang },
      });
    }
  });

  // XML 1.0 §2.12 empty resets are existing behavior. RFC 6120's NMTOKEN
  // overlap and incoming language policy remain separate audit boundaries.
  test("§8.1.5 / XML §2.12: preserve explicit overrides, absent tags and empty resets", async () => {
    await connectStream();
    await xmpp.open({ domain: "example.test" });
    expect(readFrame(await peer.next())).toEqual(
      readFrame(`<open version="1.0" xmlns="${FRAMING}" to="example.test"/>`),
    );
    await xmpp.send(
      xml(
        "message",
        { "xml:lang": "pl" },
        xml("body", {}, "inherited"),
        xml("body", { "xml:lang": "fr" }, "override"),
        xml(
          "extra",
          { xmlns: EXTENSION, "xml:lang": "" },
          xml("label", {}, "reset"),
          xml("label", { "xml:lang": "x-private" }, "override"),
        ),
      ),
    );
    const elements = readFrame(await peer.next()).filter(
      (event) => "open" in event,
    );
    const languages = elements.map(
      (event): string | undefined => event.attributes[`{${XML}}lang`],
    );
    expect(languages).toEqual([
      "pl",
      undefined,
      "fr",
      "",
      undefined,
      "x-private",
    ]);
    await xmpp.sendMany([xml("presence"), xml("message", { "xml:lang": "" })]);
    expect(readFrame(await peer.next())).toEqual(
      readFrame('<presence xmlns="jabber:client"/>'),
    );
    expect(readFrame(await peer.next())[0]).toMatchObject({
      attributes: { [`{${XML}}lang`]: "" },
    });
  });

  test("§8.1.5 audit boundary: incoming language remains raw and document-local", async () => {
    await connectStream();
    await xmpp.open(xmpp.options);
    await peer.next();
    const received: Array<string | undefined> = [];
    xmpp.on("stanza", (element: Element) =>
      received.push(element.attrs["xml:lang"]),
    );
    const barrier = once(xmpp, "nonza", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    peer.send('<message xmlns="jabber:client" xml:lang="not a tag"/>');
    peer.send('<message xmlns="jabber:client"/>');
    peer.send(`<barrier xmlns="${EXTENSION}"/>`);
    await barrier;
    expect(received).toEqual(["not a tag", undefined]);
  });
});
