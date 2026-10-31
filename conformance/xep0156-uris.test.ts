import { afterEach, expect, spyOn, test } from "bun:test";
import { resolve } from "../src/resolve/lib/http.js";

// XRD 1.0 §§1.5.2/2.6: href has XML Schema 1.0 anyURI semantics.
// XML Schema §§3.2.17.1/4.3.6: collapse XML whitespace, then XLink §5.4
// escapes excluded characters; a reverse solidus is not a path separator.
// https://docs.oasis-open.org/xri/xrd/v1.0/xrd-1.0.html
// https://www.w3.org/TR/xmlschema-2/#anyURI
// https://www.w3.org/TR/2001/REC-xlink-20010627/#link-locators
// These are endpoint-identity tests, not general XSD or URI validation.
const ROOT = "wss://host.test";
const RELATION = "urn:xmpp:alt-connections:websocket";
let fetchMock: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchMock?.mockRestore());

const vectors = [
  ["reverse solidus in path", `${ROOT}/a\\b`, `${ROOT}/a\\b`, `${ROOT}/a%5Cb`],
  [
    "reverse solidus in query",
    `${ROOT}/?q=a\\b`,
    `${ROOT}/?q=a\\b`,
    `${ROOT}/?q=a%5Cb`,
  ],
  [
    "escaped reverse solidus",
    `${ROOT}/a%5Cb`,
    `${ROOT}/a%5Cb`,
    `${ROOT}/a%5Cb`,
  ],
  [
    "lowercase escaped reverse solidus",
    `${ROOT}/a%5cb`,
    `${ROOT}/a%5cb`,
    `${ROOT}/a%5cb`,
  ],
  ["space in path", `${ROOT}/a b`, `${ROOT}/a b`, `${ROOT}/a%20b`],
  ["collapsed space run", `${ROOT}/a   b`, `${ROOT}/a   b`, `${ROOT}/a%20b`],
  [
    "trimmed XML whitespace",
    ` &#x9;${ROOT}/a&#xD; `,
    ` \t${ROOT}/a\r `,
    `${ROOT}/a`,
  ],
  [
    "character-reference tab",
    `${ROOT}/a&#x9;b`,
    `${ROOT}/a\tb`,
    `${ROOT}/a%20b`,
  ],
  [
    "character-reference LF",
    `${ROOT}/a&#xA;b`,
    `${ROOT}/a\nb`,
    `${ROOT}/a%20b`,
  ],
  [
    "character-reference CR",
    `${ROOT}/a&#xD;b`,
    `${ROOT}/a\rb`,
    `${ROOT}/a%20b`,
  ],
  [
    "mixed XML whitespace run",
    `${ROOT}/a &#x9;&#xA;&#xD; b`,
    `${ROOT}/a \t\n\r b`,
    `${ROOT}/a%20b`,
  ],
  [
    "non-ASCII is not XML whitespace",
    `${ROOT}/a\u00a0b`,
    `${ROOT}/a\u00a0b`,
    `${ROOT}/a%C2%A0b`,
  ],
  [
    "Unicode path",
    `${ROOT}/żółć`,
    `${ROOT}/żółć`,
    `${ROOT}/%C5%BC%C3%B3%C5%82%C4%87`,
  ],
  [
    "escaped Unicode path",
    `${ROOT}/%C5%BC%C3%B3%C5%82%C4%87`,
    `${ROOT}/%C5%BC%C3%B3%C5%82%C4%87`,
    `${ROOT}/%C5%BC%C3%B3%C5%82%C4%87`,
  ],
  [
    "excluded ASCII",
    `${ROOT}/&lt;&gt;&quot;{}|^\u0060`,
    `${ROOT}/<>"{}|^\u0060`,
    `${ROOT}/%3C%3E%22%7B%7D%7C%5E%60`,
  ],
  [
    "structural delimiters",
    `${ROOT}/a/b:c@d;e?x=1&amp;y=2`,
    `${ROOT}/a/b:c@d;e?x=1&y=2`,
    `${ROOT}/a/b:c@d;e?x=1&y=2`,
  ],
  [
    "escaped delimiters",
    `${ROOT}/%2F%3F%23%25%5C?q=%2f%3f%23%25%5c`,
    `${ROOT}/%2F%3F%23%25%5C?q=%2f%3f%23%25%5c`,
    `${ROOT}/%2F%3F%23%25%5C?q=%2f%3f%23%25%5c`,
  ],
] as const;

for (const [name, attribute, href, uri] of vectors) {
  test(`XEP-0156 / XRD anyURI identity: ${name}`, async () => {
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="${RELATION}" href="${attribute}"/></XRD>`,
      ),
    );
    // href preserves the XML attribute snapshot; uri is safe transport syntax.
    expect(await resolve("example.test")).toEqual([
      { rel: RELATION, href, method: "websocket", uri },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}

test("XRD anyURI relation collapses XML whitespace before method selection", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel=" &#x9;${RELATION}&#xD; " href="${ROOT}/a"/></XRD>`,
    ),
  );
  expect(await resolve("example.test")).toEqual([
    {
      rel: ` \t${RELATION}\r `,
      href: `${ROOT}/a`,
      method: "websocket",
      uri: `${ROOT}/a`,
    },
  ]);
});

test("XRD anyURI relation does not trim non-XML whitespace", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="\u00a0${RELATION}\u00a0" href="${ROOT}/a"/></XRD>`,
    ),
  );
  expect(await resolve("example.test")).toEqual([]);
});
