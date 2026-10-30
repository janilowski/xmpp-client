import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { client, xml } from "../src/client/index.js";
// @ts-expect-error ltx does not ship TypeScript declarations.
import { Element as ExternalElement } from "ltx";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const CONTENT = "jabber:client";
const SM = "urn:xmpp:sm:3";
const XML = "http://www.w3.org/XML/1998/namespace";
const EXTENSION = "urn:example:language-test";
const TIMEOUT_MS = 500;

let peer: ScriptedPeer;
let xmpp: ReturnType<typeof client>;
let errors: Error[];

// Default to paused authentication so negotiation cannot disguise leaked stanzas.
async function connectStream(
  lang: string | undefined = "en",
  mode: "paused" | "managed" = "paused",
) {
  let authenticated = false;
  const enabled = Promise.withResolvers<void>();
  peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!root || !("open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="language"/>`,
      );
      if (mode === "managed") {
        remote.send(
          `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
        );
      }
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      frame.includes(`<bind xmlns="${BIND}"`)
    ) {
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      remote.send(
        `<enabled xmlns="${SM}" id="language-session" resume="true"/>`,
      );
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  errors = [];
  xmpp = client({
    service: peer.url,
    domain: "example.test",
    lang,
    timeout: TIMEOUT_MS,
    ...(mode === "managed" ? { username: "user", password: "secret" } : {}),
  });
  xmpp.reconnect.stop();
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("nonza", (element: Element) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    }
  });
  await xmpp.connect(peer.url);
  if (mode === "managed") {
    await xmpp.open(xmpp.options);
    await enabled.promise;
    await xmpp.send(xml("sync", { xmlns: EXTENSION }));
    while (!(await peer.next()).startsWith("<sync ")) {
      // Observe the later frame before asserting the committed SM state.
    }
    expect(xmpp.status).toBe("online");
    expect(xmpp.streamManagement.enabled).toBe(true);
  }
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

describe("RFC 6120 §8.1.5 / XML §2.12 — incoming application boundary", () => {
  test("open/stanza events preserve input defaults, descendant overrides and fresh-stream context", async () => {
    const defaults = ["pl", "fr", undefined, "cs"];
    let openings = 0;
    const reply = (frame: string, remote: ScriptedPeer) => {
      const root = readFrame(frame)[0];
      if (!("open" in root)) {
        throw new Error("Expected a client element");
      }
      if (root.open === `{${FRAMING}}open`) {
        const lang = defaults[openings++];
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="incoming-language"${lang === undefined ? "" : ` xml:lang="${lang}"`}/>`,
        );
      } else if (root.open === `{${FRAMING}}close`) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    };
    peer = new ScriptedPeer(reply);
    errors = [];
    xmpp = client({
      service: peer.url,
      domain: "example.test",
      lang: "de",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.on("error", (error: Error) => errors.push(error));
    let inputLanguage: string | undefined;
    const headers: Array<string | undefined> = [];
    const received: Array<{
      id: string;
      effective: Array<string | undefined>;
      declared: Array<string | undefined>;
    }> = [];
    xmpp.on("open", (header: Element) => {
      inputLanguage = header.attrs["xml:lang"];
      headers.push(inputLanguage);
    });

    // Selection belongs to this consuming application, not a hidden parser API.
    // The library must preserve the source tree and the ordered input headers.
    function language(element: Element): string | undefined {
      for (
        let current: Element | null = element;
        current;
        current = current.parent
      ) {
        if (Object.hasOwn(current.attrs, "xml:lang")) {
          return current.attrs["xml:lang"];
        }
      }
      return inputLanguage;
    }
    xmpp.on("stanza", (stanza: Element) => {
      const targets = [
        ...stanza.getChildren("body", CONTENT),
        ...(stanza
          .getChild("extra", EXTENSION)
          ?.getChildren("label", EXTENSION) ?? []),
      ];
      received.push({
        id: stanza.attrs.id,
        effective: targets.map(language),
        declared: targets.map((element) => element.attrs["xml:lang"]),
      });
    });

    const stages = [
      [
        `<message xmlns="${CONTENT}" id="default"><body>Polski</body></message>`,
        `<message xmlns="${CONTENT}" id="root-override" xml:lang="en"><body>English</body></message>`,
        `<message xmlns="${CONTENT}" id="overrides" xml:lang="en"><body xml:lang="de-CH">Deutsch</body><extra xmlns="${EXTENSION}" xml:lang=""><label>No language</label><label xml:lang="x-private">Private</label></extra></message>`,
      ],
      [
        `<message xmlns="${CONTENT}" id="restarted"><body>Français</body></message>`,
      ],
      [
        `<message xmlns="${CONTENT}" id="absent"><body>Unknown</body></message>`,
      ],
      [
        `<message xmlns="${CONTENT}" id="new-transport"><body>Čeština</body></message>`,
      ],
    ];
    await xmpp.connect(peer.url);
    for (const [stage, frames] of stages.entries()) {
      if (stage === 0) {
        await xmpp.open(xmpp.options);
      } else if (stage === stages.length - 1) {
        await xmpp.stop();
        await peer.stop();
        peer = new ScriptedPeer(reply);
        await xmpp.connect(peer.url);
        await xmpp.open(xmpp.options);
      } else {
        await xmpp.restart();
      }
      await peer.next();
      const barrier = once(xmpp, "nonza", {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      for (const frame of frames) {
        peer.send(frame);
      }
      peer.send(`<barrier xmlns="${EXTENSION}"/>`);
      await barrier;
    }
    expect(headers).toEqual(["pl", "fr", undefined, "cs"]);
    expect(received).toEqual([
      { id: "default", effective: ["pl"], declared: [undefined] },
      { id: "root-override", effective: ["en"], declared: [undefined] },
      {
        id: "overrides",
        effective: ["de-CH", "", "x-private"],
        declared: ["de-CH", undefined, "x-private"],
      },
      { id: "restarted", effective: ["fr"], declared: [undefined] },
      { id: "absent", effective: [undefined], declared: [undefined] },
      { id: "new-transport", effective: ["cs"], declared: [undefined] },
    ]);
  });
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
    for (const origin of ["tree", "serialized document"] as const) {
      test.each(["message", "presence", "iq"] as const)(
        `§8.1.5: ${method} rejects an empty core root language without send or SM admission / ${origin} / %s`,
        async (kind) => {
          await connectStream("en", "managed");
          const value = xml(
            kind,
            {
              id: "invalid-root",
              "xml:lang": origin === "tree" ? "" : "pl",
              ...(kind === "iq" ? { type: "get" } : {}),
            },
            kind === "iq" ? xml("query", { xmlns: EXTENSION }) : undefined,
          );
          if (origin === "serialized document") {
            value.toString = () =>
              `<${kind} xmlns="${CONTENT}" id="invalid-root" xml:lang=""${kind === "iq" ? ' type="get"' : ""}>${kind === "iq" ? `<query xmlns="${EXTENSION}"/>` : ""}</${kind}>`;
          }
          const sent: string[] = [];
          const failures: string[] = [];
          xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
          xmpp.streamManagement.on("fail", (element: Element) =>
            failures.push(element.attrs.id),
          );
          const result = await (
            method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
          ).catch((error: Error) => error);
          expect(result).toBeInstanceOf(TypeError);

          // A later foreign frame proves delivery without adding a core queue item.
          await xmpp.send(xml("barrier", { xmlns: EXTENSION, id: "barrier" }));
          expect(readFrame(await peer.next())[0]).toMatchObject({
            open: `{${EXTENSION}}barrier`,
            attributes: { "{}id": "barrier" },
          });
          expect(sent).toEqual(["barrier"]);
          expect(failures).toEqual([]);
          expect(xmpp.streamManagement.outbound_q).toEqual([]);
          expect(
            peer.transcript.some((frame) => frame.includes("invalid-root")),
          ).toBe(false);
          expect(xmpp.status).toBe("online");

          // Local rejection leaves this negotiated session usable and accountable.
          await xmpp.send(
            xml("message", { id: "valid-root", "xml:lang": "pl" }),
          );
          expect(readFrame(await peer.next())[0]).toMatchObject({
            open: `{${CONTENT}}message`,
            attributes: { "{}id": "valid-root", [`{${XML}}lang`]: "pl" },
          });
          expect(sent).toEqual(["barrier", "valid-root"]);
          expect(
            xmpp.streamManagement.outbound_q.map(
              ({ stanza }: { stanza: Element }) => stanza.attrs.id,
            ),
          ).toEqual(["valid-root"]);
        },
      );
    }

    test(`§8.1.5 / XML §2.12: ${method} preserves empty descendant and foreign-root resets`, async () => {
      await connectStream("en", "managed");
      const values = [
        xml(
          "message",
          { id: "core-reset", "xml:lang": "pl" },
          xml("body", { "xml:lang": "" }, "reset"),
          xml(
            "extra",
            { xmlns: EXTENSION, "xml:lang": "" },
            xml("label", {}, "reset"),
          ),
        ),
        xml("notice", {
          xmlns: EXTENSION,
          id: "foreign-reset",
          "xml:lang": "",
        }),
      ];
      let failure: unknown;
      try {
        if (method === "sendMany") {
          await xmpp.sendMany(values);
        } else {
          for (const value of values) {
            await xmpp.send(value);
          }
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeUndefined();
      expect(readFrame(await peer.next())).toEqual(
        readFrame(
          `<message xmlns="${CONTENT}" id="core-reset" xml:lang="pl"><body xml:lang="">reset</body><extra xmlns="${EXTENSION}" xml:lang=""><label>reset</label></extra></message>`,
        ),
      );
      expect(readFrame(await peer.next())).toEqual(
        readFrame(
          `<notice xmlns="${EXTENSION}" id="foreign-reset" xml:lang=""/>`,
        ),
      );
      expect(
        xmpp.streamManagement.outbound_q.map(
          ({ stanza }: { stanza: Element }) => stanza.attrs.id,
        ),
      ).toEqual(["core-reset"]);
    });
  }

  test("§8.1.5: sendMany stops at an empty root language and retains earlier valid ownership", async () => {
    await connectStream("en", "managed");
    const sent: string[] = [];
    xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
    const result = await xmpp
      .sendMany([
        xml("message", { id: "first", "xml:lang": "pl" }),
        xml("presence", { id: "invalid-root", "xml:lang": "" }),
        xml("message", { id: "last", "xml:lang": "fr" }),
      ])
      .catch((error: Error) => error);
    expect(result).toBeInstanceOf(TypeError);
    await xmpp.send(xml("message", { id: "barrier" }));
    for (const id of ["first", "barrier"]) {
      expect(readFrame(await peer.next())[0]).toMatchObject({
        attributes: { "{}id": id },
      });
    }
    expect(sent).toEqual(["first", "barrier"]);
    expect(
      xmpp.streamManagement.outbound_q.map(
        ({ stanza }: { stanza: Element }) => stanza.attrs.id,
      ),
    ).toEqual(["first", "barrier"]);
    expect(
      peer.transcript.some(
        (frame) =>
          frame.includes("invalid-root") || frame.includes('id="last"'),
      ),
    ).toBe(false);
  });

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

  test.each(["", ...MALFORMED])(
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

  // Preserve the option preflight contract independently of valid serialized bytes.
  test.each(["en_US", ""])(
    "§4.7.4 profile: reject invalid configuration before a serializer can conceal it / %j",
    async (lang) => {
      await connectStream(lang);
      const source = `<open xmlns="${FRAMING}" to="example.test" version="1.0" xml:lang="en"/>`;
      let calls = 0;
      const statuses: string[] = [];
      xmpp.on("status", (status: string) => statuses.push(status));
      xmpp.header = () => {
        calls += 1;
        return source;
      };

      await expect(xmpp.open(xmpp.options)).rejects.toBeInstanceOf(TypeError);
      expect(calls).toBe(0);
      expect(peer.transcript).toEqual([]);
      expect(xmpp.status).toBe("connect");
      expect(xmpp.parser).toBeNull();
      expect(statuses).toEqual([]);

      await xmpp.open({ domain: "example.test", lang: "en" });
      expect(await peer.next()).toBe(source);
      expect(calls).toBe(1);
      expect(peer.transcript).toEqual([source]);
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

  // XML 1.0 §2.12 permits descendant resets; RFC 6120 restricts core roots.
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
    await xmpp.sendMany([
      xml("presence"),
      xml("message", {}, xml("body", { "xml:lang": "" }, "reset")),
    ]);
    expect(readFrame(await peer.next())).toEqual(
      readFrame('<presence xmlns="jabber:client"/>'),
    );
    expect(readFrame(await peer.next())).toEqual(
      readFrame(
        `<message xmlns="${CONTENT}"><body xml:lang="">reset</body></message>`,
      ),
    );
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
    peer.send('<message xmlns="jabber:client" xml:lang=""/>');
    peer.send('<message xmlns="jabber:client" xml:lang="not a tag"/>');
    peer.send('<message xmlns="jabber:client"/>');
    peer.send(`<barrier xmlns="${EXTENSION}"/>`);
    await barrier;
    expect(received).toEqual(["", "not a tag", undefined]);
  });
});
