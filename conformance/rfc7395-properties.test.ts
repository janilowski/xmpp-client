import { expect, test } from "bun:test";
import fc from "fast-check";
import { once } from "node:events";
import { client } from "../src/client/index.js";
import Parser from "../src/websocket/lib/FramedParser.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";

const NS_CLIENT = "jabber:client";
const NS_EXTENSION = "urn:test:property";
const NS_FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const PROPERTY_SEED = 0x7395;
const VALID_RUNS = 64;
const PUBLIC_RUNS = 8;
const INVALID_RUNS_PER_KIND = 8;
const MAX_XML_BYTES = 1024 * 1024;
const MAX_XML_DEPTH = 64;
const EVENT_TIMEOUT_MS = 2000;

const declarations = fc.constantFrom(
  "",
  '<?xml version="1.0"?>',
  "<?xml version='1.0' encoding='UTF-8'?>",
  '<?xml version="1.0" encoding="utf-8"?>',
);
const quotes = fc.constantFrom('"', "'");
const xmlCharacter = fc.oneof(
  fc.constantFrom(0x9, 0xa, 0xd),
  fc.integer({ min: 0x20, max: 0xd7ff }),
  fc.integer({ min: 0xe000, max: 0xfffd }),
  fc.integer({ min: 0x10000, max: 0x10ffff }),
);
const text = fc
  .array(xmlCharacter, { maxLength: 16 })
  .map((codePoints) => String.fromCodePoint(...codePoints));

type DocumentOptions = {
  declaration: string;
  prefixed: boolean;
  quote: string;
  reverseAttributes: boolean;
};

const documentOptions = fc.record({
  declaration: declarations,
  prefixed: fc.boolean(),
  quote: quotes,
  reverseAttributes: fc.boolean(),
});

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function escapeAttribute(value: string, quote: string) {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return quote === '"'
    ? escaped.replaceAll('"', "&quot;")
    : escaped.replaceAll("'", "&apos;");
}

function attribute(name: string, value: string, quote: string) {
  return `${name}=${quote}${escapeAttribute(value, quote)}${quote}`;
}

function framingDocument(
  name: "open" | "close",
  options: DocumentOptions,
  attributes: Array<[string, string]> = [],
) {
  const prefix = options.prefixed ? "f:" : "";
  const namespace = attribute(
    options.prefixed ? "xmlns:f" : "xmlns",
    NS_FRAMING,
    options.quote,
  );
  const serialized = attributes.map(([key, value]) =>
    attribute(key, value, options.quote),
  );
  const ordered = options.reverseAttributes
    ? [...serialized].reverse().concat(namespace)
    : [namespace, ...serialized];

  return `${options.declaration}<${prefix}${name} ${ordered.join(" ")}/>`;
}

function stanzaDocument(options: DocumentOptions, id: string, body: string) {
  const namespace = attribute("xmlns", NS_CLIENT, options.quote);
  const serializedId = attribute("id", id, options.quote);
  const attributes = options.reverseAttributes
    ? [serializedId, namespace]
    : [namespace, serializedId];
  const extensionNamespace = attribute(
    options.prefixed ? "xmlns:e" : "xmlns",
    NS_EXTENSION,
    options.quote,
  );
  const extension = options.prefixed
    ? `<e:meta ${extensionNamespace}/>`
    : `<meta ${extensionNamespace}/>`;

  return `${options.declaration}<message ${attributes.join(" ")}><body>${escapeText(body)}</body>${extension}</message>`;
}

const validExchange = fc.record({
  opening: documentOptions,
  stanza: documentOptions,
  closing: documentOptions,
  version: fc.constantFrom("1.0", "01.00", "1.13"),
  id: text,
  body: text,
});
test("RFC 7395 §§3.2–3.3: equivalent standalone documents preserve events", () => {
  const result = fc.check(
    fc.property(validExchange, (model) => {
      const parser = new Parser();
      const starts: Element[] = [];
      const elements: Element[] = [];
      const ends: Element[] = [];
      const errors: Error[] = [];
      parser.on("start", (element) => starts.push(element));
      parser.on("element", (element) => elements.push(element));
      parser.on("end", (element) => ends.push(element));
      parser.on("error", (error) => errors.push(error));
      parser.write(
        framingDocument("open", model.opening, [
          ["version", model.version],
          ["from", "example.test"],
          ["id", "peer-id"],
        ]),
      );
      parser.write(stanzaDocument(model.stanza, model.id, model.body));
      parser.write(framingDocument("close", model.closing));

      expect(errors).toEqual([]);
      expect(starts).toHaveLength(1);
      expect(starts[0].is("open", NS_FRAMING)).toBe(true);
      expect(starts[0].attrs.version).toBe(model.version);
      expect(elements).toHaveLength(1);
      expect(elements[0].is("message", NS_CLIENT)).toBe(true);
      expect(elements[0].attrs.id).toBe(model.id.replaceAll(/[\t\n\r]/g, " "));
      expect(elements[0].getChildText("body", NS_CLIENT)).toBe(
        model.body.replaceAll(/\r\n?/g, "\n"),
      );
      expect(elements[0].getChild("meta", NS_EXTENSION)).toBeDefined();
      expect(ends).toHaveLength(1);
      expect(ends[0].is("close", NS_FRAMING)).toBe(true);
    }),
    { numRuns: VALID_RUNS, seed: PROPERTY_SEED },
  );

  expect(result).toMatchObject({ failed: false });
});

