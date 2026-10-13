import { EventEmitter } from "../../events/index.js";
import { test, expect, spyOn } from "bun:test";

import Connection from "../index.js";
import xml from "../../xml/index.js";

const STREAM = "http://etherx.jabber.org/streams";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const CLIENT = "jabber:client";
const CLOSE_TIMEOUT_MS = 100;

// Synchronous transports expose replacement and reentrancy during error writes.
function attachSession(conn) {
  const socket = new EventEmitter();
  const parser = new EventEmitter();
  const writes = [];
  const ends = [];
  socket.write = (data, callback) => {
    writes.push(data);
    callback();
  };
  socket.end = () => {
    ends.push(true);
    socket.emit("close");
  };
  conn._attachSocket(socket);
  conn._attachParser(parser);
  conn.NS = CLIENT;
  conn.status = "online";
  conn.footerElement = () => xml("close");
  return { socket, parser, writes, ends };
}

test("reports a parser error and retains reciprocal close reception", async () => {
  expect.assertions(4);

  const conn = new Connection();
  const parser = new EventEmitter();
  conn._attachParser(parser);

  const spy_streamError = spyOn(conn, "_streamError").mockResolvedValue();

  const error = new Error("foo");

  conn.on("error", (err) => {
    expect(err).toBe(error);
  });

  parser.emit("error", error);

  expect(spy_streamError).toHaveBeenCalledWith("bad-format");
  expect(spy_streamError).toHaveBeenCalledTimes(1);

  expect(conn.parser).toBe(parser);
});

test("fatal parser errors preserve reciprocal close without dispatch", async () => {
  const conn = new Connection({ timeout: CLOSE_TIMEOUT_MS });
  const session = attachSession(conn);
  const errors = [];
  const elements = [];
  conn.on("error", (error) => errors.push(error));
  conn.on("element", (element) => elements.push(element));
  session.parser.on("error", () => {});
  const failure = new Error("invalid XML");

  session.parser.emit("error", failure);
  session.parser.emit("element", xml("features", { xmlns: STREAM }));
  session.parser.emit("error", new Error("later invalid XML"));
  await new Promise((resolve) => setImmediate(resolve));

  expect(conn.parser).toBe(session.parser);
  expect(conn.status).toBe("closing");
  expect(session.ends).toEqual([]);
  expect(errors).toEqual([failure]);
  expect(elements).toEqual([]);
  expect(session.writes).toEqual([
    `<stream:error xmlns:stream="${STREAM}"><bad-format xmlns="${STREAM_ERRORS}"/></stream:error>`,
    "<close/>",
  ]);

  session.parser.emit("end", xml("close"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(session.ends).toEqual([true]);
  expect(conn.status).toBe("disconnect");
});

test.each(["transport", "parser"])(
  "fatal parser error cannot poison a synchronous replacement %s",
  async (replacementKind) => {
    const conn = new Connection();
    const old = attachSession(conn);
    const errors = [];
    const elements = [];
    conn.on("error", (error) => errors.push(error));
    conn.on("element", (element) => elements.push(element));
    let replacement;
    old.socket.write = (data, callback) => {
      old.writes.push(data);
      if (replacementKind === "transport") {
        old.socket.emit("close");
        replacement = attachSession(conn);
      } else {
        const parser = new EventEmitter();
        conn._attachParser(parser);
        replacement = { socket: old.socket, parser };
      }
      callback();
    };

    old.parser.emit("error", new Error("old invalid XML"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(old.writes).toEqual([
      `<stream:error xmlns:stream="${STREAM}"><bad-format xmlns="${STREAM_ERRORS}"/></stream:error>`,
    ]);
    expect(conn.socket).toBe(replacement.socket);
    expect(conn.parser).toBe(replacement.parser);
    expect(conn.status).toBe("online");
    expect(old.ends).toEqual([]);
    expect(errors).toEqual([]);
    const element = xml("message", { xmlns: CLIENT });
    replacement.parser.emit("element", element);
    expect(elements).toEqual([element]);
  },
);

test.each(["open", "restart"])(
  "fatal parser errors reject synchronous %s before another opening",
  async (method) => {
    const conn = new Connection({ timeout: CLOSE_TIMEOUT_MS });
    const session = attachSession(conn);
    let attempt;
    conn.once("error", () => {
      attempt = conn[method]({ domain: "example.test" }).catch(
        (error) => error,
      );
    });

    session.parser.emit("error", new Error("invalid XML"));
    const result = await attempt;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Connection is closing");
    expect(conn.parser).toBe(session.parser);
    await new Promise((resolve) => setImmediate(resolve));
    expect(conn.status).toBe("closing");
    expect(session.writes).toEqual([
      `<stream:error xmlns:stream="${STREAM}"><bad-format xmlns="${STREAM_ERRORS}"/></stream:error>`,
      "<close/>",
    ]);
    session.parser.emit("end", xml("close"));
    await new Promise((resolve) => setImmediate(resolve));
  },
);
