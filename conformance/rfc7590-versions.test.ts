import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

// RFC 7590 §§1/3 imports BCP 195. RFC 8996 §§4–5 and RFC 9325
// §§3.1.1/3.1.3 prohibit TLS 1.0/1.1 and fallback; existing XMPP supports
// TLS 1.2 and prefers implemented TLS 1.3. This is runtime integration evidence,
// not a JavaScript TLS implementation or complete cipher/certificate audit.
const MESSAGE_TIMEOUT_MS = 7000;
const CLIENT_TIMEOUT_MS = 2000;
const CHILD_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 30000;
const CLEANUP_TIMEOUT_MS = 3000;
const TEST_TIMEOUT_MS = 20000;
const SNAPSHOT = "snapshot\n";
const STOP = "stop\n";
type Records = {
  sessions: string[];
  requests: { path: string; protocol: string }[];
  upgrades: { path: string; protocol: string; subprotocol: string }[];
  errors: string[];
};
type Message = {
  type: "ready" | "snapshot";
  records: Records;
  port?: number;
  node?: string;
  probe?: {
    accepted: boolean;
    protocol?: string;
    authorized?: boolean;
    authorizationError?: unknown;
    receivedHTTP?: boolean;
  };
};
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-tls-versions-"));
  const authority = await generate(
    [{ name: "commonName", value: "TLS version test CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
  );
  const certificate = await generate(
    [{ name: "commonName", value: "localhost" }],
    {
      algorithm: "sha256",
      ca: { key: authority.private, cert: authority.cert },
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
      ],
    },
  );
  const root = new X509Certificate(authority.cert);
  const leaf = new X509Certificate(certificate.cert);
  expect(root.ca).toBe(true);
  expect(root.verify(root.publicKey)).toBe(true);
  expect(leaf.ca).toBe(false);
  expect(leaf.verify(root.publicKey)).toBe(true);
  expect(leaf.checkPrivateKey(createPrivateKey(certificate.private))).toBe(
    true,
  );
  expect(leaf.subjectAltName).toBe("DNS:localhost");
  expect(leaf.checkHost("localhost", { subject: "never" })).toBe("localhost");
  for (const parsed of [root, leaf]) {
    expect(Date.parse(parsed.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(parsed.validTo)).toBeGreaterThan(Date.now());
  }
  await Promise.all([
    writeFile(join(directory, "ca.pem"), authority.cert),
    writeFile(join(directory, "leaf.pem"), certificate.cert),
    writeFile(join(directory, "key.pem"), certificate.private),
  ]);
});

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

// The fixture reports bounded JSON lines, never borrowed production expectations.
async function* messages(stream: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    for (
      let end = pending.indexOf("\n");
      end !== -1;
      end = pending.indexOf("\n")
    ) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      yield JSON.parse(line) as Message;
    }
  }
}

async function receive(reader: AsyncGenerator<Message>): Promise<Message> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native TLS fixture response timed out")),
          MESSAGE_TIMEOUT_MS,
        );
      }),
    ]);
    if (result.done) {
      throw new Error(
        "Native TLS fixture exited: set XMPP_TEST_NODE to a native Node executable, not Bun's node shim",
      );
    }
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}

