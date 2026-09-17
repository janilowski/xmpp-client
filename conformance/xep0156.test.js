import { afterEach, expect, spyOn, test } from "bun:test";
import { resolve } from "../src/resolve/lib/http.js";

let fetchMock;
afterEach(() => fetchMock?.mockRestore());

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
