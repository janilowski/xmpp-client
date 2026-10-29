import { expect, test } from "bun:test";
import parseDocument, {
  XML_CONTEXT,
  XML_DIRECTION,
} from "../lib/parseDocument.js";

// Local resource policy, not a size/depth mandated by RFC 7395.
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;

test("document byte limit accepts its boundary and counts UTF-8", () => {
  const prefix = "<root>";
  const suffix = "</root>";
  const capacity = MAX_BYTES - prefix.length - suffix.length;
  expect(parseDocument(prefix + "a".repeat(capacity) + suffix).name).toBe(
    "root",
  );
  expect(() => {
    parseDocument(prefix + "a".repeat(capacity + 1) + suffix);
  }).toThrow("size limit");
  expect(() => {
    parseDocument(prefix + "ą".repeat(capacity) + suffix);
  }).toThrow("size limit");
});

test("document depth limit accepts its boundary and rejects the next level", () => {
  expect(
    parseDocument("<x>".repeat(MAX_DEPTH) + "</x>".repeat(MAX_DEPTH)).name,
  ).toBe("x");
  expect(() => {
    parseDocument("<x>".repeat(MAX_DEPTH + 1) + "</x>".repeat(MAX_DEPTH + 1));
  }).toThrow("depth limit");
});

test.each([
  ["bytes", `<root>${"ą".repeat(MAX_BYTES)}</root>`],
  ["depth", "<x>".repeat(MAX_DEPTH) + "<x/>" + "</x>".repeat(MAX_DEPTH)],
])(
  "generated output trees do not acquire receive %s limits",
  (_name, source) => {
    const tree = parseDocument(source, XML_CONTEXT.XMPP, XML_DIRECTION.OUTPUT);
    expect(tree.toString()).toBe(source);
    expect(() => parseDocument(source, XML_CONTEXT.XMPP)).toThrow("limit");
    expect(() => parseDocument(source, XML_CONTEXT.XMPP, "unknown")).toThrow(
      "limit",
    );
  },
);

test("output tree construction retains XMPP grammar restrictions", () => {
  expect(() =>
    parseDocument(
      "<x><!-- forbidden --></x>",
      XML_CONTEXT.XMPP,
      XML_DIRECTION.OUTPUT,
    ),
  ).toThrow("Prohibited XML");
  expect(() =>
    parseDocument(
      "<?xml version='1.0' standalone='yes'?><x/>",
      XML_CONTEXT.XMPP,
      XML_DIRECTION.OUTPUT,
    ),
  ).toThrow("standalone");
});
