import { expect, test } from "bun:test";

import SASLMechanismRegistry from "../sasl/registry.js";
import registerAnonymous from "./index.js";

test("creates an ANONYMOUS initial response", () => {
  const registry = new SASLMechanismRegistry();
  registerAnonymous(registry);

  const mechanism = registry.create("ANONYMOUS");
  expect(mechanism.clientFirst).toBe(true);
  expect(mechanism.response({ trace: "guest-session" })).toBe("guest-session");
  expect(mechanism.response({})).toBe("");
});
