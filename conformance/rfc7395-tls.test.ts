import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

// RFC 7395 §§3.9, 6; RFC 7590 §3.4; XEP-0156 1.4.0 §2.2:
// authenticate HTTPS discovery and WSS endpoint identities independently of the
// XMPP domain. PKIX belongs to the runtime; these are integration scenarios.
const HTTP_BAD_REQUEST = 400;
const DAY_MS = 86_400_000;
const KNOWN_CN_ONLY_BUN_VERSION = "1.4.2";
let directory: string;
let authority: Awaited<ReturnType<typeof generate>>;

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
  await writeFile(join(directory, "ca.pem"), authority.cert);
});

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe.each([
  ["direct", "valid"],
  ["direct", "wrong-name"],
  ["direct", "expired"],
  ["direct", "untrusted"],
  ["direct", "cn-only"],
  ["discovery", "valid"],
  ["discovery", "wrong-name"],
  ["discovery", "expired"],
  ["discovery", "untrusted"],
  ["discovery", "cn-only"],
] as const)("§3.9/6 PKIX: %s / %s", (mode, scenario) => {
  const knownFailure =
    Bun.version === KNOWN_CN_ONLY_BUN_VERSION && scenario === "cn-only";
  let server: Bun.Server<undefined> | undefined;
  let observed: { outcome: string; upgrades: number; discoveries: number };

  // Hook failures are never expected conformance failures, including for #50.
  beforeAll(async () => {
    const now = Date.now();
    const certificate = await generate(
      [{ name: "commonName", value: "localhost" }],
      {
        algorithm: "sha256",
        ca: { key: authority.private, cert: authority.cert },
        notBeforeDate: new Date(now - 2 * DAY_MS),
        notAfterDate: new Date(
          now + (scenario === "expired" ? -1 : 1) * DAY_MS,
        ),
        extensions: [
          { name: "basicConstraints", cA: false },
          { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
          { name: "extKeyUsage", serverAuth: true },
          ...(scenario === "cn-only"
            ? []
            : [
                {
                  name: "subjectAltName" as const,
                  altNames: [
                    {
                      type: 2 as const,
                      value:
                        scenario === "wrong-name"
                          ? "wrong.invalid"
                          : "localhost",
                    },
                  ],
                },
              ]),
        ],
      },
    );
    const parsed = new X509Certificate(certificate.cert);
    expect(parsed.subject).toBe("CN=localhost");
    expect(parsed.verify(new X509Certificate(authority.cert).publicKey)).toBe(
      true,
    );
    expect(parsed.subjectAltName).toBe(
      scenario === "cn-only"
        ? undefined
        : `DNS:${scenario === "wrong-name" ? "wrong.invalid" : "localhost"}`,
    );
    let upgrades = 0;
    let discoveries = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: certificate.cert, key: certificate.private },
      fetch(request, server) {
        if (new URL(request.url).pathname === "/.well-known/host-meta") {
          discoveries += 1;
          return new Response(
            `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://localhost:${server.port}/xmpp"/></XRD>`,
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
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        import { client } from "./src/client/index.js";
        const xmpp = client({ service: ${JSON.stringify(mode === "discovery" ? `localhost:${server.port}` : `wss://localhost:${server.port}/xmpp`)}, domain: "different-xmpp-domain.test" });
        xmpp.reconnect.stop();
        xmpp.on("error", () => {});
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
    observed = { outcome: stdout.trim(), upgrades, discoveries };
  });

  afterAll(async () => {
    await server?.stop(true);
  });

  // RFC 9525 §2: CN is not a service identity. #50 remains nonconforming on
  // this exact runtime; a fixed or different version must reject it normally.
  test.failingIf(knownFailure)(
    `validates endpoint identity before HTTP discovery or WS upgrade${knownFailure ? ` [expected Bun ${KNOWN_CN_ONLY_BUN_VERSION} violation #50]` : ""}`,
    () => {
      const accepted = scenario === "valid";
      expect(observed).toEqual({
        outcome: accepted ? "accepted" : "rejected",
        upgrades: accepted ? 1 : 0,
        discoveries: mode === "discovery" && accepted ? 1 : 0,
      });
    },
  );
});
