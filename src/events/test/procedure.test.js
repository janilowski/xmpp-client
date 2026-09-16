import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import procedure from "../lib/procedure.js";

test("deadline cancels a silent procedure and removes its listener", async () => {
  const entity = new EventEmitter();
  entity.timeout = 5;
  let error;
  const pending = procedure(entity, null, () => {}).catch((error_) => {
    error = error_;
  });
  await Bun.sleep(25);
  expect(error?.name).toBe("TimeoutError");
  expect(entity.listenerCount("nonza")).toBe(0);
  await pending;
});

test("subscribes before sending and consumes a synchronous response", async () => {
  const entity = new EventEmitter();
  const response = {};
  entity.send = async () => {
    expect(entity.listenerCount("nonza")).toBe(1);
    entity.emit("nonza", response);
  };

  expect(await procedure(entity, {}, (element, done) => done(element))).toBe(
    response,
  );
  expect(entity.listenerCount("nonza")).toBe(0);
  for (const name of ["close", "disconnect", "error"]) {
    expect(entity.listenerCount(name)).toBe(0);
  }
});

test.each(["send", "handler"])(
  "cleans up an asynchronous %s failure",
  async (source) => {
    const entity = new EventEmitter();
    const error = new Error("procedure failed");
    entity.send = async () => {
      if (source === "send") {
        throw error;
      }
      entity.emit("nonza", {});
    };

    await expect(
      procedure(entity, {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    for (const name of ["nonza", "close", "disconnect", "error"]) {
      expect(entity.listenerCount(name)).toBe(0);
    }
  },
);

test.each(["close", "disconnect"])(
  "cancels on %s without consuming later session responses",
  async (event) => {
    const entity = new EventEmitter();
    let handled = 0;
    const pending = procedure(entity, null, () => {
      handled++;
    });

    entity.emit(event);
    expect(entity.listenerCount("nonza")).toBe(0);
    await expect(pending).rejects.toThrow("Connection closed");
    entity.emit("nonza", {});
    expect(handled).toBe(0);
    for (const name of ["close", "disconnect", "error"]) {
      expect(entity.listenerCount(name)).toBe(0);
    }
  },
);

test("rejects on connection error and preserves unrelated listeners", async () => {
  const entity = new EventEmitter();
  const existing = () => {};
  entity.on("error", existing);
  const error = new Error("transport failure");
  const pending = procedure(entity, null, () => {});

  entity.emit("error", error);
  expect(entity.listenerCount("nonza")).toBe(0);
  await expect(pending).rejects.toBe(error);
  expect(entity.listeners("error")).toEqual([existing]);
});

test("cleans up when send throws synchronously", async () => {
  const entity = new EventEmitter();
  const error = new Error("send failed");
  entity.send = () => {
    throw error;
  };

  await expect(procedure(entity, {}, () => {})).rejects.toBe(error);
  for (const name of ["nonza", "close", "disconnect", "error"]) {
    expect(entity.listenerCount(name)).toBe(0);
  }
});
