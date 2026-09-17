import { expect, test } from "bun:test";

import SASLMechanismRegistry from "../sasl/registry.ts";
import registerAnonymous from "./index.ts";

test("RFC 4505 §2: creates an ANONYMOUS initial response", () => {
  const registry = new SASLMechanismRegistry();
  registerAnonymous(registry);

  const mechanism = registry.create("ANONYMOUS");
  expect(mechanism.clientFirst).toBe(true);
  expect(mechanism.response({ trace: "guest-session" })).toBe("guest-session");
  expect(mechanism.response({})).toBe("");
});
