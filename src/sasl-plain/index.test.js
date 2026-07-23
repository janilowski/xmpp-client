import { expect, test } from "bun:test";

import SASLMechanismRegistry from "../sasl/registry.js";
import registerPlain from "./index.js";

test("creates a PLAIN initial response", () => {
  const registry = new SASLMechanismRegistry();
  registerPlain(registry);

  const mechanism = registry.create("PLAIN");
  expect(mechanism.clientFirst).toBe(true);
  expect(
    mechanism.response({
      authzid: "romeo@example.net",
      username: "romeo",
      password: "secret",
    }),
  ).toBe("romeo@example.net\0romeo\0secret");
  expect(
    mechanism.response({ username: "romeo", password: "secret" }),
  ).toBe("\0romeo\0secret");
});
