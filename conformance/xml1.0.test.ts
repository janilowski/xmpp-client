import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import parseDocument, {
  validateDocument,
  XML_CONTEXT,
} from "../src/xml/lib/parseDocument.js";
import readXML from "../src/resolve/lib/readXML.ts";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

// XML 1.0 Fifth Edition dependency entry point, errata checked 2026-11-10.
// https://www.w3.org/TR/2008/REC-xml-20081126/
// https://www.w3.org/XML/xml-V10-5e-errata
// Literal ranges below come from productions [2], [4] and [4a], not xmlchars.
// Name ranges subtract colon for Namespaces 1.0 NCNames; existing namespace
// suites separately exercise QName prefixes and their required bindings.
// Existing rfc6120-xml/outgoing-xml suites cover XMPP restrictions, EOL and
// attribute normalization, standalone/language roles and wire recovery.
// xml-namespaces covers namespace processing; xep0156-encoding covers HTTP bytes.
// DTD-dependent/defaulted/typed/validating roles remain outside the approved
// DTD-free profile. HTTP metadata ignores comments/PIs, not their lexical errors.
// Declaration VersionNum 1.x compatibility remains a separate profile decision;
// this suite neither changes that decision nor enables XML 1.1 features.
const CLIENT = "jabber:client";
const STREAM = "http://etherx.jabber.org/streams";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const TIMEOUT_MS = 1000;
const NEGOTIATION_FRAME_BUDGET = 8;
const CONTEXTS = [XML_CONTEXT.XMPP, XML_CONTEXT.HTTP];
const CHAR_RANGES = [
  [0x9, 0xa],
  [0xd, 0xd],
  [0x20, 0xd7ff],
  [0xe000, 0xfffd],
  [0x10000, 0x10ffff],
] as const;
const NAME_START_RANGES = [
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
  [0xc0, 0xd6],
  [0xd8, 0xf6],
  [0xf8, 0x2ff],
  [0x370, 0x37d],
  [0x37f, 0x1fff],
  [0x200c, 0x200d],
  [0x2070, 0x218f],
  [0x2c00, 0x2fef],
  [0x3001, 0xd7ff],
  [0xf900, 0xfdcf],
  [0xfdf0, 0xfffd],
  [0x10000, 0xeffff],
] as const;
const NAME_EXTRA_RANGES = [
  [0x2d, 0x2e],
  [0x30, 0x39],
  [0xb7, 0xb7],
  [0x300, 0x36f],
  [0x203f, 0x2040],
] as const;

const characterEdges = new Set<number>([
  0, 0x7f, 0x85, 0xfdd0, 0xfdef, 0x1fffe, 0x10ffff,
]);
for (const [first, last] of CHAR_RANGES) {
  for (const code of [first - 1, first, last, last + 1]) {
    if (code >= 0 && code <= 0x10ffff) {
      characterEdges.add(code);
    }
  }
}
for (const code of characterEdges) {
  const label = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  const valid = CHAR_RANGES.some(
    ([first, last]) => code >= first && code <= last,
  );
  test(`XML 1.0 section 2.2 [2]: character boundary ${label}`, () => {
    const character = String.fromCodePoint(code);
    const sources = [
      `<root>${character}</root>`,
      `<root value="${character}"/>`,
      `<root>&#${code};</root>`,
      `<root>&#x${code.toString(16)};</root>`,
    ];
    for (const context of CONTEXTS) {
      for (const source of sources) {
        if (!valid) {
          expect(() => parseDocument(source, context)).toThrow();
          expect(() => validateDocument(source, context)).toThrow();
          continue;
        }
        const root = parseDocument(source, context);
        expect(root.getName()).toBe("root");
        if (source.includes("value=")) {
          expect(root.attrs.value).toBe(
            [0x9, 0xa, 0xd].includes(code) ? " " : character,
          );
        } else {
          expect(root.getText()).toBe(
            code === 0xd && !source.includes("&#") ? "\n" : character,
          );
        }
        expect(validateDocument(source, context)).toBeUndefined();
      }
    }
  });
}

