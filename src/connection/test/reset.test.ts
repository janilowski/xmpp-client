import { expect, test } from "bun:test";
import Connection from "../index.js";
import { EventEmitter } from "../../events/index.js";
import xml from "../../xml/index.js";

const STREAM = "http://etherx.jabber.org/streams";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";

test("RFC 6120 §4.9.3.16: base connection refuses reset before creating a socket", async () => {
  const connection = new Connection();
  let sockets = 0;
  const Socket = class extends EventEmitter {
    constructor() {
      super();
      sockets++;
    }
    connect() {
      this.emit("connect");
    }
  };
  Object.assign(connection, { Socket });
  await connection.connect("first");
  expect(sockets).toBe(1);
  const errors: Error[] = [];
  connection.on("error", (error: Error) => errors.push(error));
  connection._onStreamError(
    xml("error", { xmlns: STREAM }, xml("reset", { xmlns: ERRORS })),
  );
  expect(errors).toHaveLength(1);
  await expect(connection.connect("second")).rejects.toBe(errors[0]);
  await expect(connection.open({ domain: "example.test" })).rejects.toBe(
    errors[0],
  );
  await expect(connection.restart()).rejects.toBe(errors[0]);
  expect(sockets).toBe(1);
});
