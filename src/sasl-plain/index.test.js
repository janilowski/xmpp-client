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

test.each([
  ["empty authentication identity", { username: "", password: "secret" }],
  ["empty password", { username: "romeo", password: "" }],
  ["missing authentication identity", { password: "secret" }],
  ["missing password", { username: "romeo" }],
  ["non-string authorization identity", {
    authzid: 1,
    username: "romeo",
    password: "secret",
  }],
  ["non-string authentication identity", {
    username: 1,
    password: "secret",
  }],
  ["non-string password", { username: "romeo", password: 1 }],
  ["NUL in authorization identity", {
    authzid: "romeo\0admin",
    username: "romeo",
    password: "secret",
  }],
  ["NUL in authentication identity", {
    username: "romeo\0admin",
    password: "secret",
  }],
  ["NUL in password", { username: "romeo", password: "sec\0ret" }],
  ["invalid authorization identity Unicode", {
    authzid: "romeo\uD800",
    username: "romeo",
    password: "secret",
  }],
  ["invalid authentication identity Unicode", {
    username: "romeo\uD800",
    password: "secret",
  }],
  ["invalid password Unicode", {
    username: "romeo",
    password: "sec\uD800ret",
  }],
])("rejects %s", (_name, credentials) => {
  const registry = new SASLMechanismRegistry();
  registerPlain(registry);

  expect(() => registry.create("PLAIN").response(credentials)).toThrow(
    "PLAIN: invalid credentials",
  );
});