const nameEdges = new Set<number>([0x3a, 0xb7, 0x300, 0x203f]);
for (const [first, last] of [...NAME_START_RANGES, ...NAME_EXTRA_RANGES]) {
  for (const code of [first - 1, first, last, last + 1]) {
    nameEdges.add(code);
  }
}
for (const code of nameEdges) {
  const label = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const position of ["start", "continuation"] as const) {
    const valid =
      NAME_START_RANGES.some(
        ([first, last]) => code >= first && code <= last,
      ) ||
      (position === "continuation" &&
        NAME_EXTRA_RANGES.some(
          ([first, last]) => code >= first && code <= last,
        ));
    test(`XML 1.0 section 2.3 [4/4a], Namespaces section 4: ${position} boundary ${label}`, () => {
      const character = String.fromCodePoint(code);
      const name = position === "start" ? `${character}x` : `n${character}x`;
      for (const context of CONTEXTS) {
        for (const source of [`<${name}/>`, `<root ${name}="value"/>`]) {
          if (!valid) {
            expect(() => parseDocument(source, context)).toThrow();
            expect(() => validateDocument(source, context)).toThrow();
            continue;
          }
          const root = parseDocument(source, context);
          expect(
            source.startsWith("<root ") ? root.attrs[name] : root.getName(),
          ).toBe(source.startsWith("<root ") ? "value" : name);
          expect(validateDocument(source, context)).toBeUndefined();
        }
      }
    });
  }
}

test("XML 1.0 sections 1.2/2.2, E01: names preserve code-point and case distinctions", () => {
  const source = "<root><A/><a/><\u00e9/><e\u0301/></root>";
  for (const context of CONTEXTS) {
    const root = parseDocument(source, context);
    expect(
      root.getChildElements().map((child: Element) => child.getName()),
    ).toEqual(["A", "a", "\u00e9", "e\u0301"]);
    expect(root.getChild("\u00e9")).not.toBe(root.getChild("e\u0301"));
    expect(validateDocument(source, context)).toBeUndefined();
  }
});

const malformed = [
  ["missing root", ""],
  ["two roots", "<root/><other/>"],
  ["text before root", "text<root/>"],
  ["text after root", "<root/>text"],
  ["mismatched end tag", "<root><child></root>"],
  ["case-changed end tag", "<root></Root>"],
  ["unclosed end tag", "<root></root"],
  ["unquoted attribute", "<root value=plain/>"],
  ["missing attribute equals", '<root value "plain"/>'],
  ["unclosed attribute", '<root value="plain/>'],
  ["missing attribute separator", '<root a="one"b="two"/>'],
  ["duplicate attribute", '<root a="one" a="two"/>'],
  ["literal less-than in attribute", '<root value="<"/>'],
  ["bare ampersand", "<root>&</root>"],
  ["CDATA terminator in character data", "<root>]]></root>"],
  ["unclosed CDATA", "<root><![CDATA[text</root>"],
  ["undefined entity", "<root>&unknown;</root>"],
  ["case-changed predefined entity", "<root>&AMP;</root>"],
  ["reference missing semicolon", "<root>&#65</root>"],
  ["empty decimal reference", "<root>&#;</root>"],
  ["empty hexadecimal reference", "<root>&#x;</root>"],
  ["uppercase reference introducer", "<root>&#X41;</root>"],
  ["negative reference", "<root>&#-1;</root>"],
  ["out-of-range reference", "<root>&#x110000;</root>"],
  ["declaration without version", "<?xml?><root/>"],
  [
    "declaration pseudo-attribute order",
    '<?xml encoding="UTF-8" version="1.0"?><root/>',
  ],
  [
    "duplicate declaration version",
    '<?xml version="1.0" version="1.0"?><root/>',
  ],
  [
    "invalid standalone value",
    '<?xml version="1.0" standalone="maybe"?><root/>',
  ],
  ["whitespace before declaration", ' <?xml version="1.0"?><root/>'],
] as const;
test.each(malformed)(
  "XML 1.0 sections 2/3/4: reject %s atomically",
  (_label, source) => {
    for (const context of CONTEXTS) {
      expect(() => parseDocument(source, context)).toThrow();
      expect(() => validateDocument(source, context)).toThrow();
    }
  },
);

