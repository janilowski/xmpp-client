import { expect, test } from "bun:test";
import parseDocument, {
  validateDocument,
  XML_CONTEXT,
  XML_DIRECTION,
} from "../lib/parseDocument.js";

// RFC 6120 §11.3 requires both XMPP directions to be namespace-well-formed.
// Namespaces 1.0 §§2.1/2.3/3 uses RFC 3986 URI references, not IRI or URL
// normalization. Relative references are deprecated, not prohibited.
// https://www.w3.org/TR/REC-xml-names/#ns-decl
const INVALID = [
  " urn:example",
  "urn:example ",
  "urn:bad space",
  "urn:bad&#x9;tab",
  "urn:bad&#xA;line",
  "urn:bad&#xD;return",
  "urn:bad%",
  "urn:bad%0",
  "urn:bad%GG",
  "urn:bad\\path",
  "urn:bad|path",
  "urn:bad{path}",
  "urn:żółć",
  "1scheme:value",
  ":relative",
  "//[not-an-ip]/path",
  "//host:port/path",
];
const VALID = [
  "urn:example:namespace",
  "relative/path",
  "relative/path:segment",
  "../namespace",
  "/path:segment",
  "?query=value",
  "#fragment",
  "//host/path",
  "//[2001:db8::1]:443/path",
  "http://user:password@host:80/path?x=1&amp;y=2#fragment",
  "urn:example:%7e",
  "urn:example:%7E",
  "URN:EXAMPLE:namespace",
  "urn:example:%C5%BC",
];

test.each(INVALID)("XMPP namespace URI rejects %j before output", (uri) => {
  const source = `<root xmlns:p="${uri}"/>`;
  expect(() => validateDocument(source, XML_CONTEXT.XMPP)).toThrow();
  expect(() =>
    parseDocument(source, XML_CONTEXT.XMPP, XML_DIRECTION.OUTPUT),
  ).toThrow();
});

test.each(INVALID)("XMPP namespace URI rejects %j before input", (uri) => {
  expect(() =>
    parseDocument(`<root xmlns:p="${uri}"/>`, XML_CONTEXT.XMPP),
  ).toThrow();
});

test.each(VALID)("XMPP namespace URI preserves %j", (uri) => {
  const source = `<root xmlns:p="${uri}"><p:child/></root>`;
  const expected = uri.replaceAll("&amp;", "&");
  expect(() => validateDocument(source, XML_CONTEXT.XMPP)).not.toThrow();
  for (const direction of [XML_DIRECTION.INPUT, XML_DIRECTION.OUTPUT]) {
    const root = parseDocument(source, XML_CONTEXT.XMPP, direction)!;
    expect(root.attrs["xmlns:p"]).toBe(expected);
    expect(root.getChild("child", expected)?.getNS()).toBe(expected);
  }
});

test("XMPP namespace URI preserves default cancellation", () => {
  const source = '<root xmlns="urn:example"><child xmlns=""/></root>';
  expect(() => validateDocument(source, XML_CONTEXT.XMPP)).not.toThrow();
  expect(
    parseDocument(source, XML_CONTEXT.XMPP)!.getChild("child")?.getNS(),
  ).toBe("");
});

test("generic XML processor URI checking remains separate", () => {
  const source = '<root xmlns="urn:bad space"/>';
  for (const context of [XML_CONTEXT.DOCUMENT, XML_CONTEXT.HTTP]) {
    expect(parseDocument(source, context)!.getNS()).toBe("urn:bad space");
    expect(() => validateDocument(source, context)).not.toThrow();
  }
});
