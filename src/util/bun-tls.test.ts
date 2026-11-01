import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";
import { generate } from "selfsigned";
import getBunTLSOptions from "./bun-tls.ts";

const certificates = await Promise.all(
  (
    [
      [],
      [{ type: 2, value: "localhost" }],
      [{ type: 2, value: "xn--bcher-kva.example" }],
      [{ type: 7, ip: "127.0.0.1" }],
      [{ type: 7, ip: "::1" }],
      [{ type: 2, value: "*.example.test" }],
      [{ type: 2, value: "l*calhost" }],
      [{ type: 6, value: "https://localhost/" }],
      [{ type: 2, value: "wrong.invalid" }],
      [{ type: 2, value: "evil, DNS:localhost" }],
    ] as const
  ).map(async (altNames) => {
    const pair = await generate([{ name: "commonName", value: "localhost" }], {
      extensions: [
        { name: "basicConstraints", cA: false },
        ...(altNames.length
          ? [{ name: "subjectAltName" as const, altNames: [...altNames] }]
          : []),
      ],
    });
    return new X509Certificate(pair.cert).toLegacyObject();
  }),
);

describe("Bun TLS endpoint policy", () => {
  test("rejects CN-only even when native compatibility permits it", () => {
    expect(
      new X509Certificate(certificates[0].raw).subjectAltName,
    ).toBeUndefined();
    // Native compatibility is a pinned control, not a requirement on future Bun.
    if (Bun.version === "1.4.4") {
      expect(tls.checkServerIdentity("localhost", certificates[0])).toBeUndefined();
    }
    expect(
      getBunTLSOptions()!.checkServerIdentity!("localhost", certificates[0]),
    ).toBeInstanceOf(Error);
  });

  test.each([
    ["DNS", "localhost", 1],
    ["DNS case", "LOCALHOST", 1],
    ["root dot", "localhost.", 1],
    ["Unicode reference", "bücher.example", 2],
    ["A-label reference", "xn--bcher-kva.example", 2],
    ["Unicode root dot", "bücher.example.", 2],
    ["IPv4", "127.0.0.1", 3],
    ["IPv6", "::1", 4],
    ["expanded IPv6", "0:0:0:0:0:0:0:1", 4],
    ["bracketed IPv6", "[::1]", 4],
    ["full wildcard", "one.example.test", 5],
  ] as const)("accepts %s SAN identity", (_, host, index) => {
    expect(
      getBunTLSOptions()!.checkServerIdentity!(host, certificates[index]),
    ).toBeUndefined();
  });

  test.each([
    ["CN only", "localhost", 0],
    ["URI SAN with matching CN", "localhost", 7],
    ["wrong DNS SAN with matching CN", "localhost", 8],
    ["SAN display delimiter injection", "localhost", 9],
    ["wrong IP", "127.0.0.2", 3],
    ["wildcard apex", "example.test", 5],
    ["wildcard extra label", "one.two.example.test", 5],
    ["partial wildcard", "localhost", 6],
    ["bracketed DNS", "[localhost]", 1],
  ] as const)("rejects %s", (_, host, index) => {
    expect(
      getBunTLSOptions()!.checkServerIdentity!(host, certificates[index]),
    ).toBeInstanceOf(Error);
  });

  test("validates raw SAN independently of the display value", () => {
    const certificate = { ...certificates[8], subjectaltname: "DNS:localhost" };
    expect(
      getBunTLSOptions()!.checkServerIdentity!("localhost", certificate),
    ).toBeInstanceOf(Error);
  });

  test("retains delegated identity validation", () => {
    const certificate = {
      ...certificates[1],
      subjectaltname: "DNS:wrong.invalid",
    };
    expect(
      getBunTLSOptions()!.checkServerIdentity!("localhost", certificate),
    ).toBeInstanceOf(Error);
  });

  test("returns an error rather than throwing on invalid DER", () => {
    const certificate = { ...certificates[1], raw: Buffer.alloc(0) };
    expect(
      getBunTLSOptions()!.checkServerIdentity!("localhost", certificate),
    ).toBeInstanceOf(Error);
  });

  test("requires native PKIX verification and removes static RSA exchange", () => {
    const configured = tls.DEFAULT_CIPHERS;
    const options = getBunTLSOptions()!;
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ciphers).toBe(`${configured}:!kRSA`);
    expect(tls.DEFAULT_CIPHERS).toBe(configured);
  });

  test("reads the runtime boundary on every call", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      process.versions,
      "bun",
    )!;
    try {
      Object.defineProperty(process.versions, "bun", {
        value: undefined,
        configurable: true,
      });
      expect(getBunTLSOptions()).toBeUndefined();
    } finally {
      Object.defineProperty(process.versions, "bun", descriptor);
    }
    expect(getBunTLSOptions()).toBeDefined();
  });

  test.each(["ECDHE-RSA-AES128-GCM-SHA256"])(
    "preserves the configured cipher list: %s",
    (configured) => {
      const runtimeTLS = process.getBuiltinModule("node:tls")!;
      const original = Reflect.get(runtimeTLS, "DEFAULT_CIPHERS");
      try {
        Reflect.set(runtimeTLS, "DEFAULT_CIPHERS", configured);
        const effective = Reflect.get(runtimeTLS, "DEFAULT_CIPHERS");
        expect(getBunTLSOptions()!.ciphers).toBe(`${effective}:!kRSA`);
        expect(Reflect.get(runtimeTLS, "DEFAULT_CIPHERS")).toBe(effective);
      } finally {
        Reflect.set(runtimeTLS, "DEFAULT_CIPHERS", original);
      }
    },
  );

  test("retains the native TLS 1.3-only default policy", () => {
    const runtimeTLS = process.getBuiltinModule("node:tls")!;
    const original = Reflect.get(runtimeTLS, "DEFAULT_CIPHERS");
    try {
      Reflect.set(runtimeTLS, "DEFAULT_CIPHERS", "TLS_AES_128_GCM_SHA256");
      const effective = Reflect.get(runtimeTLS, "DEFAULT_CIPHERS");
      expect(getBunTLSOptions()!.ciphers).toBeUndefined();
      expect(Reflect.get(runtimeTLS, "DEFAULT_CIPHERS")).toBe(effective);
    } finally {
      Reflect.set(runtimeTLS, "DEFAULT_CIPHERS", original);
    }
  });

  test("leaves browser TLS to its runtime", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process")!;
    try {
      Reflect.deleteProperty(globalThis, "process");
      expect(getBunTLSOptions()).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "process", descriptor);
    }
  });

  test("does not silently drop hardening without builtin access", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      process,
      "getBuiltinModule",
    )!;
    try {
      Object.defineProperty(process, "getBuiltinModule", {
        value: undefined,
        configurable: true,
      });
      expect(getBunTLSOptions).toThrow(TypeError);
    } finally {
      Object.defineProperty(process, "getBuiltinModule", descriptor);
    }
  });
});
