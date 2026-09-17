import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

// RFC 7395 §§3.9, 6; RFC 7590 §3.4; XEP-0156 1.4.0 §2.2:
// authenticate HTTPS discovery and WSS endpoint identities independently of the
// XMPP domain. PKIX belongs to the runtime; these are integration scenarios.
const HTTP_BAD_REQUEST = 400;
const DAY_MS = 86_400_000;
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

test.each([
  ["direct", "valid"],
  ["direct", "wrong-name"],
  ["direct", "expired"],
  ["direct", "untrusted"],
  ["discovery", "valid"],
  ["discovery", "wrong-name"],
  ["discovery", "expired"],
  ["discovery", "untrusted"],
] as const)("§3.9/6 PKIX: %s / %s", async (mode, scenario) => {
  const now = Date.now();
  const certificate = await generate(
    [{ name: "commonName", value: "localhost" }],
    {
      algorithm: "sha256",
      ca: { key: authority.private, cert: authority.cert },
      notBeforeDate: new Date(now - 2 * DAY_MS),
      notAfterDate: new Date(now + (scenario === "expired" ? -1 : 1) * DAY_MS),
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        {
          name: "subjectAltName",
          altNames: [
            {
              type: 2,
              value: scenario === "wrong-name" ? "wrong.invalid" : "localhost",
            },
          ],
        },
      ],
    },
  );
  let upgrades = 0;
  let discoveries = 0;
  const server = Bun.serve({
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
  try {
    // A fresh process loads only this additional CA. Never bypass PKIX checks.
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
    const accepted = scenario === "valid";
    expect(stdout.trim()).toBe(accepted ? "accepted" : "rejected");
    expect(upgrades).toBe(accepted ? 1 : 0);
    expect(discoveries).toBe(mode === "discovery" && accepted ? 1 : 0);
  } finally {
    await server.stop(true);
  }
});
