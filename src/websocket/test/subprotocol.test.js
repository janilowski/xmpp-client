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
