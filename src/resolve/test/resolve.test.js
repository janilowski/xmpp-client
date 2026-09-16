import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ReadableStream } from "node:stream/web";
import resolve from "../resolve.js";

const DOMAIN = "example.test";
const DOCUMENT =
  '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://endpoint.example.test/xmpp"/></XRD>';
const ENDPOINT = {
  rel: "urn:xmpp:alt-connections:websocket",
  href: "wss://endpoint.example.test/xmpp",
  uri: "wss://endpoint.example.test/xmpp",
  method: "websocket",
};
const HTTP_NOT_FOUND = 404;
let fetchMock;

beforeEach(() => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(DOCUMENT),
  );
});
afterEach(() => fetchMock.mockRestore());

test("discovers an endpoint through HTTPS host-meta, not DNS SRV", async () => {
  expect(await resolve(DOMAIN)).toEqual([ENDPOINT]);
  expect(fetchMock.mock.calls[0][0]).toBe(
    `https://${DOMAIN}/.well-known/host-meta`,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("discovery has a deadline and does not follow HTTP redirects", async () => {
  await resolve(DOMAIN);
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});

test("cancels an oversized discovery body before reading its remainder", async () => {
  let cancelled = false;
  fetchMock.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1).fill(32));
          controller.enqueue(new TextEncoder().encode(DOCUMENT));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  // The reader must cancel without waiting for the never-ending body.
  expect(await resolve(DOMAIN)).toEqual([]);
  expect(cancelled).toBe(true);
});

test("does not trust a host-meta document from an unsuccessful HTTP response", async () => {
  fetchMock.mockResolvedValue(
    new Response(DOCUMENT, { status: HTTP_NOT_FOUND }),
  );
  expect(await resolve(DOMAIN)).toEqual([]);
});

test.each([
  DOCUMENT.replace("http://docs.oasis-open.org/ns/xri/xrd-1.0", "urn:wrong"),
  DOCUMENT.replace("<Link ", '<Link xmlns="urn:wrong" '),
  DOCUMENT.replace(' href="wss://endpoint.example.test/xmpp"', ""),
  DOCUMENT.replace("wss://endpoint.example.test/xmpp", "javascript:alert(1)"),
  DOCUMENT.replace("wss://endpoint.example.test/xmpp", "/relative"),
  "<XRD>",
  DOCUMENT.slice(0, -6),
  DOCUMENT + DOCUMENT,
])("ignores invalid discovery metadata: %s", async (document) => {
  fetchMock.mockResolvedValue(new Response(document));
  expect(await resolve(DOMAIN)).toEqual([]);
});

test.each([
  new Error("Network failure"),
  new DOMException("Expired", "TimeoutError"),
])("failed discovery yields no endpoints: %s", async (error) => {
  fetchMock.mockRejectedValue(error);
  expect(await resolve(DOMAIN)).toEqual([]);
});
