/* eslint-disable n/no-unsupported-features/node-builtins */
import { encode, decodeBytes } from "../util/base64.js";
import saslprep from "./saslprep.js";

const NONCE_BYTES = 18;
const MAX_ITERATIONS = 1_000_000;
const MAX_MESSAGE_LENGTH = 16_384;
const STATE = {
  INITIAL: "initial",
  FIRST: "first",
  CHALLENGED: "challenged",
  DERIVING: "deriving",
  PROOF: "proof",
  VERIFIED: "verified",
  ACKNOWLEDGED: "acknowledged",
  COMPLETE: "complete",
  FAILED: "failed",
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// RFC 5802 §2.1: canonical Base64, including pad bits, with no whitespace.
function base64(value) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("SCRAM: invalid Base64");
  }
  const bytes = decodeBytes(value);
  if (encode(bytes) !== value) {
    throw new Error("SCRAM: noncanonical Base64");
  }
  return bytes;
}

// Preserve the original message for AuthMessage; do not rebuild from attributes.
function attributes(input) {
  const text = typeof input === "string" ? input : decoder.decode(input);
  if (!text || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error("SCRAM: invalid message length");
  }
  const fields = new Map();
  for (const field of text.split(",")) {
    if (!/^[A-Za-z]=[^\0,]*$/u.test(field)) {
      throw new Error("SCRAM: invalid attribute");
    }
    const key = field[0];
    const value = field.slice(2);
    if (
      fields.has(key) ||
      key === "m" ||
      (!value && key !== "s" && key !== "v")
    ) {
      throw new Error("SCRAM: duplicate, empty or mandatory attribute");
    }
    fields.set(key, value);
  }
  return { text, fields, order: [...fields.keys()].join("") };
}

class Scram {
  clientFirst = true;
  binary = true;
  #hash;
  #bits;
  #state = STATE.INITIAL;
  #nonce;
  #header;
  #first;
  #serverFirst;
  #salt;
  #iterations;
  #serverKey;
  #auth;
  #password;

  constructor(hash, bits) {
    this.name = `SCRAM-${hash}`;
    this.#hash = hash;
    this.#bits = bits;
  }

  async #hmac(key, text) {
    const imported = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: this.#hash },
      false,
      ["sign", "verify"],
    );
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", imported, encoder.encode(text)),
    );
  }

  async response({ username, password, authzid }) {
    if (this.#state === STATE.INITIAL) {
      this.#state = STATE.FAILED;
      username = saslprep(username, "query");
      password = saslprep(password, "stored");
      // Authorization identities belong to the application profile, not SASLprep.
      if (
        !username ||
        (authzid != null &&
          (typeof authzid !== "string" || /[\0\uD800-\uDFFF]/u.test(authzid)))
      ) {
        throw new Error("SCRAM: invalid identity");
      }
      this.#password = password;
      const escaped = username.replaceAll("=", "=3D").replaceAll(",", "=2C");
      const authorization = authzid
        ? "a=" + authzid.replaceAll("=", "=3D").replaceAll(",", "=2C")
        : "";
      this.#nonce = encode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
      this.#header = `n,${authorization},`;
      this.#first = `n=${escaped},r=${this.#nonce}`;
      this.#state = STATE.FIRST;
      return this.#header + this.#first;
    }
    if (this.#state === STATE.VERIFIED) {
      this.#state = STATE.ACKNOWLEDGED;
      return "";
    }
    if (this.#state !== STATE.CHALLENGED) {
      throw new Error("SCRAM: unexpected response");
    }
    this.#state = STATE.DERIVING;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.#password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    this.#password = undefined;
    const salted = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: this.#hash,
        salt: this.#salt,
        iterations: this.#iterations,
      },
      key,
      this.#bits,
    );
    const clientKey = await this.#hmac(salted, "Client Key");
    const storedKey = await crypto.subtle.digest(this.#hash, clientKey);
    const final = `c=${encode(this.#header)},r=${this.#nonce}`;
    this.#auth = [this.#first, this.#serverFirst, final].join(",");
    const signature = await this.#hmac(storedKey, this.#auth);
    const serverKey = await this.#hmac(salted, "Server Key");
    this.#serverKey = await crypto.subtle.importKey(
      "raw",
      serverKey,
      { name: "HMAC", hash: this.#hash },
      false,
      ["verify"],
    );
    if (this.#state !== STATE.DERIVING) {
      throw new Error("SCRAM: exchange interrupted");
    }
    this.#state = STATE.PROOF;
    return `${final},p=${encode(clientKey.map((byte, i) => byte ^ signature[i]))}`;
  }

  async challenge(input) {
    if (this.#state === STATE.PROOF) {
      await this.final(input);
      this.#state = STATE.VERIFIED;
      return;
    }
    if (this.#state !== STATE.FIRST) {
      this.#state = STATE.FAILED;
      throw new Error("SCRAM: unexpected challenge");
    }
    this.#state = STATE.FAILED;
    const { text, fields, order } = attributes(input);
    const nonce = fields.get("r");
    const iterations = fields.get("i");
    if (
      !order.startsWith("rsi") ||
      !/^[\x21-\x2b\x2d-\x7e]+$/.test(nonce) ||
      !nonce.startsWith(this.#nonce) ||
      nonce.length <= this.#nonce.length ||
      !/^[1-9][0-9]*$/.test(iterations) ||
      Number(iterations) > MAX_ITERATIONS
    ) {
      throw new Error("SCRAM: invalid nonce, ordering or iteration count");
    }
    this.#salt = base64(fields.get("s"));
    this.#iterations = Number(iterations);
    this.#nonce = nonce;
    this.#serverFirst = text;
    this.#state = STATE.CHALLENGED;
  }

  async final(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    if (this.#state === STATE.ACKNOWLEDGED && text === "") {
      this.#state = STATE.COMPLETE;
      return;
    }
    const state = this.#state;
    this.#state = STATE.FAILED;
    if (state !== STATE.PROOF) {
      throw new Error("SCRAM: missing or unexpected server proof");
    }
    const { fields, order } = attributes(text);
    if (!order.startsWith("v") || fields.has("e")) {
      throw new Error("SCRAM: server authentication failed");
    }
    const proof = base64(fields.get("v"));
    // Delegate comparison to Web Crypto, not an early-exit JavaScript loop.
    const valid = await crypto.subtle.verify(
      "HMAC",
      this.#serverKey,
      proof,
      encoder.encode(this.#auth),
    );
    this.#serverKey = undefined;
    this.#auth = undefined;
    if (!valid) {
      throw new Error("SCRAM: invalid server proof");
    }
    this.#state = STATE.COMPLETE;
  }
}

export default function registerScram(registry) {
  registry.register("SCRAM-SHA-256", () => new Scram("SHA-256", 256));
  registry.register("SCRAM-SHA-1", () => new Scram("SHA-1", 160));
}