test.each([
  ["TLSv1", "TLSv1", "TLSv1", "rejected"],
  ["TLSv1.1", "TLSv1.1", "TLSv1.1", "rejected"],
  ["TLSv1.2", "TLSv1.2", "TLSv1.2", "accepted"],
  ["TLSv1.3", "TLSv1.3", "TLSv1.3", "accepted"],
  ["TLSv1.2", "TLSv1.3", "TLSv1.3", "accepted"],
] as const)(
  "RFC 7590 / BCP 195: peer %s–%s, capability probe %s, client %s",
  async (minimum, maximum, protocol, outcome) => {
    const peer = Bun.spawn(
      [
        process.env.XMPP_TEST_NODE ?? "node",
        "conformance/fixtures/tls-versions.mjs",
        directory,
        minimum,
        maximum,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: PEER_TIMEOUT_MS,
      },
    );
    const reader = messages(peer.stdout);
    const stderr = new Response(peer.stderr).text();
    try {
      const ready = await receive(reader);
      expect(ready.node).toMatch(/^v\d+\./);
      expect(ready.port).toBeNumber();
      expect(ready).toEqual({
        type: "ready",
        node: ready.node,
        port: ready.port,
        probe: {
          accepted: true,
          protocol,
          authorized: true,
          authorizationError: null,
          receivedHTTP: true,
        },
        records: {
          sessions: [protocol],
          requests: [{ path: "/probe", protocol }],
          upgrades: [],
          errors: [],
        },
      });
      // Probe success proves the old-version server works before client rejection.
      for (const mode of ["direct", "discovery"] as const) {
        peer.stdin.write(SNAPSHOT);
        const before = await receive(reader);
        expect(before.type).toBe("snapshot");
        const service =
          mode === "direct"
            ? `wss://localhost:${ready.port}/xmpp`
            : `localhost:${ready.port}`;
        const child = Bun.spawn(
          [
            process.execPath,
            "--eval",
            `
          import { client } from "./src/client/index.js";
          const xmpp = client({ service: ${JSON.stringify(service)}, domain: "different-xmpp-domain.test", timeout: ${CLIENT_TIMEOUT_MS} });
          xmpp.reconnect.stop();
          xmpp.on("error", () => {});
          let result;
          try {
            await xmpp.connect(xmpp.options.service);
            result = { accepted: true };
          } catch(error) {
            result = { accepted: false, name: error.name, message: error.message };
          } finally {
            await xmpp.stop();
          }
          console.log(JSON.stringify(result));
        `,
          ],
          {
            env: {
              ...process.env,
              NODE_TLS_REJECT_UNAUTHORIZED: "1",
              NODE_EXTRA_CA_CERTS: join(directory, "ca.pem"),
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: CHILD_TIMEOUT_MS,
          },
        );
        const [exit, stdout, clientErrors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ exit, clientErrors }).toEqual({ exit: 0, clientErrors: "" });
        const observed = JSON.parse(stdout) as {
          accepted: boolean;
          name?: string;
        };
        expect({ minimum, maximum, mode, observed }).toMatchObject({
          observed: { accepted: outcome === "accepted" },
        });
        expect(observed.name).not.toBe("TimeoutError");
        peer.stdin.write(SNAPSHOT);
        const after = await receive(reader);
        expect(after.type).toBe("snapshot");
        const sessions = after.records.sessions.slice(
          before.records.sessions.length,
        );
        const requests = after.records.requests.slice(
          before.records.requests.length,
        );
        const upgrades = after.records.upgrades.slice(
          before.records.upgrades.length,
        );
        const errors = after.records.errors.slice(before.records.errors.length);
        if (outcome === "rejected") {
          // A precise version error excludes cipher/signature/server setup failures.
          expect(errors).toContain("ERR_SSL_UNSUPPORTED_PROTOCOL");
          expect({ sessions, requests, upgrades }).toEqual({
            sessions: [],
            requests: [],
            upgrades: [],
          });
          continue;
        }
        expect(sessions).toEqual(
          mode === "direct" ? [protocol] : [protocol, protocol],
        );
        expect(requests).toEqual(
          mode === "direct"
            ? []
            : [{ path: "/.well-known/host-meta", protocol }],
        );
        expect(upgrades).toEqual([
          { path: "/xmpp", protocol, subprotocol: "xmpp" },
        ]);
        expect(errors).toEqual([]);
      }
    } finally {
      const kill = setTimeout(() => peer.kill(), CLEANUP_TIMEOUT_MS);
      try {
        peer.stdin.write(STOP);
        peer.stdin.end();
        await peer.exited;
      } finally {
        clearTimeout(kill);
      }
      expect({ exit: peer.exitCode, stderr: await stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
    }
  },
  TEST_TIMEOUT_MS,
);
