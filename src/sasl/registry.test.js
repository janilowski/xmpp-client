import { expect, test } from "bun:test";

import SASLMechanismRegistry from "./registry.js";

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
