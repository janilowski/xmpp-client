import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { generate } from "selfsigned";

// RFC 7395 §§3.9/6; RFC 7590 §3.4; RFC 9525 §§4/6; RFC 5280 §6.1.3.
// Linux Chromium local trust: https://chromium.googlesource.com/chromium/src/+/main/docs/linux/cert_management.md
// A child HOME and XDG_DATA_HOME isolate NSS; a browser profile alone does not.
const HTTP_BAD_REQUEST = 400;
const DAY_MS = 86_400_000;
const CONNECTION_TIMEOUT_MS = 2000;
const OBSERVATION_MS = 3000;
const TOOL_TIMEOUT_MS = 5000;
const TEST_TIMEOUT_MS = 20000;
const XRD = "http://docs.oasis-open.org/ns/xri/xrd-1.0";
const RELATION = "urn:xmpp:alt-connections:websocket";
const CA_NICKNAME = "Disposable XMPP browser CA";
type Mode = "direct WSS" | "HTTPS discovery";
type Scenario = "valid" | "wrong-name" | "expired" | "CN-only";
type Certificate = Awaited<ReturnType<typeof generate>>;

function certutil(args: string[]) {
  const child = spawnSync(process.env.XMPP_CERTUTIL ?? "certutil", args, {
    encoding: "utf8",
    timeout: TOOL_TIMEOUT_MS,
  });
  expect(child.error).toBeUndefined();
  expect({ status: child.status, stderr: child.stderr }).toMatchObject({
    status: 0,
  });
  return child.stdout;
}

function endpoint(certificate: Certificate) {
  const counts = { discoveries: 0, upgrades: 0 };
  let target: string | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: certificate.cert, key: certificate.private },
    fetch(request, server) {
      if (new URL(request.url).pathname === "/.well-known/host-meta") {
        counts.discoveries++;
        return new Response(
          `<XRD xmlns="${XRD}"><Link rel="${RELATION}" href="${target ?? `wss://localhost:${server.port}/xmpp`}"/></XRD>`,
          {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-store",
              "Content-Type": "application/xrd+xml",
            },
          },
        );
      }
      counts.upgrades++;
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
  return {
    server,
    counts,
    service: `localhost:${server.port}`,
    wss: `wss://localhost:${server.port}/xmpp`,
    discover(address: string) {
      target = address;
    },
  };
}

async function connect(
  context: BrowserContext,
  origin: string,
  service: string,
  expectedError?: string,
) {
  const page = await context.newPage();
  const nativeErrors: string[] = [];
  const observed = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const record = (message: string) => {
    nativeErrors.push(message);
    if (expectedError && message.includes(expectedError)) {
      observed.resolve();
    }
  };
  page.on("console", (message) => {
    if (message.type() === "error") {
      record(message.text());
    }
  });
  page.on("requestfailed", (request) =>
    record(request.failure()?.errorText ?? ""),
  );
  page.on("websocket", (socket) => socket.on("socketerror", record));
  try {
    await page.goto(origin);
    await page.addScriptTag({ path: "dist/xmpp.min.js" });
    const outcome = await page.evaluate(
      async ({ service, timeout }) => {
        const bundle = globalThis as typeof globalThis & {
          XMPP: typeof import("../src/index.ts");
        };
        const xmpp = bundle.XMPP.client({
          service,
          domain: "distinct-xmpp-service.test",
          timeout,
        }) as ReturnType<typeof bundle.XMPP.client> & {
          connect(service: string): Promise<void>;
        };
        xmpp.reconnect.stop();
        xmpp.on("error", () => {});
        try {
          await xmpp.connect(service);
          return "accepted";
        } catch (error) {
          return error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : "rejected";
        } finally {
          await xmpp.stop();
        }
      },
      { service, timeout: CONNECTION_TIMEOUT_MS },
    );
    if (expectedError) {
      // Native TLS diagnostics distinguish validation from CORS/network failure.
      timer = setTimeout(() => observed.resolve(), OBSERVATION_MS);
      await observed.promise;
      expect({ service, expectedError, nativeErrors }).toMatchObject({
        nativeErrors: expect.arrayContaining([
          expect.stringContaining(expectedError),
        ]),
      });
    }
    expect(outcome).toBe(expectedError ? "rejected" : "accepted");
  } finally {
    clearTimeout(timer);
    await page.close();
  }
}