test.each([
  [
    "paired tag and delimiter alternatives",
    "<root a='single \" quote' b=\"double ' quote\" >text ></root>",
    "text >",
  ],
  [
    "empty and adjacent CDATA",
    "<root><![CDATA[]]><![CDATA[<raw>&amp;]]></root>",
    "<raw>&amp;",
  ],
  [
    "predefined entities and non-reexpansion",
    "<root>&lt;&gt;&amp;&quot;&apos;&amp;lt;&#38;#65;</root>",
    "<>&\"'&lt;&#65;",
  ],
  ["leading-zero numeric references", "<root>&#00065;&#x000041;</root>", "AA"],
  [
    "declaration spacing and quoting",
    "<?xml\tversion = '1.0' encoding = 'UTF-8' ?><root/>",
    "",
  ],
] as const)("XML 1.0 sections 2/3/4: retain %s", (_label, source, expected) => {
  for (const context of CONTEXTS) {
    expect(parseDocument(source, context).getText()).toBe(expected);
    expect(validateDocument(source, context)).toBeUndefined();
  }
});

test.each([
  ["ordinary comment", "<!--<ignored>&unknown;</ignored>--><root/>", ""],
  ["empty PI", "<?instruction?><root/>", ""],
  [
    "opaque PI data",
    "<?instruction <ignored>&unknown;%parameter;?><root/>",
    "",
  ],
  [
    "mixed lexical constructs",
    "<root>A<!--ignored--><?instruction ignored?>B<![CDATA[<raw>&amp;]]>&amp;lt;</root>",
    "AB<raw>&amp;&lt;",
  ],
  [
    "prolog and epilog misc",
    "\n<!--before--><?instruction?><root> text </root><?instruction?><!--after-->\n",
    " text ",
  ],
] as const)(
  "XML 1.0 sections 2.5/2.6: HTTP metadata preserves text around %s",
  async (_label, source, expected) => {
    const root = await readXML(
      new Response(source, {
        headers: { "Content-Type": "application/xml; charset=UTF-8" },
      }),
    );
    expect(root.getName()).toBe("root");
    expect(root.getChildElements()).toEqual([]);
    expect(root.getText()).toBe(expected);
    expect(validateDocument(source, XML_CONTEXT.HTTP)).toBeUndefined();
  },
);

test.each([
  ["double hyphen in comment", "<root/><!--bad--comment-->"],
  ["comment ending in hyphen", "<root/><!--bad--->"],
  ["unclosed comment", "<root/><!--bad"],
  ["unclosed PI", "<root/><?instruction data"],
  ["missing PI target", "<root/><? ?>"],
  ["reserved PI target", "<root/><?XML data?>"],
] as const)(
  "XML 1.0 sections 2.5/2.6/5: HTTP refuses malformed %s after a valid root",
  async (_label, source) => {
    await expect(
      readXML(
        new Response(source, {
          headers: { "Content-Type": "application/xml; charset=UTF-8" },
        }),
      ),
    ).rejects.toThrow();
    expect(() => validateDocument(source, XML_CONTEXT.HTTP)).toThrow();
    const recovered = await readXML(
      new Response("<root>recovered</root>", {
        headers: { "Content-Type": "application/xml; charset=UTF-8" },
      }),
    );
    expect(recovered.getText()).toBe("recovered");
  },
);

test("XML 1.0 sections 1.2/2.1/5 / fatal XML policy: late markup exposes no post-authentication stanza", async () => {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!(root && "open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="xml-grammar"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CLIENT}}iq`) {
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
  const received: Element[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    expect((await xmpp.start()).toString()).toBe("user@example.test/r");
    const queued = peer.transcript.length;
    expect(queued).toBeLessThanOrEqual(NEGOTIATION_FRAME_BUDGET);
    for (let index = 0; index < queued; index++) {
      await peer.next();
    }
    xmpp.on("stanza", (stanza: Element) => received.push(stanza));
    peer.send(
      `<message xmlns="${CLIENT}" id="blocked"><body>not delivered</body><later></message>`,
    );
    const error = readFrame(await peer.next());
    expect(error[0]).toMatchObject({ open: `{${STREAM}}error` });
    expect(error).toContainEqual({
      open: `{${ERRORS}}not-well-formed`,
      attributes: {},
    });
    expect(readFrame(await peer.next())).toEqual(
      readFrame(`<close xmlns="${FRAMING}"/>`),
    );
    await peer.waitForClose();
    expect(received).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});
