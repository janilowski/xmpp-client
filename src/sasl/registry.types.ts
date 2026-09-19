import SASLMechanismRegistry from "./registry.ts";
import type { SASLMechanism } from "./mechanism.ts";
import registerPlain from "../sasl-plain/index.ts";
import registerAnonymous from "../sasl-anonymous/index.ts";

// Compile-only local API contract, run by `bun run typecheck`.
export async function checkSaslTypes(registry: SASLMechanismRegistry) {
  registerPlain(registry);
  registerAnonymous(registry);

  const createText = () => ({
    name: "SYNC",
    clientFirst: true,
    response: () => "initial",
  });
  registry.register("SYNC", createText);
  registry.register("ASYNC", () => ({
    name: "ASYNC",
    clientFirst: true,
    response: async () => new Uint8Array([0, 255]),
  }));

  // @ts-expect-error Mechanism names must be strings.
  registry.register(42, createText);
  // @ts-expect-error Factories must be callable.
  registry.register("INVALID", {});
  // @ts-expect-error A factory must produce a complete mechanism.
  registry.register("INVALID", () => ({ name: "INVALID" }));
  // @ts-expect-error Mechanism creation is synchronous; exchanges may be async.
  registry.register("INVALID", async () => createText());
  // @ts-expect-error A response cannot be a number.
  registry.register("INVALID", () => ({ ...createText(), response: () => 42 }));
  registry.register("INVALID", () => ({
    ...createText(),
    // @ts-expect-error Async responses have the same payload restriction.
    response: async () => 42,
  }));

  const mechanism = registry.create("PLAIN");
  // @ts-expect-error An unknown mechanism returns null.
  mechanism.response({});
  if (!mechanism) {
    return;
  }

  await mechanism.response({ username: "romeo", password: "secret" });
  await mechanism.response({ username: null, password: null });
  await mechanism.response({ trace: "guest" });
  // @ts-expect-error Credential values must match the mechanism contract.
  await mechanism.response({ password: 42 });
  // @ts-expect-error Misspelled credential fields must not pass silently.
  await mechanism.response({ passwrod: "secret" });
}

// Decoding mode determines callback inputs, independently of response encoding.
export async function checkExchangeTypes(
  registry: SASLMechanismRegistry,
  mechanism: SASLMechanism,
) {
  registry.register("TEXT", () => ({
    name: "TEXT",
    clientFirst: false,
    response: () => null,
    challenge: (data) => {
      data.toUpperCase();
    },
    final: async (data) => {
      data.toUpperCase();
    },
  }));
  registry.register("BINARY", () => ({
    name: "BINARY",
    clientFirst: true,
    binary: true,
    response: async () => undefined,
    challenge: async (data) => {
      data.subarray(0);
    },
    final: (data) => {
      data.subarray(0);
    },
  }));

  // @ts-expect-error A mechanism may omit its final-data handler.
  await mechanism.final("");
  if (mechanism.binary) {
    await mechanism.challenge?.(new Uint8Array());
    await mechanism.final?.(new Uint8Array());
    // @ts-expect-error Binary mechanisms receive decoded bytes.
    await mechanism.challenge?.("encoded");
    // @ts-expect-error Binary final data must also be bytes.
    await mechanism.final?.("encoded");
    return;
  }

  await mechanism.challenge?.("decoded");
  await mechanism.final?.("decoded");
  // @ts-expect-error Text mechanisms receive decoded strings.
  await mechanism.challenge?.(new Uint8Array());
  // @ts-expect-error Text final data must also be a string.
  await mechanism.final?.(new Uint8Array());
}
