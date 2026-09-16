import { expect, test } from "bun:test";
import Parser from "../lib/FramedParser.js";

const OPEN = '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';

test.each([
  '<message xmlns="jabber:client">',
  '<message xmlns="jabber:client"/><presence xmlns="jabber:client"/>',
  '<message xmlns="jabber:client"/>garbage',
  '<message xmlns="jabber:client"/><!--',
  '<message xmlns="jabber:client" id="a" id="b"/>',
  "<stream:features/>",
  '<message xmlns="jabber:client"><body>&undefined;</body></message>',
  '<message xmlns="jabber:client"><body>&#0;</body></message>',
  '<!DOCTYPE message><message xmlns="jabber:client"/>',
  '<!--comment--><message xmlns="jabber:client"/>',
  '<?app instruction?><message xmlns="jabber:client"/>',
  '<?xml version="1.1"?><message xmlns="jabber:client"/>',
  '<?xml version="1.0" encoding="ISO-8859-1"?><message xmlns="jabber:client"/>',
  ' <message xmlns="jabber:client"/>',
  "",
])(
  "rejects a whole malformed frame before delivering any element: %s",
  (frame) => {
    const parser = new Parser();
    const elements = [];
    const errors = [];
    parser.on("element", (element) => elements.push(element));
    parser.on("error", (error) => errors.push(error));
    parser.write(OPEN);
    parser.write(frame);
    expect(errors).toHaveLength(1);
    expect(elements).toEqual([]);
  },
);

test.each(['<open xmlns="urn:wrong"/>', '<close xmlns="urn:wrong"/>'])(
  "reports invalid-namespace for a wrong framing namespace: %s",
  (frame) => {
    const parser = new Parser();
    const errors = [];
    parser.on("error", (error) => errors.push(error));
    parser.write(frame);
    expect(errors).toHaveLength(1);
    expect(errors[0].condition).toBe("invalid-namespace");
  },
);

test("accepts complete declarations, CDATA and numeric references", () => {
  const parser = new Parser();
  const elements = [];
  parser.on("element", (element) => elements.push(element));
  parser.write(OPEN);
  parser.write(
    '<?xml version="1.0" encoding="UTF-8"?><message xmlns="jabber:client"><body><![CDATA[<text>]]>&#65;&#x1F426;</body></message>',
  );
  parser.write(CLOSE);
  expect(elements).toHaveLength(1);
  expect(elements[0].getChildText("body")).toBe("<text>A🐦");
});

test("never inherits namespace bindings from another frame", () => {
  const parser = new Parser();
  const errors = [];
  parser.on("error", (error) => errors.push(error));
  parser.write(
    '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" xmlns:s="http://etherx.jabber.org/streams"/>',
  );
  parser.write("<s:features/>");
  expect(errors).toHaveLength(1);
});

test("rejects an element before open and a second open without restart", () => {
  for (const frames of [["<message xmlns='jabber:client'/>"], [OPEN, OPEN]]) {
    const parser = new Parser();
    const errors = [];
    const elements = [];
    parser.on("error", (error) => errors.push(error));
    parser.on("element", (element) => elements.push(element));
    for (const frame of frames) {
      parser.write(frame);
    }
    expect(errors).toHaveLength(1);
    expect(elements).toEqual([]);
  }
});

test("does not deliver buffered stanzas after a peer closes", () => {
  const parser = new Parser();
  const elements = [];
  parser.on("element", (element) => elements.push(element));
  parser.write(OPEN);
  parser.write(CLOSE);
  parser.write('<message xmlns="jabber:client"/>');
  expect(elements).toEqual([]);
});
