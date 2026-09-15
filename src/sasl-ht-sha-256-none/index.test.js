/* eslint-disable n/no-unsupported-features/node-builtins */

import { encode } from "../util/base64.js";

import { Mechanism } from "./index.js";

test("preserves the raw HMAC bytes", async () => {
  const mechanism = new Mechanism();
  const response = await mechanism.response({
    username: "client",
    password: "secret-token:fast-example",
  });

  expect(response).toBeInstanceOf(Uint8Array);
  expect(encode(response)).toBe(
    "Y2xpZW50AMnezQeDYFORcGUv9VrvCF67Ppj3zhDshQbULMrUVMEh",
  );
});

test("verifies the raw responder proof", async () => {
  const mechanism = new Mechanism();
  await mechanism.response({
    username: "client",
    password: "secret-token:fast-example",
  });
  const responder = await globalThis.crypto.subtle.sign(
    "HMAC",
    mechanism.key,
    new TextEncoder().encode("Responder"),
  );

  await expect(mechanism.final(new Uint8Array(responder))).resolves.toBe(
    undefined,
  );
});
