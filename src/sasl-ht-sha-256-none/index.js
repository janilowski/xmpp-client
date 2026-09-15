/* eslint-disable n/no-unsupported-features/node-builtins */

// https://datatracker.ietf.org/doc/draft-schmaus-kitten-sasl-ht/
// https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API

export function Mechanism() {}

Mechanism.prototype.Mechanism = Mechanism;
Mechanism.prototype.name = "HT-SHA-256-NONE";
Mechanism.prototype.clientFirst = true;
Mechanism.prototype.binary = true;

Mechanism.prototype.response = async function response({ username, password }) {
  this.key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    // https://developer.mozilla.org/en-US/docs/Web/API/HmacImportParams
    { name: "HMAC", hash: "SHA-256" },
    false, // extractable
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    this.key,
    new TextEncoder().encode("Initiator"),
  );
  const usernameBytes = new TextEncoder().encode(username);
  const response = new Uint8Array(
    usernameBytes.length + 1 + signature.byteLength,
  );
  response.set(usernameBytes);
  response.set(new Uint8Array(signature), usernameBytes.length + 1);
  return response;
};

Mechanism.prototype.final = async function final(data) {
  // https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/verify
  const result = await crypto.subtle.verify(
    "HMAC",
    this.key,
    data,
    new TextEncoder().encode("Responder"),
  );
  if (result !== true) {
    throw new Error("Responder message from server was wrong");
  }
};

export default function registerHashedToken(saslMechanisms) {
  saslMechanisms.register("HT-SHA-256-NONE", () => new Mechanism());
}
