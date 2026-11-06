import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

// RFC 6066 §3; RFC 6455 §4.1(5); RFC 7395 §6: DNS SNI identifies the
// HTTPS/WSS endpoint, not the logical XMPP service. HostName uses ASCII with
// no port/trailing dot, and must not carry literal IPv4/IPv6 addresses.
// These authenticated TLS 1.3 cases do not claim IDNA or ALPN coverage.
// https://www.rfc-editor.org/rfc/rfc6066.html#section-3
const CHILD_TIMEOUT_MS = 5000;
const MESSAGE_TIMEOUT_MS = 5000;
const PEER_TIMEOUT_MS = 15000;
const TEST_TIMEOUT_MS = 20000;
const CLIENT_TIMEOUT_MS = 2000;
const TLS13 = "TLSv1.3";
const CASES = [
  ["DNS", "localhost", "localhost", "localhost"],
  ["DNS case", "LOCALHOST", "localhost", "localhost"],
  ["DNS root dot", "localhost.", "localhost", "localhost."],
  ["IPv4", "127.0.0.1", false, "127.0.0.1"],
  ["IPv6", "::1", false, "[::1]"],
] as const;
type Connection = {
  servername: string | false;
  protocol: string;
  reused: boolean;
};
type Request = Connection & { path: string; host: string };
type Message = {
  type: string;
  node?: string;
  port: number;
  probe?: object;
  records: {
    sessions: Connection[];
    requests: Request[];
    upgrades: (Request & { subprotocol: string })[];
    errors: string[];
  };
};
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-sni-"));
  const authority = await generate(
    [{ name: "commonName", value: "SNI fixture CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyCertSign: true,
          cRLSign: true,
          critical: true,
        },
      ],
    },
  );
  const leaf = await generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    ca: { key: authority.private, cert: authority.cert },
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });
  const root = new X509Certificate(authority.cert);
  const certificate = new X509Certificate(leaf.cert);
  expect(root.ca).toBe(true);
  expect(root.verify(root.publicKey)).toBe(true);
  expect(certificate.ca).toBe(false);
  expect(certificate.subject).toBe("CN=localhost");
  expect(certificate.issuer).toBe(root.subject);
  expect(certificate.verify(root.publicKey)).toBe(true);
  expect(certificate.checkPrivateKey(createPrivateKey(leaf.private))).toBe(
    true,
  );
  expect(certificate.checkHost("localhost", { subject: "never" })).toBe(
    "localhost",
  );
  expect(certificate.checkIP("127.0.0.1")).toBe("127.0.0.1");
  expect(certificate.checkIP("::1")).toBe("::1");
  expect(
    certificate.checkHost("different-xmpp-domain.test", { subject: "never" }),
  ).toBeUndefined();
  for (const parsed of [root, certificate]) {
    expect(Date.parse(parsed.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(parsed.validTo)).toBeGreaterThan(Date.now());
  }
  await Promise.all([
    writeFile(join(directory, "ca.pem"), authority.cert),
    writeFile(join(directory, "leaf.pem"), leaf.cert),
    writeFile(join(directory, "key.pem"), leaf.private),
  ]);
});

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [name, hostname, expectedSNI, authority] of CASES) {
  for (const artifact of ["source", "ESM", "minified"]) {
    for (const mode of ["direct", "discovery"]) {
      test(
        `RFC 6066 §3: ${name} SNI/Host / ${artifact} / ${mode}`,
        async () => {
          const peer = Bun.spawn(
            [
              process.env.XMPP_TEST_NODE ?? "node",
              "conformance/fixtures/tls-sni.mjs",
              directory,
              hostname,
            ],
            {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              timeout: PEER_TIMEOUT_MS,
            },
          );
          const reader = peer.stdout.getReader();
          const stderr = new Response(peer.stderr).text();
          let pending = "";
          const receive = async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                (async () => {
                  while (!pending.includes("\n")) {
                    const { done, value } = await reader.read();
                    expect(done).toBe(false);
                    pending += new TextDecoder().decode(value);
                  }
                  const end = pending.indexOf("\n");
                  const message = JSON.parse(pending.slice(0, end)) as Message;
                  pending = pending.slice(end + 1);
                  return message;
                })(),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("SNI peer response timed out")),
                    MESSAGE_TIMEOUT_MS,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          };
          let completed = false;
          const failures: unknown[] = [];
          try {
            const ready = await receive();
            expect(ready.type).toBe("ready");
            expect(ready.node).toMatch(/^v\d+\./);
            expect(Number.isInteger(ready.port) && ready.port > 0).toBe(true);
            const host = `${authority}:${ready.port}`;
            const inputHost = `${hostname === "::1" ? "[::1]" : hostname}:${ready.port}`;
            const connection = {
              servername: expectedSNI,
              protocol: TLS13,
              reused: false,
            };
            expect(ready.probe).toEqual(
              hostname === "::1"
                ? {
                    verifier: "OpenSSL",
                    exit: 0,
                    signal: null,
                    // OpenSSL 3.5 prints the peer address even in quiet mode.
                    errors: expect.stringMatching(/^(?:Connecting to ::1\n)?$/),
                    receivedHTTP: true,
                  }
                : {
                    accepted: true,
                    authorized: true,
                    protocol: TLS13,
                    reused: false,
                    receivedHTTP: true,
                  },
            );
            expect(ready.records).toEqual({
              sessions: [connection],
              requests: [{ path: "/probe", host: inputHost, ...connection }],
              upgrades: [],
              errors: [],
            });
            const service =
              mode === "direct"
                ? `wss://${inputHost}/xmpp?route=direct%20value`
                : inputHost;
            const child = Bun.spawn(
              [
                process.execPath,
                "--eval",
                `
            const {client}=${artifact === "source" ? 'await import("./src/client/index.js")' : artifact === "ESM" ? 'await import("./dist/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
            const entity=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:${CLIENT_TIMEOUT_MS}});
            entity.reconnect.stop();entity.on('error',()=>{});let result;
            try{await entity.connect(entity.options.service);result={accepted:true};}
            catch(error){result={accepted:false,name:error.name,message:error.message};}
            finally{await entity.stop();}console.log(JSON.stringify(result));
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
            const [exit, output, errors] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
            expect(JSON.parse(output)).toEqual({ accepted: true });
            peer.stdin.write("snapshot\n");
            const after = await receive();
            expect(after.type).toBe("snapshot");
            const records = after.records;
            const sessions = records.sessions.slice(
              ready.records.sessions.length,
            );
            expect(sessions.length).toBeGreaterThan(0);
            for (const session of sessions) {
              expect({
                ...session,
                servername:
                  typeof session.servername === "string"
                    ? session.servername.toLowerCase()
                    : session.servername,
              }).toEqual(connection);
            }
            // HTTP authority case is insignificant. Root-dot syntax is preserved
            // in Host, but must not leak into the TLS HostName field above.
            const requests = records.requests
              .slice(ready.records.requests.length)
              .map((request) => ({
                ...request,
                host: request.host.toLowerCase(),
                servername:
                  typeof request.servername === "string"
                    ? request.servername.toLowerCase()
                    : request.servername,
              }));
            const upgrades = records.upgrades.map((request) => ({
              ...request,
              host: request.host.toLowerCase(),
              servername:
                typeof request.servername === "string"
                  ? request.servername.toLowerCase()
                  : request.servername,
            }));
            expect(requests).toEqual(
              mode === "direct"
                ? []
                : [{ path: "/.well-known/host-meta", host, ...connection }],
            );
            expect(upgrades).toEqual([
              {
                path:
                  mode === "direct"
                    ? "/xmpp?route=direct%20value"
                    : "/xmpp?route=discovered%20value",
                host,
                subprotocol: "xmpp",
                ...connection,
              },
            ]);
            expect(records.errors).toEqual([]);
            completed = true;
          } catch (error) {
            failures.push(error);
          }
          let shutdownFailed = false;
          try {
            try {
              if (!completed) {
                peer.kill();
              } else if (peer.exitCode === null) {
                peer.stdin.write("stop\n");
                peer.stdin.end();
              }
            } catch (error) {
              shutdownFailed = true;
              failures.push(error);
              peer.kill();
            } finally {
              try {
                const [exit, errors] = await Promise.allSettled([
                  peer.exited,
                  stderr,
                ]);
                for (const result of [exit, errors]) {
                  if (result.status === "rejected") {
                    failures.push(result.reason);
                  }
                }
                if (
                  completed &&
                  !shutdownFailed &&
                  exit.status === "fulfilled" &&
                  errors.status === "fulfilled"
                ) {
                  expect({ exit: exit.value, errors: errors.value }).toEqual({
                    exit: 0,
                    errors: "",
                  });
                }
              } finally {
                reader.releaseLock();
              }
            }
          } catch (error) {
            failures.push(error);
          }
          if (failures.length) {
            throw failures[0];
          }
        },
        TEST_TIMEOUT_MS,
      );
    }
  }
}
