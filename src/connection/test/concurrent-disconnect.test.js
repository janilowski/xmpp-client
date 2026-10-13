import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "../../events/index.js";
import xml from "../../xml/index.js";
import Connection from "../index.js";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";

// RFC 6120 §4.4: concurrent callers share one reciprocal-close exchange.
test.each(["disconnect", "stop"])(
  "pending disconnect shares its deadline and result with %s",
  async (method) => {
    const conn = new Connection();
    const pending = Promise.withResolvers();
    const close = xml("close", { xmlns: FRAMING });
    const stream = spyOn(conn, "_closeStream").mockReturnValue(pending.promise);
    const socket = spyOn(conn, "_closeSocket").mockResolvedValue();

    const first = conn.disconnect();
    const second = conn[method]();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(socket).toHaveBeenCalledTimes(0);
    pending.resolve(close);
    expect(await first).toBe(close);
    expect(await second).toBe(close);
    expect(socket).toHaveBeenCalledTimes(1);
  },
);

test("disconnect owns its close before a synchronous hook reenters", async () => {
  const conn = new Connection();
  const pending = Promise.withResolvers();
  const close = xml("close", { xmlns: FRAMING });
  let joined;
  let calls = 0;
  const stream = spyOn(conn, "_closeStream").mockImplementation(() => {
    if (++calls === 1) {
      joined = conn.disconnect();
    }
    return pending.promise;
  });
  const socket = spyOn(conn, "_closeSocket").mockResolvedValue();

  const first = conn.disconnect();
  expect(stream).toHaveBeenCalledTimes(1);
  pending.resolve(close);
  expect(await first).toBe(close);
  expect(await joined).toBe(close);
  expect(socket).toHaveBeenCalledTimes(1);
});

test("old disconnect completion cannot clear a replacement shutdown", async () => {
  const conn = new Connection();
  const old = Promise.withResolvers();
  const current = Promise.withResolvers();
  let calls = 0;
  const stream = spyOn(conn, "_closeStream").mockImplementation(() =>
    ++calls === 1 ? old.promise : current.promise,
  );
  const socket = spyOn(conn, "_closeSocket").mockResolvedValue();
  const first = conn.disconnect();
  conn._attachParser(new EventEmitter());
  const replacement = conn.disconnect();
  expect(stream).toHaveBeenCalledTimes(2);

  old.resolve();
  await first;
  expect(socket).toHaveBeenCalledTimes(0);
  const joined = conn.disconnect();
  expect(stream).toHaveBeenCalledTimes(2);
  const close = xml("close", { xmlns: FRAMING });
  current.resolve(close);
  expect(await replacement).toBe(close);
  expect(await joined).toBe(close);
  expect(socket).toHaveBeenCalledTimes(1);

  // A completed shutdown must not cache its outcome for a later request.
  stream.mockResolvedValue();
  await conn.disconnect();
  expect(stream).toHaveBeenCalledTimes(3);
});
