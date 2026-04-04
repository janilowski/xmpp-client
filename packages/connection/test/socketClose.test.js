import { EventEmitter } from "@xmpp/events";

import Connection from "../index.js";

import { test, expect, spyOn } from "bun:test";
test("calls _detachSocket and _status", () => {
  expect.assertions(3);
  const conn = new Connection();
  const sock = new EventEmitter();
  conn._attachSocket(sock);

  const evt = {};
  conn._status = (status, { clean, reason }) => {
    expect(clean).toBe(false);
    expect(reason).toBe(evt);
  };

  const spy_detachSocket = spyOn(conn, "_detachSocket");

  sock.emit("close", true, evt);

  expect(spy_detachSocket).toHaveBeenCalled();
});
