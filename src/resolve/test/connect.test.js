import { afterEach, expect, spyOn, test } from "bun:test";
import { client } from "../../client/index.js";
import { EventEmitter } from "node:events";

let fetchMock;
afterEach(() => fetchMock?.mockRestore());

test("discovery never downgrades to an insecure WebSocket endpoint", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="ws://example.test/xmpp"/></XRD>',
    ),
  );
  const xmpp = client({ service: "example.test" });
  xmpp.reconnect.stop();
  await expect(xmpp.connect("example.test")).rejects.toThrow(
    "No compatible secure transport found",
  );
  expect(xmpp.socket).toBe(null);
});

test("discovery disposes failed attempts and preserves their causes", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://one.test/xmpp"/><Link rel="urn:xmpp:alt-connections:websocket" href="wss://two.test/xmpp"/></XRD>',
    ),
  );
  const attempts = [];
  class Socket extends EventEmitter {
    connect(uri) {
      this.uri = uri;
      attempts.push(this);
      queueMicrotask(() => this.emit("error", new Error(uri)));
    }
    end() {
      this.ended = true;
      this.emit("close");
    }
  }
  class Transport {}
  Transport.prototype.Socket = Socket;
  Transport.prototype.socketParameters = (uri) => uri;
  const xmpp = client({ service: "example.test" });
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  xmpp._findTransport = () => Transport;
  const result = await xmpp.connect("example.test").catch((error) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors.map((error) => error.message)).toEqual([
    "wss://one.test/xmpp",
    "wss://two.test/xmpp",
  ]);
  expect(attempts.map((socket) => socket.ended)).toEqual([true, true]);
  expect(attempts.map((socket) => socket.eventNames())).toEqual([[], []]);
  expect(xmpp.socket).toBe(null);
});
