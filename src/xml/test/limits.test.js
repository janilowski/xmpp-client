import { expect, test } from "bun:test";
import parseDocument from "../lib/parseDocument.js";

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
