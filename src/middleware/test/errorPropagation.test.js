import { expect, test } from "bun:test";
import { EventEmitter } from "../../events/index.js";
import {
  clearReported,
  markReported,
} from "../../events/lib/reportedError.js";
import xml from "../../xml/index.js";
import middleware from "../index.js";

const FOREIGN = "urn:test:error-propagation";

// An emitted connection error rejects active exchanges; that rejection is not
// a second failure. Observation belongs to the pending pipeline, not the client.
test.each(["reported error", "different local error", "newer reported error"])(
  "middleware reports a pending rejection once / %s",
  async (mode) => {
    const entity = new EventEmitter();
    entity.isStanza = () => false;
    const stack = middleware({ entity });
    const pending = Promise.withResolvers();
    const errors = [];
    entity.on("error", (error) => errors.push(error));
    stack.use(() => pending.promise);
    const listeners = entity.listenerCount("error");
    const first = new Error("reported connection failure");
    const second = new Error("other failure");

    entity.emit("element", xml("future", { xmlns: FOREIGN }));
    if (mode === "newer reported error") {
      markReported(entity, second);
      entity.emit("error", second);
    } else {
      markReported(entity, first);
      entity.emit("error", first);
    }
    pending.reject(mode === "reported error" ? first : second);
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toEqual(
      mode === "reported error"
        ? [first]
        : mode === "newer reported error"
          ? [second]
          : [first, second],
    );
    expect(entity.listenerCount("error")).toBe(listeners);
  },
);

test("middleware suppresses one reported error across concurrent operations", async () => {
  const entity = new EventEmitter();
  entity.isStanza = () => false;
  const stack = middleware({ entity });
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const pending = [first, second];
  const errors = [];
  entity.on("error", (error) => errors.push(error));
  stack.use(() => pending.shift().promise);
  const failure = new Error("terminal connection failure");

  entity.emit("element", xml("future", { xmlns: FOREIGN }));
  entity.emit("element", xml("future", { xmlns: FOREIGN }));
  markReported(entity, failure);
  entity.emit("error", failure);
  first.reject(failure);
  second.reject(failure);
  await new Promise((resolve) => setImmediate(resolve));

  expect(errors).toEqual([failure]);
});

test("middleware does not suppress the same error after session reset", async () => {
  const entity = new EventEmitter();
  entity.isStanza = () => false;
  const stack = middleware({ entity });
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let calls = 0;
  const errors = [];
  entity.on("error", (error) => errors.push(error));
  stack.use(() => (++calls === 1 ? first.promise : second.promise));
  const failure = new Error("reused failure");
  const listeners = entity.listenerCount("error");

  entity.emit("element", xml("future", { xmlns: FOREIGN }));
  markReported(entity, failure);
  entity.emit("error", failure);
  first.reject(failure);
  await new Promise((resolve) => setImmediate(resolve));
  expect(errors).toEqual([failure]);
  expect(entity.listenerCount("error")).toBe(listeners);

  clearReported(entity);
  entity.emit("element", xml("future", { xmlns: FOREIGN }));
  second.reject(failure);
  await new Promise((resolve) => setImmediate(resolve));
  expect(errors).toEqual([failure, failure]);
  expect(entity.listenerCount("error")).toBe(listeners);
});

test("middleware does not add error listeners while work is pending", async () => {
  const entity = new EventEmitter();
  entity.isStanza = () => false;
  const stack = middleware({ entity });
  const pending = Promise.withResolvers();
  const errors = [];
  entity.on("error", (error) => errors.push(error));
  stack.use(() => pending.promise);
  const listeners = entity.listenerCount("error");

  for (let index = 0; index < 20; index += 1) {
    entity.emit("element", xml("future", { xmlns: FOREIGN }));
  }
  expect(entity.listenerCount("error")).toBe(listeners);
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(errors).toEqual([]);
  expect(entity.listenerCount("error")).toBe(listeners);
});

test("middleware preserves unhandled EventEmitter error behavior", async () => {
  const entity = new EventEmitter();
  entity.isStanza = () => false;
  const stack = middleware({ entity });
  const pending = Promise.withResolvers();
  stack.use(() => pending.promise);
  const failure = new Error("unhandled connection failure");

  entity.emit("element", xml("future", { xmlns: FOREIGN }));
  expect(entity.listenerCount("error")).toBe(0);
  expect(() => entity.emit("error", failure)).toThrow(failure);
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));
});
