import { afterAll, beforeAll, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

// Fixture infrastructure, not additional XMPP/TLS policy. The peer binds IPv4;
// its independent probe must not depend on localhost DNS ordering or fallback.
// An explicit servername still owns native certificate identity verification.
// https://nodejs.org/download/release/v24.18.0/docs/api/cli.html#--dns-result-orderorder
// https://nodejs.org/download/release/v24.18.0/docs/api/tls.html#tlsconnectoptions-callback
const CHILD_TIMEOUT_MS = 15000;
const RSA_KEY_BITS = 2048;
const TLS_VERSION = "TLSv1.3";
const SCENARIOS = ["valid", "wrong-name", "untrusted-ca"] as const;
type Scenario = (typeof SCENARIOS)[number];
type Result = {
  type: string;
  node: string;
  port: number;
  probe: {
    accepted: boolean;
    authorized?: boolean;
    authorizationError?: unknown;
    protocol?: string;
    receivedHTTP?: boolean;
    code?: string;
    message?: string;
  };
  records: {
    requests: { path: string; protocol: string }[];
    upgrades: unknown[];
  };
};
let directory: string;

beforeAll(async () => {
  // DNS ordering cannot create an absent IPv6 answer. Require this witness so
  // an IPv4-only test host cannot silently accept the old localhost probe.
  const native = Bun.spawn(
    [
      process.env.XMPP_TEST_NODE ?? "node",
      "--no-network-family-autoselection",
      "--dns-result-order=ipv6first",
      "--input-type=module",
      "--eval",
      `import dns from 'node:dns';import net from 'node:net';
       console.log(JSON.stringify({node:process.version,bun:process.versions.bun??null,
         order:dns.getDefaultResultOrder(),fallback:net.getDefaultAutoSelectFamily(),
         addresses:await dns.promises.lookup('localhost',{all:true})}));`,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS },
  );
  const [exit, stdout, stderr] = await Promise.all([
    native.exited,
    new Response(native.stdout).text(),
    new Response(native.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const environment = JSON.parse(stdout);
  expect(environment.node).toMatch(/^v\d+\./);
  expect(environment.bun).toBeNull();
  expect(environment.order).toBe("ipv6first");
  expect(environment.fallback).toBe(false);
  expect(environment.addresses).toContainEqual({ address: "::1", family: 6 });

  directory = await mkdtemp(join(tmpdir(), "xmpp-version-peer-"));
  const authorities = await Promise.all(
    ["Version peer CA", "Unrelated version peer CA"].map((value) =>
      generate([{ name: "commonName", value }], {
        keySize: RSA_KEY_BITS,
        algorithm: "sha256",
        extensions: [
          { name: "basicConstraints", cA: true, critical: true },
          {
            name: "keyUsage",
            keyCertSign: true,
            cRLSign: true,
            critical: true,
          },
        ],
      }),
    ),
  );
  const authority = authorities[0]!;
  const unrelated = authorities[1]!;
  const root = new X509Certificate(authority.cert);
  expect(root.verify(root.publicKey)).toBe(true);
  expect(new X509Certificate(unrelated.cert).fingerprint256).not.toBe(
    root.fingerprint256,
  );

  for (const scenario of SCENARIOS) {
    const hostname = scenario === "wrong-name" ? "wrong.invalid" : "localhost";
    const leaf = await generate([{ name: "commonName", value: "localhost" }], {
      keySize: RSA_KEY_BITS,
      algorithm: "sha256",
      ca: { key: authority.private, cert: authority.cert },
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: hostname }] },
      ],
    });
    const certificate = new X509Certificate(leaf.cert);
    expect(certificate.verify(root.publicKey)).toBe(true);
    expect(certificate.checkHost("localhost", { subject: "never" })).toBe(
      scenario === "wrong-name" ? undefined : "localhost",
    );
    // Success requires the DNS reference name, not a newly trusted IP identity.
    expect(certificate.checkIP("127.0.0.1")).toBeUndefined();
    const path = join(directory, scenario);
    await mkdir(path);
    await Promise.all([
      writeFile(join(path, "key.pem"), leaf.private),
      writeFile(join(path, "leaf.pem"), leaf.cert),
      writeFile(
        join(path, "ca.pem"),
        scenario === "untrusted-ca" ? unrelated.cert : authority.cert,
      ),
    ]);
  }
});

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([...SCENARIOS])(
  "TLS version peer: IPv6-first DNS preserves strict localhost authentication / %s",
  async (scenario: Scenario) => {
    const child = Bun.spawn(
      [
        process.env.XMPP_TEST_NODE ?? "node",
        "--no-network-family-autoselection",
        "--dns-result-order=ipv6first",
        "conformance/fixtures/tls-versions.mjs",
        join(directory, scenario),
        TLS_VERSION,
        TLS_VERSION,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: CHILD_TIMEOUT_MS,
      },
    );
    // The fixture consumes commands only after completing its native probe.
    // Prequeue cleanup so the complete bounded result can be read on exit.
    child.stdin.write("stop\n");
    child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]!) as Result;
    expect(result.type).toBe("ready");
    expect(result.node).toMatch(/^v\d+\./);
    expect(Number.isInteger(result.port) && result.port > 0).toBe(true);
    expect(result.records.upgrades).toEqual([]);

    if (scenario === "valid") {
      expect(result.probe).toEqual({
        accepted: true,
        protocol: TLS_VERSION,
        authorized: true,
        authorizationError: null,
        receivedHTTP: true,
      });
      expect(result.records.requests).toEqual([
        { path: "/probe", protocol: TLS_VERSION },
      ]);
      return;
    }

    expect(result.probe).toMatchObject({
      accepted: false,
      code:
        scenario === "wrong-name"
          ? "ERR_TLS_CERT_ALTNAME_INVALID"
          : "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    expect(result.records.requests).toEqual([]);
  },
  CHILD_TIMEOUT_MS,
);
