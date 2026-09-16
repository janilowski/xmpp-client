import { test, expect, mock } from "bun:test";
import { EventEmitter } from "../../events/index.js";
import Socket from "../lib/Socket.js";

// A WebSocket platform may accept an upgrade with no selected subprotocol.
// RFC 7395 §3.1 still requires the XMPP layer to reject it.
test.each(["", "other"])("rejects negotiated subprotocol %j", (protocol) => {
  const transport = new Socket();
  const websocket = new EventEmitter();
  websocket.protocol = protocol;
  websocket.close = mock();
  const errors = [];
  const connected = mock();
  transport.on("error", (error) => errors.push(error));
  transport.on("connect", connected);
  transport._attachSocket(websocket);
  websocket.emit("open");
  expect(connected).not.toHaveBeenCalled();
  expect(websocket.close).toHaveBeenCalledTimes(1);
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toContain("xmpp");
});

test("accepts the negotiated xmpp subprotocol", () => {
  const transport = new Socket();
  const websocket = new EventEmitter();
  websocket.protocol = "xmpp";
  const connected = mock();
  transport.on("connect", connected);
  transport._attachSocket(websocket);
  websocket.emit("open");
  expect(connected).toHaveBeenCalledTimes(1);
});

const WS_UNSUPPORTED_DATA = 1003;
test.each([
  new Uint8Array([60, 120, 47, 62]),
  new ArrayBuffer(4),
  new Blob(["<x/>"]),
])("rejects binary XMPP messages and discards buffered data", (binary) => {
  const transport = new Socket();
  const websocket = new EventEmitter();
  websocket.protocol = "xmpp";
  websocket.close = mock();
  const received = mock();
  const errors = [];
  transport.on("data", received);
  transport.on("error", (error) => errors.push(error));
  transport._attachSocket(websocket);
  websocket.emit("open");
  websocket.emit("message", { data: binary });
  websocket.emit("message", { data: '<message xmlns="jabber:client"/>' });
  expect(received).not.toHaveBeenCalled();
  expect(websocket.close).toHaveBeenCalledTimes(1);
  expect(websocket.close.mock.calls[0][0]).toBe(WS_UNSUPPORTED_DATA);
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toBe("XMPP requires WebSocket text messages");
});
