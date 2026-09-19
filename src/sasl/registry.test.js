import { expect, test } from "bun:test";

import SASLMechanismRegistry from "./registry.ts";

test("preserves mechanism priority", () => {
  const registry = new SASLMechanismRegistry();
  registry.register("FIRST", () => ({ name: "FIRST" }));
  registry.register("SECOND", () => ({ name: "SECOND" }));

  expect(registry.names).toEqual(["FIRST", "SECOND"]);
});

test("creates an independent mechanism for every authentication", () => {
  const registry = new SASLMechanismRegistry();
  registry.register("PLAIN", () => ({ name: "PLAIN" }));

  const first = registry.create("PLAIN");
  const second = registry.create("PLAIN");

  expect(first).toEqual({ name: "PLAIN" });
  expect(second).toEqual({ name: "PLAIN" });
  expect(first).not.toBe(second);
  expect(registry.create("UNKNOWN")).toBeNull();
});

test("rejects duplicate mechanism names", () => {
  const registry = new SASLMechanismRegistry();
  registry.register("PLAIN", () => ({}));

  expect(() => registry.register("PLAIN", () => ({}))).toThrow(
    "SASL mechanism PLAIN is already registered.",
  );
});

// Local registry policy: JavaScript callers still receive runtime validation.
test.each(["", null, undefined, 1])("rejects invalid name %p", (name) => {
  const registry = new SASLMechanismRegistry();

  expect(() => registry.register(name, () => ({}))).toThrow(
    "A SASL mechanism must have a name.",
  );
  expect(registry.names).toEqual([]);
});

test.each([null, undefined, {}, 1])("rejects invalid factory %p", (factory) => {
  const registry = new SASLMechanismRegistry();

  expect(() => registry.register("PLAIN", factory)).toThrow(
    "A SASL mechanism must have a factory function.",
  );
  expect(registry.names).toEqual([]);
});

test("defers factory calls until creation and preserves factory errors", () => {
  const registry = new SASLMechanismRegistry();
  const error = new Error("unavailable credentials");
  let calls = 0;

  expect(
    registry.register("PLAIN", () => {
      calls++;
      throw error;
    }),
  ).toBe(registry);
  expect(calls).toBe(0);
  expect(() => registry.create("PLAIN")).toThrow(error);
  expect(calls).toBe(1);
});
