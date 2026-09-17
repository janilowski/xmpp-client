import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:https";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

// XEP-0156 1.4.0 §§2.2, 4; RFC 6415 §§2–4.1:
// redirect rejection deliberately departs from SHOULD-follow to prevent
// uninspectable HTTP downgrade hops in browser Fetch (see docs/profile.md).
const HTTP = {
  OK: 200,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  SEE_OTHER: 303,
  TEMPORARY_REDIRECT: 307,
  PERMANENT_REDIRECT: 308,
  NOT_FOUND: 404,
  GONE: 410,
  SERVICE_UNAVAILABLE: 503,
};
// Independent expectations for the library's local resource policy, not XEP limits.
const DISCOVERY_DEADLINE_MS = 5000;
const TIMER_TOLERANCE_MS = 100;
const WATCHDOG_MS = 8000;
const PROCESS_TIMEOUT_MS = 10000;
const TEST_TIMEOUT_MS = 12000;
const DRIP_INTERVAL_MS = 250;
const DOCUMENT =
  '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://endpoint.example.test/xmpp"/></XRD>';
let directory: string;
let certificate: Awaited<ReturnType<typeof generate>>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-discovery-tls-"));
  const authority = await generate(
    [{ name: "commonName", value: "Discovery test CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, critical: true },
      ],
    },
  );
  await writeFile(join(directory, "ca.pem"), authority.cert);
  certificate = await generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    ca: { key: authority.private, cert: authority.cert },
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
    ],
  });
});

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

// Isolate the trust store without disabling TLS checks or mocking fetch.
async function discover(port: number) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import resolve from "./src/resolve/resolve.js";
    const started = performance.now();
    let timer;
    const result = await Promise.race([
      resolve("localhost:${port}").then(endpoints => ({ state: "settled", endpoints })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: "unsettled" }), ${WATCHDOG_MS}); }),
    ]);
    clearTimeout(timer);
    console.log(JSON.stringify({ ...result, elapsed: performance.now() - started }));
    // Let the parent assert a missing deadline rather than timing out the test.
    process.exit(0);
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
      timeout: PROCESS_TIMEOUT_MS,
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout) as {
    state: string;
    endpoints?: { uri: string }[];
    elapsed: number;
  };
}

test.each(["headers", "body", "drip"])(
  "local deadline bounds HTTPS discovery: %s",
  async (phase) => {
    let requests = 0;
    let drip: ReturnType<typeof setInterval> | undefined;
    const server = createServer(
      { cert: certificate.cert, key: certificate.private },
      (_request, response) => {
        requests += 1;
        if (phase === "headers") {
          return;
        }
        response.writeHead(HTTP.OK, { "content-type": "application/xrd+xml" });
        response.write(
          '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">',
        );
        if (phase === "drip") {
          drip = setInterval(() => response.write(" "), DRIP_INTERVAL_MS);
        }
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing discovery listener address");
      }
      const result = await discover(address.port);
      expect(requests).toBe(1);
      expect(result).toMatchObject({ state: "settled", endpoints: [] });
      // An immediate unrelated failure must not masquerade as deadline enforcement.
      expect(result.elapsed).toBeGreaterThanOrEqual(
        DISCOVERY_DEADLINE_MS - TIMER_TOLERANCE_MS,
      );
      expect(result.elapsed).toBeLessThan(WATCHDOG_MS);
    } finally {
      clearInterval(drip);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  TEST_TIMEOUT_MS,
);

test.each([HTTP.OK, HTTP.NOT_FOUND, HTTP.GONE, HTTP.SERVICE_UNAVAILABLE])(
  "RFC 6415 §2 HTTPS status: %s",
  async (status) => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: certificate.cert, key: certificate.private },
      fetch() {
        requests += 1;
        return new Response(DOCUMENT, { status });
      },
    });
    try {
      const result = await discover(server.port!);
      expect(requests).toBe(1);
      expect(result.state).toBe("settled");
      expect(result.endpoints?.map(({ uri }) => uri)).toEqual(
        status === HTTP.OK ? ["wss://endpoint.example.test/xmpp"] : [],
      );
    } finally {
      await server.stop(true);
    }
  },
);

for (const protocol of ["http", "https"]) {
  test.each([
    HTTP.MOVED_PERMANENTLY,
    HTTP.FOUND,
    HTTP.SEE_OTHER,
    HTTP.TEMPORARY_REDIRECT,
    HTTP.PERMANENT_REDIRECT,
  ])(
    `local HTTPS redirect policy never contacts ${protocol} target: %s`,
    async (status) => {
      let targetRequests = 0;
      let sourceRequests = 0;
      const target = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        ...(protocol === "https"
          ? { tls: { cert: certificate.cert, key: certificate.private } }
          : {}),
        fetch() {
          targetRequests += 1;
          return new Response(DOCUMENT);
        },
      });
      const source = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { cert: certificate.cert, key: certificate.private },
        fetch() {
          sourceRequests += 1;
          return new Response(null, {
            status,
            headers: {
              location: `${protocol}://localhost:${target.port}/metadata`,
            },
          });
        },
      });
      try {
        const result = await discover(source.port!);
        expect(sourceRequests).toBe(1);
        expect(result).toMatchObject({ state: "settled", endpoints: [] });
        expect(targetRequests).toBe(0);
      } finally {
        await source.stop(true);
        await target.stop(true);
      }
    },
  );
}