test.each(["direct WSS", "HTTPS discovery"] as const)(
  "Chromium native CA/hostname/expiry validation through bundled client / %s",
  async (mode: Mode) => {
    expect(process.platform).toBe("linux");
    const directory = await mkdtemp(join(tmpdir(), "xmpp-browser-trust-"));
    const home = join(directory, "home");
    const data = join(home, ".local", "share");
    const database = `sql:${join(data, "pki", "nssdb")}`;
    const endpoints: ReturnType<typeof endpoint>[] = [];
    let context: BrowserContext | undefined;
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("<!doctype html><title>TLS validation</title>"),
    });
    try {
      const authority = await generate(
        [{ name: "commonName", value: CA_NICKNAME }],
        {
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
        },
      );
      const parsedCA = new X509Certificate(authority.cert);
      const now = Date.now();
      expect(parsedCA.ca).toBe(true);
      expect(parsedCA.issuer).toBe(parsedCA.subject);
      expect(parsedCA.verify(parsedCA.publicKey)).toBe(true);
      expect(
        parsedCA.checkPrivateKey(createPrivateKey(authority.private)),
      ).toBe(true);
      expect(Date.parse(parsedCA.validFrom)).toBeLessThanOrEqual(now);
      expect(Date.parse(parsedCA.validTo)).toBeGreaterThan(now);
      const scenarios = new Map<Scenario, ReturnType<typeof endpoint>>();
      for (const scenario of [
        "valid",
        "wrong-name",
        "expired",
        "CN-only",
      ] as const) {
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
              {
                name: "keyUsage",
                digitalSignature: true,
                keyEncipherment: true,
              },
              { name: "extKeyUsage", serverAuth: true },
              ...(scenario === "CN-only"
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
        expect(parsed.ca).toBe(false);
        expect(parsed.subject).toBe("CN=localhost");
        expect(parsed.issuer).toBe(parsedCA.subject);
        expect(parsed.verify(parsedCA.publicKey)).toBe(true);
        expect(
          parsed.checkPrivateKey(createPrivateKey(certificate.private)),
        ).toBe(true);
        expect(Date.parse(parsed.validFrom)).toBeLessThan(now);
        expect(Date.parse(parsed.validTo) > now).toBe(scenario !== "expired");
        expect(parsed.subjectAltName).toBe(
          scenario === "CN-only"
            ? undefined
            : `DNS:${scenario === "wrong-name" ? "wrong.invalid" : "localhost"}`,
        );
        expect(
          parsed.checkHost("localhost", { subject: "never" }) !== undefined,
        ).toBe(scenario !== "wrong-name" && scenario !== "CN-only");
        const remote = endpoint(certificate);
        endpoints.push(remote);
        scenarios.set(scenario, remote);
      }
      await mkdir(join(data, "pki", "nssdb"), { recursive: true });
      const rootFile = join(directory, "root.pem");
      await writeFile(rootFile, authority.cert);
      certutil(["-N", "--empty-password", "-d", database]);
      const launch = (profile: string) =>
        chromium.launchPersistentContext(join(directory, profile), {
          channel: "chromium",
          ignoreHTTPSErrors: false,
          env: {
            ...process.env,
            HOME: home,
            XDG_DATA_HOME: data,
            XDG_CONFIG_HOME: join(home, ".config"),
          },
        });
      const valid = scenarios.get("valid")!;
      // The disposable fixture CA is absent; public/system roots still exist.
      context = await launch("fixture-ca-absent");
      await connect(
        context,
        `http://127.0.0.1:${origin.port}`,
        mode === "direct WSS" ? valid.wss : valid.service,
        "ERR_CERT_AUTHORITY_INVALID",
      );
      expect(valid.counts).toEqual({ discoveries: 0, upgrades: 0 });
      await context.close();
      context = undefined;

      certutil([
        "-A",
        "-d",
        database,
        "-n",
        CA_NICKNAME,
        "-t",
        "C,,",
        "-i",
        rootFile,
      ]);
      const imported = new X509Certificate(
        certutil(["-L", "-d", database, "-n", CA_NICKNAME, "-a"]),
      );
      expect(imported.fingerprint256).toBe(parsedCA.fingerprint256);
      context = await launch("fixture-ca-present");
      await connect(
        context,
        `http://127.0.0.1:${origin.port}`,
        mode === "direct WSS" ? valid.wss : valid.service,
      );
      expect(valid.counts).toEqual({
        discoveries: mode === "HTTPS discovery" ? 1 : 0,
        upgrades: 1,
      });
      for (const [scenario, error] of [
        ["wrong-name", "ERR_CERT_COMMON_NAME_INVALID"],
        ["expired", "ERR_CERT_DATE_INVALID"],
        ["CN-only", "ERR_CERT_COMMON_NAME_INVALID"],
      ] as const) {
        const remote = scenarios.get(scenario)!;
        await connect(
          context,
          `http://127.0.0.1:${origin.port}`,
          mode === "direct WSS" ? remote.wss : remote.service,
          error,
        );
        expect(remote.counts).toEqual({ discoveries: 0, upgrades: 0 });
      }
      if (mode === "HTTPS discovery") {
        // Successful HTTPS delegation must not waive the discovered WSS check.
        for (const [scenario, error] of [
          ["wrong-name", "ERR_CERT_COMMON_NAME_INVALID"],
          ["expired", "ERR_CERT_DATE_INVALID"],
          ["CN-only", "ERR_CERT_COMMON_NAME_INVALID"],
        ] as const) {
          const remote = scenarios.get(scenario)!;
          const before = valid.counts.discoveries;
          valid.discover(remote.wss);
          await connect(
            context,
            `http://127.0.0.1:${origin.port}`,
            valid.service,
            error,
          );
          expect(valid.counts.discoveries).toBe(before + 1);
          expect(valid.counts.upgrades).toBe(1);
          expect(remote.counts).toEqual({ discoveries: 0, upgrades: 0 });
        }
      }
    } finally {
      await context?.close();
      await Promise.all(endpoints.map((remote) => remote.server.stop(true)));
      await origin.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
