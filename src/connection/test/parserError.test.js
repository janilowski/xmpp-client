import { EventEmitter } from "../../events/index.js";
import { test, expect, spyOn } from "bun:test";

import Connection from "../index.js";

test("calls _detachParser, sends a bad-format stream error and emit an error", async () => {
  expect.assertions(4);

  const conn = new Connection();
  const parser = new EventEmitter();
  conn._attachParser(parser);

  const spy_detachParser = spyOn(conn, "_detachParser");
  const spy_streamError = spyOn(conn, "_streamError");

  const error = new Error("foo");

  conn.on("error", (err) => {
    expect(err).toBe(error);
  });

  parser.emit("error", error);

  expect(spy_streamError).toHaveBeenCalledWith("bad-format");
  expect(spy_streamError).toHaveBeenCalledTimes(1);

  expect(spy_detachParser).toHaveBeenCalledTimes(1);
});
