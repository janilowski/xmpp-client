import { afterEach, expect, spyOn, test } from "bun:test";
import { resolve } from "../src/resolve/lib/http.js";

let fetchMock;
let clockMock;
afterEach(() => {
  fetchMock?.mockRestore();
  clockMock?.mockRestore();
});

// XRD 1.0 §§1.5.3, 2.2; XML Schema dateTime permits 24:00 and expanded years.
test.each([
  ["2026-09-17T12:00:01Z", true],
  ["2026-09-17T12:00:00Z", false],
  ["2026-09-17T11:59:59Z", false],
  ["2026-09-17T24:00:00Z", true],
  ["2026-09-16T24:00:00Z", false],
  ["2028-02-29T00:00:00Z", true],
  ["2100-02-29T00:00:00Z", false],
  ["2400-02-29T00:00:00Z", true],
  ["10000-02-29T00:00:00Z", true],
  ["10000-02-30T00:00:00Z", false],
  ["10000000000000000-01-01T00:00:00Z", true],
  ["-0001-01-01T00:00:00Z", false],
  ["0000-01-01T00:00:00Z", false],
  ["02028-01-01T00:00:00Z", false],
  ["2028-04-31T00:00:00Z", false],
  ["2028-00-01T00:00:00Z", false],
  ["2028-13-01T00:00:00Z", false],
  ["2028-01-00T00:00:00Z", false],
  ["2028-01-01T24:00:01Z", false],
  ["2028-01-01T25:00:00Z", false],
  ["2028-01-01T00:60:00Z", false],
  ["2028-01-01T00:00:60Z", false],
  ["2028-01-01T00:00:00.0Z", false],
  ["2028-01-01T00:00:00+00:00", false],
  ["2028-01-01T00:00:00", false],
  ["2028-01-01", false],
  ["invalid", false],
  ["", false],
  [" \n2028-01-01T00:00:00Z\t ", true],
])("XRD expiry: %s (usable: %s)", async (expiry, usable) => {
  clockMock = spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-09-17T12:00:00Z"),
  );
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(`<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
      <Expires>${expiry}</Expires>
      <Link rel="urn:xmpp:alt-connections:websocket" href="wss://host.test/xmpp"/>
    </XRD>`),
  );
  expect((await resolve("example.test")).map(({ uri }) => uri)).toEqual(
    usable ? ["wss://host.test/xmpp"] : [],
  );
});

test.each([
  "<Expires>2999-01-01T00:00:00Z</Expires><Expires>2999-01-01T00:00:00Z</Expires>",
  "<Expires>2999-01-01T00:00:00Z<extension xmlns='urn:example'/></Expires>",
])("XRD expiry rejects ambiguous content: %s", async (expires) => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(`<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
      ${expires}<Link rel="urn:xmpp:alt-connections:websocket" href="wss://host.test/xmpp"/>
    </XRD>`),
  );
  expect(await resolve("example.test")).toEqual([]);
});

test("XRD §2.6: relation and URI scheme comparisons are case-insensitive", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(`<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
      <Link rel="URN:XMPP:ALT-CONNECTIONS:WebSocket" href="WSS://HOST.test/Case?Q=Yes"/>
    </XRD>`),
  );
  expect(
    (await resolve("example.test")).map(({ method, uri }) => ({ method, uri })),
  ).toEqual([{ method: "websocket", uri: "wss://host.test/Case?Q=Yes" }]);
});

test("XRD §§2.3–3.2: metadata and extensions cannot replace host-wide links", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(`<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0" xmlns:e="urn:example">
      <Subject>https://other.test/</Subject><Alias>https://alias.test/</Alias>
      <e:Expires>2000-01-01T00:00:00Z</e:Expires>
      <e:wrapper><Link rel="urn:xmpp:alt-connections:websocket" href="wss://nested.test/"/></e:wrapper>
      <e:Link rel="urn:xmpp:alt-connections:websocket" href="wss://extension.test/"/>
      <Link rel="urn:example:unknown" href="https://unknown.test/"/>
      <Link rel="urn:xmpp:alt-connections:websocket" href="wss://host.test/xmpp">
        <Title xml:lang="en">wss://title.test/</Title><e:extension/>
      </Link>
    </XRD>`),
  );
  expect((await resolve("example.test")).map(({ uri }) => uri)).toEqual([
    "wss://host.test/xmpp",
  ]);
});

test("§2.2 XEP0156-link-order-insignificant: endpoint preference ignores document order", async () => {
  const links = [
    '<Link rel="urn:xmpp:alt-connections:websocket" href="wss://a.test/xmpp"/>',
    '<Link rel="urn:xmpp:alt-connections:websocket" href="wss://b.test/xmpp"/>',
    '<Link rel="urn:xmpp:alt-connections:websocket" href="wss://c.test/xmpp"/>',
  ];
  fetchMock = spyOn(globalThis, "fetch");
  let baseline;
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    fetchMock.mockResolvedValueOnce(
      new Response(
        `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">${order.map((index) => links[index]).join("")}</XRD>`,
      ),
    );
    const endpoints = (await resolve("example.test")).map(({ uri }) => uri);
    // Accept any local ordering policy, but never lose alternatives or use XML order.
    expect(new Set(endpoints)).toEqual(
      new Set(["wss://a.test/xmpp", "wss://b.test/xmpp", "wss://c.test/xmpp"]),
    );
    baseline ??= endpoints;
    expect(endpoints).toEqual(baseline);
  }
});

test.each(["", "wss://resource.test/{uri}"])(
  "RFC 6415 §4.1: excludes resource templates from host-wide discovery: %s",
  async (template) => {
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
        <Link rel="urn:xmpp:alt-connections:websocket" href="wss://resource.test/xmpp" template="${template}"/>
        <Link rel="urn:xmpp:alt-connections:websocket" href="wss://host.test/xmpp"/>
      </XRD>`,
      ),
    );
    expect((await resolve("example.test")).map(({ uri }) => uri)).toEqual([
      "wss://host.test/xmpp",
    ]);
  },
);
