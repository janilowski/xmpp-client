import { EventEmitter, promise, TimeoutError } from "@xmpp/events";
import { xml } from "@xmpp/test";
import { test, expect, spyOn } from "bun:test";

import Connection from "../index.js";

test("resets properties on socket close event", () => {
  const conn = new Connection();
  conn._attachSocket(new EventEmitter());
  conn.status = "online";
  conn.socket.emit("connect");
  conn.socket.emit("close");
  expect(conn.status).toBe("disconnect");
});

test("timeout on parser end", async () => {
  const conn = new Connection();
  conn.parser = new EventEmitter();
  spyOn(conn, "footerElement").mockImplementation(() => xml("hello"));
  spyOn(conn, "write").mockImplementation(async () => {});

  await expect(conn._closeStream()).rejects.toThrow(new TimeoutError());
});

test("error on status closing", async () => {
  const conn = new Connection();
  conn.parser = new EventEmitter();
  conn.footerElement = () => {
    return xml("hello");
  };

  conn.socket = new EventEmitter();
  conn.socket.write = (data, cb) => {
    return cb();
  };

  conn.status = "closing";

  conn.parser.emit("end");

  await expect(conn._closeStream()).rejects.toThrow(
    new Error("Connection is closing"),
  );
});

test("resolves", async () => {
  const conn = new Connection();
  conn.parser = new EventEmitter();

  spyOn(conn, "footerElement").mockImplementation(() => xml("hello"));
  spyOn(conn, "write").mockImplementation(async () => {});

  setTimeout(() => {
    conn.parser.emit("end", xml("goodbye"));
  }, 0);
  const el = await conn._closeStream();

  expect(el.toString()).toBe(`<goodbye/>`);
});

test("emits closing status", async () => {
  const conn = new Connection();
  conn.parser = new EventEmitter();

  spyOn(conn, "footerElement").mockImplementation(() => xml("hello"));
  spyOn(conn, "write").mockImplementation(async () => {});

  setTimeout(() => {
    conn.parser.emit("end");
  }, 0);

  const [status] = await Promise.all([
    promise(conn, "status"),
    conn._closeStream(),
  ]);
  expect(status).toBe("closing");
});