test("RFC 7395 §§3.2–3.3: generated documents cross the public WebSocket boundary", async () => {
  const result = await fc.check(
    fc.asyncProperty(validExchange, async (model) => {
      const serverOpen = framingDocument("open", model.opening, [
        ["version", model.version],
        ["from", "example.test"],
        ["id", "peer-id"],
      ]);
      const serverClose = framingDocument("close", model.closing);
      const peer = new ScriptedPeer((frame, remote) => {
        if (frame.startsWith("<open ")) {
          remote.send(serverOpen);
        } else if (frame.startsWith("<close ")) {
          remote.send(serverClose);
        }
      });
      const xmpp = client({
        domain: "example.test",
        service: peer.url,
        timeout: 250,
      });
      const errors: Error[] = [];
      xmpp.reconnect.stop();
      xmpp.on("error", (error: Error) => errors.push(error));

      try {
        await xmpp.connect(peer.url);
        await xmpp.open({ domain: "example.test" });
        const received = once(xmpp, "stanza", {
          signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
        });
        peer.send(stanzaDocument(model.stanza, model.id, model.body));
        const [element] = (await received) as [Element];

        expect(element.is("message", NS_CLIENT)).toBe(true);
        expect(element.attrs.id).toBe(model.id.replaceAll(/[\t\n\r]/g, " "));
        expect(element.getChildText("body", NS_CLIENT)).toBe(
          model.body.replaceAll(/\r\n?/g, "\n"),
        );
        expect(element.getChild("meta", NS_EXTENSION)).toBeDefined();
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        if (xmpp.status !== "offline") {
          await xmpp.stop();
        }
        await peer.stop();
      }
    }),
    { numRuns: PUBLIC_RUNS, seed: PROPERTY_SEED },
  );

  expect(result).toMatchObject({ failed: false });
});

const basicOptions: DocumentOptions = {
  declaration: "",
  prefixed: false,
  quote: '"',
  reverseAttributes: false,
};
const open = framingDocument("open", basicOptions, [["version", "1.0"]]);
const close = framingDocument("close", basicOptions);
const stanza = stanzaDocument(basicOptions, "valid", "message");
const invalidKinds = [
  "truncated",
  "extra-root",
  "trailing-data",
  "wrong-framing-namespace",
  "nonempty-framing",
  "xml-1.1",
  "doctype",
  "comment",
  "processing-instruction",
] as const;

function invalidDocument(kind: (typeof invalidKinds)[number], body: string) {
  const message = stanzaDocument(basicOptions, "invalid", body);

  switch (kind) {
    case "truncated": {
      return message.slice(0, -1);
    }
    case "extra-root": {
      return message + stanza;
    }
    case "trailing-data": {
      return `${message}x`;
    }
    case "wrong-framing-namespace": {
      return '<close xmlns="urn:wrong"/>';
    }
    case "nonempty-framing": {
      return `<close xmlns="${NS_FRAMING}"><message/></close>`;
    }
    case "xml-1.1": {
      return `<?xml version="1.1"?>${message}`;
    }
    case "doctype": {
      return `<!DOCTYPE message>${message}`;
    }
    case "comment": {
      return `<!--before-->${message}`;
    }
    case "processing-instruction": {
      return `<?before data?>${message}`;
    }
  }
}

for (const kind of invalidKinds) {
  test(`RFC 7395 §§3.2–3.3: invalid documents fail atomically and only permit close / ${kind}`, () => {
    const result = fc.check(
      fc.property(text, (body) => {
        const invalid = invalidDocument(kind, body);
        const parser = new Parser();
        const starts: Element[] = [];
        const elements: Element[] = [];
        const ends: Element[] = [];
        const errors: Error[] = [];
        parser.on("start", (element) => starts.push(element));
        parser.on("element", (element) => elements.push(element));
        parser.on("end", (element) => ends.push(element));
        parser.on("error", (error) => errors.push(error));

        parser.write(open);
        parser.write(invalid);
        parser.write(stanza);
        parser.write(close);

        expect(starts).toHaveLength(1);
        expect(errors).toHaveLength(1);
        expect(elements).toEqual([]);
        expect(ends).toHaveLength(1);
        expect(ends[0].is("close", NS_FRAMING)).toBe(true);
      }),
      { numRuns: INVALID_RUNS_PER_KIND, seed: PROPERTY_SEED },
    );

    expect(result).toMatchObject({ failed: false });
  });
}

test.each([1, 2, 3, 4])(
  "RFC 7395 §6 local XML byte limit rejects excess +%i",
  (excess) => {
    const prefix = `<message xmlns="${NS_CLIENT}"><body>`;
    const suffix = "</body></message>";
    const parser = new Parser();
    const elements: Element[] = [];
    const errors: Error[] = [];
    parser.on("element", (element) => elements.push(element));
    parser.on("error", (error) => errors.push(error));

    parser.write(open);
    parser.write(
      prefix +
        "a".repeat(MAX_XML_BYTES - prefix.length - suffix.length + excess) +
        suffix,
    );

    expect(errors).toHaveLength(1);
    expect(elements).toEqual([]);
  },
);

test.each([1, 2, 3, 4])(
  "RFC 7395 §6 local XML depth limit rejects excess +%i",
  (excess) => {
    const depth = MAX_XML_DEPTH + excess;
    const parser = new Parser();
    const elements: Element[] = [];
    const errors: Error[] = [];
    parser.on("element", (element) => elements.push(element));
    parser.on("error", (error) => errors.push(error));

    parser.write(open);
    parser.write("<x>".repeat(depth) + "</x>".repeat(depth));

    expect(errors).toHaveLength(1);
    expect(elements).toEqual([]);
  },
);
