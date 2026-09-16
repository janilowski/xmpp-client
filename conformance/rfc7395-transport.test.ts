import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { RawPeer } from "./raw-peer.ts";

test.each([null, "other"])(
  "§3.1 Bun rejects a real handshake selecting %s",
  async (protocol) => {
    const peer = await new RawPeer(protocol).listen();
    const xmpp = client({ service: peer.url, domain: "example.test" });
    xmpp.reconnect.stop();
    const events: string[] = [];
    xmpp.on("error", () => {});
    xmpp.on("connect", () => events.push("connect"));
    try {
      const result = await xmpp.start().catch((error: Error) => error);
      expect(result).toBeInstanceOf(Error);
      expect(result).not.toMatchObject({ name: "TimeoutError" });
      expect(events).toEqual([]);
      expect(peer.requests).toHaveLength(1);
      expect(peer.requests[0]).toMatch(/Sec-WebSocket-Protocol: xmpp/i);
    } finally {
      await peer.stop();
      await xmpp.stop();
    }
  },
);

test("§3.2 Bun rejects invalid UTF-8 text at the WebSocket boundary", async () => {
  // RFC 6455 final text frame, length two, invalid UTF-8 continuation.
  const peer = await new RawPeer("xmpp", [
    new Uint8Array([0x81, 0x02, 0xc3, 0x28]),
  ]).listen();
  const socket = new WebSocket(peer.url, "xmpp");
  const messages: unknown[] = [];
  socket.onmessage = (event) => messages.push(event.data);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Invalid UTF-8 did not close transport")),
        2000,
      );
      socket.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {};
    });
    expect(messages).toEqual([]);
  } finally {
    socket.close();
    await peer.stop();
  }
});
