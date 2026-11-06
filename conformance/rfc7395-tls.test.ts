import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

// RFC 7395 §§3.9, 6; RFC 7590 §3.4; RFC 6120 §13.7.2;
// RFC 5280 §§6.1.3(a), 6.1.4(k/n); RFC 9525 §1.2;
// XEP-0156 1.4.0 §2.2: authenticate the complete HTTPS discovery and WSS
// certificate paths and endpoint identities independently of the XMPP domain.
// PKIX belongs to the runtime; these are integration scenarios.
// Leaf signature/EKU controls: RFC 5280 §§6.1.3(a)(1), 4.2.1.12.
// Protocol versions and TLS 1.3 preference: rfc7590-versions.test.ts.
const HTTP_BAD_REQUEST = 400;
const DAY_MS = 86_400_000;
const OPENSSL_TIMEOUT_MS = 5000;
const OPENSSL_VERIFY_FAILURE = 2;
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
let directory: string;
let authority: Awaited<ReturnType<typeof generate>>;
let untrustedAuthority: Awaited<ReturnType<typeof generate>>;
const intermediates = new Map<string, Awaited<ReturnType<typeof generate>>>();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-tls-"));
  authority = await generate(
    [{ name: "commonName", value: "Disposable XMPP test CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
  );
  untrustedAuthority = await generate(
    [{ name: "commonName", value: "Untrusted XMPP test CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
  );
  const now = Date.now();
  for (const root of [authority, untrustedAuthority]) {
    const parsed = new X509Certificate(root.cert);
    expect(parsed.ca).toBe(true);
    expect(parsed.issuer).toBe(parsed.subject);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(Date.parse(parsed.validFrom)).toBeLessThanOrEqual(now);
    expect(Date.parse(parsed.validTo)).toBeGreaterThan(now);
  }

  for (const scenario of [
    "chain-valid",
    "chain-untrusted-intermediate",
    "chain-expired-intermediate",
    "chain-non-ca-intermediate",
    "chain-missing-key-cert-sign",
  ]) {
    const issuer =
      scenario === "chain-untrusted-intermediate"
        ? untrustedAuthority
        : authority;
    const intermediate = await generate(
      [{ name: "commonName", value: `XMPP ${scenario}` }],
      {
        algorithm: "sha256",
        ca: { key: issuer.private, cert: issuer.cert },
        notBeforeDate: new Date(now - 2 * DAY_MS),
        notAfterDate: new Date(
          now + (scenario === "chain-expired-intermediate" ? -1 : 1) * DAY_MS,
        ),
        extensions: [
          {
            name: "basicConstraints",
            cA: scenario !== "chain-non-ca-intermediate",
            critical: true,
          },
          // Isolate a non-CA issuer without an inconsistent keyCertSign bit.
          ...(scenario === "chain-non-ca-intermediate"
            ? []
            : [
                {
                  name: "keyUsage" as const,
                  digitalSignature: scenario === "chain-missing-key-cert-sign",
                  keyCertSign: scenario !== "chain-missing-key-cert-sign",
                  cRLSign: true,
                  critical: true,
                },
              ]),
        ],
      },
    );
    intermediates.set(scenario, intermediate);
  }
  await writeFile(join(directory, "ca.pem"), authority.cert);
});

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe.each([
  ["direct", "valid"],
  ["direct", "bad-signature"],
  ["direct", "wrong-eku"],
  ["direct", "wrong-name"],
  ["direct", "expired"],
  ["direct", "untrusted"],
  ["direct", "cn-only"],
  ["direct", "uri-only"],
  ["direct", "valid-ipv4"],
  ["direct", "valid-ipv6"],
  ["direct", "chain-valid"],
  ["direct", "chain-untrusted-intermediate"],
  ["direct", "chain-expired-intermediate"],
  ["direct", "chain-non-ca-intermediate"],
  ["direct", "chain-missing-key-cert-sign"],
  ["direct", "chain-missing-intermediate"],
  ["discovery", "valid"],
  ["discovery", "bad-signature"],
  ["discovery", "wrong-eku"],
  ["discovery", "wrong-name"],
  ["discovery", "expired"],
  ["discovery", "untrusted"],
  ["discovery", "cn-only"],
  ["discovery", "uri-only"],
  ["discovery", "valid-ipv4"],
  ["discovery", "valid-ipv6"],
  ["discovery", "chain-valid"],
  ["discovery", "chain-untrusted-intermediate"],
  ["discovery", "chain-expired-intermediate"],
  ["discovery", "chain-non-ca-intermediate"],
  ["discovery", "chain-missing-key-cert-sign"],
  ["discovery", "chain-missing-intermediate"],
] as const)("§3.9/6 PKIX: %s / %s", (mode, scenario) => {
  let server: Bun.Server<undefined> | undefined;
  const artifacts = ["source", "minified"] as const;
  const observed: {
    artifact: string;
    outcome: string;
    upgrades: number;
    discoveries: number;
  }[] = [];

  // Hook failures are never expected conformance failures, including for #50.
  beforeAll(async () => {
    const now = Date.now();
    const intermediate = intermediates.get(
      scenario === "chain-missing-intermediate" ? "chain-valid" : scenario,
    );
    if (scenario.startsWith("chain-")) {
      expect(intermediate).toBeDefined();
    }
    const issuer = intermediate ?? authority;
    const hostname = scenario === "valid-ipv6" ? "::1" : "127.0.0.1";
    const endpoint = scenario.startsWith("valid-ip")
      ? scenario === "valid-ipv6"
        ? "[::1]"
        : hostname
      : "localhost";

    const certificate = await generate(
      [{ name: "commonName", value: "localhost" }],
      {
        algorithm: "sha256",
        ca: { key: issuer.private, cert: issuer.cert },
        notBeforeDate: new Date(now - 2 * DAY_MS),
        notAfterDate: new Date(
          now + (scenario === "expired" ? -1 : 1) * DAY_MS,
        ),
        extensions: [
          { name: "basicConstraints", cA: false },
          { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
          {
            name: "extKeyUsage",
            ...(scenario === "wrong-eku"
              ? { clientAuth: true }
              : { serverAuth: true }),
          },
          ...(scenario === "cn-only"
            ? []
            : [
                {
                  name: "subjectAltName" as const,
                  altNames: scenario.startsWith("valid-ip")
                    ? [{ type: 7 as const, ip: hostname }]
                    : [
                        {
                          type:
                            scenario === "uri-only"
                              ? (6 as const)
                              : (2 as const),
                          value:
                            scenario === "uri-only"
                              ? "https://localhost/"
                              : scenario === "wrong-name"
                                ? "wrong.invalid"
                                : "localhost",
                        },
                      ],
                },
              ]),
        ],
      },
    );
    const signedCertificate = certificate.cert;
    const signed = new X509Certificate(signedCertificate);
    expect(signed.verify(new X509Certificate(issuer.cert).publicKey)).toBe(
      true,
    );
    if (scenario === "bad-signature") {
      // Change only signatureValue, retaining the signed fields and leaf key.
      const der = Buffer.from(signed.raw);
      der[der.length - 1] = der[der.length - 1]! ^ 1;
      certificate.cert = new X509Certificate(der).toString();
    }
    const parsed = new X509Certificate(certificate.cert);
    expect(parsed.ca).toBe(false);
    expect(parsed.subject).toBe("CN=localhost");
    expect(parsed.issuer).toBe(new X509Certificate(issuer.cert).subject);
    expect(parsed.verify(new X509Certificate(issuer.cert).publicKey)).toBe(
      scenario !== "bad-signature",
    );
    expect(Date.parse(parsed.validFrom)).toBeLessThan(now);
    expect(Date.parse(parsed.validTo) > now).toBe(scenario !== "expired");
    if (scenario.startsWith("valid-ip")) {
      expect(parsed.checkIP(hostname)).toBe(hostname);
    } else {
      expect(parsed.subjectAltName).toBe(
        scenario === "cn-only"
          ? undefined
          : scenario === "uri-only"
            ? "URI:https://localhost/"
            : `DNS:${scenario === "wrong-name" ? "wrong.invalid" : "localhost"}`,
      );
    }
    if (scenario === "chain-missing-intermediate") {
      // A fresh child has no cached issuer or AIA URL to retrieve one.
      expect(parsed.infoAccess).toBeUndefined();
    }

    if (["valid", "bad-signature", "wrong-eku"].includes(scenario)) {
      expect(
        parsed.checkPrivateKey(createPrivateKey(certificate.private)),
      ).toBe(true);
      expect(parsed.keyUsage).toEqual([
        scenario === "wrong-eku" ? CLIENT_AUTH : SERVER_AUTH,
      ]);
      const file = `${mode}-${scenario}.pem`;
      const original = `${mode}-${scenario}-signed.pem`;
      await Promise.all([
        writeFile(join(directory, file), certificate.cert),
        writeFile(join(directory, original), signedCertificate),
      ]);
      const checks =
        scenario === "wrong-eku"
          ? ([
              ["sslclient", file, 0, null],
              [
                "sslserver",
                file,
                OPENSSL_VERIFY_FAILURE,
                "unsuitable certificate purpose",
              ],
            ] as const)
          : scenario === "bad-signature"
            ? ([
                ["sslserver", original, 0, null],
                [
                  "sslserver",
                  file,
                  OPENSSL_VERIFY_FAILURE,
                  "certificate signature failure",
                ],
              ] as const)
            : ([["sslserver", file, 0, null]] as const);
      // Native OpenSSL distinguishes bad issuer signatures from wrong purpose.
      for (const [purpose, filename, expectedExit, diagnostic] of checks) {
        const verifier = Bun.spawn(
          [
            "openssl",
            "verify",
            "-CAfile",
            "ca.pem",
            "-purpose",
            purpose,
            "-verify_hostname",
            "localhost",
            filename,
          ],
          {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
            timeout: OPENSSL_TIMEOUT_MS,
          },
        );
        try {
          const [exit, stdout, stderr] = await Promise.all([
            verifier.exited,
            new Response(verifier.stdout).text(),
            new Response(verifier.stderr).text(),
          ]);
          expect({ exit, stdout, stderr }).toMatchObject({
            exit: expectedExit,
          });
          if (diagnostic) {
            expect(stderr).toContain(diagnostic);
          } else {
            expect(stdout.trim()).toBe(`${filename}: OK`);
            expect(stderr).toBe("");
          }
        } finally {
          verifier.kill();
          await verifier.exited;
        }
      }
    }

    if (intermediate) {
      const parsedAuthority = new X509Certificate(authority.cert);
      const parsedIntermediate = new X509Certificate(intermediate.cert);
      const parsedIssuer = new X509Certificate(
        scenario === "chain-untrusted-intermediate"
          ? untrustedAuthority.cert
          : authority.cert,
      );

      if (scenario !== "chain-missing-key-cert-sign") {
        expect(parsedIntermediate.ca).toBe(
          scenario !== "chain-non-ca-intermediate",
        );
      }
      expect(parsedIntermediate.issuer).toBe(parsedIssuer.subject);
      expect(parsedIntermediate.verify(parsedIssuer.publicKey)).toBe(true);
      expect(parsedIntermediate.verify(parsedAuthority.publicKey)).toBe(
        scenario !== "chain-untrusted-intermediate",
      );
      expect(Date.parse(parsedIntermediate.validFrom)).toBeLessThan(now);
      expect(Date.parse(parsedIntermediate.validTo) > now).toBe(
        scenario !== "chain-expired-intermediate",
      );

      if (scenario === "chain-missing-key-cert-sign") {
        // RFC 5280 §6.1.4(n): digitalSignature cannot authorize CA signing.
        // Decode the actual CA flag separately: X509Certificate.ca also
        // considers key usage, so false alone cannot isolate this defect.
        const leafFile = `${mode}-${scenario}.pem`;
        const issuerFile = `${mode}-${scenario}-issuer.pem`;
        await Promise.all([
          writeFile(join(directory, leafFile), certificate.cert),
          writeFile(join(directory, issuerFile), intermediate.cert),
        ]);
        for (const [args, expectedExit] of [
          [
            [
              "x509",
              "-in",
              issuerFile,
              "-noout",
              "-ext",
              "basicConstraints,keyUsage",
            ],
            0,
          ],
          [
            [
              "verify",
              "-CAfile",
              "ca.pem",
              "-untrusted",
              issuerFile,
              "-purpose",
              "sslserver",
              "-verify_hostname",
              "localhost",
              leafFile,
            ],
            OPENSSL_VERIFY_FAILURE,
          ],
        ] as const) {
          const verifier = Bun.spawn(["openssl", ...args], {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
            timeout: OPENSSL_TIMEOUT_MS,
          });
          try {
            const [exit, stdout, stderr] = await Promise.all([
              verifier.exited,
              new Response(verifier.stdout).text(),
              new Response(verifier.stderr).text(),
            ]);
            expect({ exit, stdout, stderr }).toMatchObject({
              exit: expectedExit,
            });
            if (expectedExit === 0) {
              expect(stdout.trim()).toBe(
                "X509v3 Basic Constraints: critical\n    CA:TRUE\nX509v3 Key Usage: critical\n    Digital Signature, CRL Sign",
              );
              expect(stderr).toBe("");
            } else {
              expect(stderr).toContain(
                "key usage does not include certificate signing",
              );
            }
          } finally {
            verifier.kill();
            await verifier.exited;
          }
        }
      }
    }

    let upgrades = 0;
    let discoveries = 0;
    const warmupPorts: number[] = [];
    const discoveryPorts: number[] = [];
    server = Bun.serve({
      hostname,
      port: 0,
      tls: {
        cert:
          intermediate && scenario !== "chain-missing-intermediate"
            ? `${certificate.cert}\n${intermediate.cert}`
            : certificate.cert,
        key: certificate.private,
      },
      fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === "/warmup") {
          warmupPorts.push(server.requestIP(request)!.port);
          return new Response("native warmup");
        }
        if (path === "/.well-known/host-meta") {
          discoveries += 1;
          discoveryPorts.push(server.requestIP(request)!.port);
          return new Response(
            `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://${endpoint}:${server.port}/xmpp"/></XRD>`,
          );
        }
        upgrades += 1;
        if (
          server.upgrade(request, {
            headers: { "Sec-WebSocket-Protocol": "xmpp" },
          })
        ) {
          return;
        }
        return new Response(null, { status: HTTP_BAD_REQUEST });
      },
      websocket: { message() {} },
    });
    // The extra CA augments runtime roots; it is not an exclusive trust store.
    const env = {
      ...process.env,
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
      NODE_EXTRA_CA_CERTS:
        scenario === "untrusted" ? "" : join(directory, "ca.pem"),
    };
    for (const artifact of artifacts) {
      const previous = { upgrades, discoveries, warmups: warmupPorts.length };
      // A native permissive pool must not bypass the library's stricter policy.
      // Invalid-identity warmup is specific to Bun's confirmed fallback version;
      // certificate rejection below remains unconditional on every runtime.
      const warmup =
        mode === "discovery" &&
        (scenario === "valid" ||
          (Bun.version === "1.4.4" &&
            ["cn-only", "uri-only"].includes(scenario)));
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        const { client } = ${
          artifact === "source"
            ? 'await import("./src/client/index.js")'
            : 'Function((await Bun.file("./dist/xmpp.min.js").text()) + "\\n;return XMPP;")()'
        };
        const xmpp = client({ service: ${JSON.stringify(mode === "discovery" ? `${endpoint}:${server.port}` : `wss://${endpoint}:${server.port}/xmpp`)}, domain: "different-xmpp-domain.test" });
        xmpp.reconnect.stop();
        xmpp.on("error", () => {});
        if (${warmup}) {
          for (let index = 0; index < 2; index++) {
            const response = await fetch("https://localhost:${server.port}/warmup");
            if (await response.text() !== "native warmup") { throw new Error("Warmup failed"); }
          }
        }
        try {
          await xmpp.connect(xmpp.options.service);
          console.log("accepted");
        } catch (error) {
          if (error.name === "TimeoutError") throw error;
          console.log("rejected");
        } finally {
          await xmpp.stop();
        }
      `,
        ],
        { env, stdout: "pipe", stderr: "pipe", timeout: 5000 },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(["accepted", "rejected"]).toContain(stdout.trim());
      if (warmup) {
        const ports = warmupPorts.slice(previous.warmups);
        expect(ports).toHaveLength(2);
        expect(ports[0]).toBe(ports[1]);
        expect(discoveryPorts.slice(previous.discoveries)).not.toContain(
          ports[0],
        );
      }
      observed.push({
        artifact,
        outcome: stdout.trim(),
        upgrades: upgrades - previous.upgrades,
        discoveries: discoveries - previous.discoveries,
      });
    }
  });

  afterAll(async () => {
    await server?.stop(true);
  });

  // RFC 9525 §2: CN and URI SANs are not HTTPS/WSS DNS/IP endpoint identities.
  test("validates the certificate path and endpoint identity before HTTP discovery or WS upgrade", () => {
    const accepted = scenario.startsWith("valid") || scenario === "chain-valid";
    expect(observed).toEqual(
      artifacts.map((artifact) => ({
        artifact,
        outcome: accepted ? "accepted" : "rejected",
        upgrades: accepted ? 1 : 0,
        discoveries: mode === "discovery" && accepted ? 1 : 0,
      })),
    );
  });
});
