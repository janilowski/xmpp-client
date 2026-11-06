import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTLSCertificates } from "./tls-certificates.ts";

// RFC 9846 §9.1 entry point: TLS 1.3 mandatory cipher/signature use.
// P-256/X25519 key exchange: rfc7590-versions.test.ts; initial offers:
// rfc10015-cipher-offers.test.ts. Native browser use: ../test/browser-tls.test.ts.
// A sole configured server signature scheme + fresh authenticated handshake
// establishes CertificateVerify use; getSharedSigalgs is not a selection getter.
// https://www.rfc-editor.org/rfc/rfc9846.html#section-9.1
const TLS13 = "TLSv1.3";
const AES128_GCM_SHA256 = "TLS_AES_128_GCM_SHA256";
const MESSAGE_TIMEOUT_MS = 7000;
const CHILD_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 30000;
const SETUP_TIMEOUT_MS = 30000;
let directory: string;
let certificates: Awaited<ReturnType<typeof createTLSCertificates>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-tls-algorithms-"));
  certificates = await createTLSCertificates(directory);
}, SETUP_TIMEOUT_MS);
afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const profile of ["rsa-pkcs1", "ecdsa-p256", "rsa-pss"]) {
  for (const artifact of ["source", "ESM", "minified"]) {
    test(
      `RFC 9846 §9.1: ${profile} certificates and TLS 1.3 AES128 / ${artifact}`,
      async () => {
        const certificate = certificates.find(({ name }) => name === profile)!;
        const peer = Bun.spawn(
          [
            process.env.XMPP_TEST_NODE ?? "node",
            "conformance/fixtures/tls-versions.mjs",
            certificate.directory,
            TLS13,
            TLS13,
            "",
            profile,
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
                const message = JSON.parse(pending.slice(0, end));
                pending = pending.slice(end + 1);
                return message;
              })(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Algorithm peer response timed out")),
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
          expect(ready.probe).toEqual({
            accepted: true,
            protocol: TLS13,
            authorized: true,
            authorizationError: null,
            receivedHTTP: true,
            reused: false,
            cipher: AES128_GCM_SHA256,
          });
          expect(ready.records).toEqual({
            sessions: [TLS13],
            handshakes: [
              { protocol: TLS13, reused: false, cipher: AES128_GCM_SHA256 },
            ],
            requests: [
              { path: "/probe", protocol: TLS13, cipher: AES128_GCM_SHA256 },
            ],
            upgrades: [],
            errors: [],
          });
          // Independent peer controls: capable setup must refuse clients which
          // offer no matching TLS 1.3 cipher or CertificateVerify scheme.
          // Keep PKCS1/SHA256 legal for certificates, not CertificateVerify.
          if (profile === "rsa-pkcs1" && artifact === "source") {
            for (const control of ["cipher", "signature"]) {
              const child = Bun.spawn(
                [
                  process.env.XMPP_TEST_NODE ?? "node",
                  "--input-type=module",
                  "--eval",
                  `
            import {connect} from 'node:tls';
            if(process.versions.bun){throw Error('Native Node required');}
            const socket=connect({host:'localhost',port:${ready.port},servername:'localhost',rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
              ciphers:${JSON.stringify(control === "cipher" ? "TLS_AES_256_GCM_SHA384" : AES128_GCM_SHA256)},
              sigalgs:${JSON.stringify(`${control === "signature" ? "rsa_pss_rsae_sha384" : "rsa_pss_rsae_sha256"}:rsa_pkcs1_sha256`)}},()=>{console.log(JSON.stringify({accepted:true}));socket.end();});
            socket.on('error',error=>console.log(JSON.stringify({accepted:false,code:error.code})));
          `,
                ],
                {
                  stdout: "pipe",
                  stderr: "pipe",
                  timeout: CHILD_TIMEOUT_MS,
                  env: {
                    ...process.env,
                    NODE_TLS_REJECT_UNAUTHORIZED: "1",
                    NODE_EXTRA_CA_CERTS: join(certificate.directory, "ca.pem"),
                  },
                },
              );
              const [exit, stdout, errors] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ]);
              expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
              const result = JSON.parse(stdout);
              expect(result.accepted).toBe(false);
              expect(result.code).toMatch(
                /^ERR_SSL_(SSLV3|SSL\/TLS|TLS)_ALERT_HANDSHAKE_FAILURE$/,
              );
            }
            peer.stdin.write("snapshot\n");
            const controls = await receive();
            expect(controls.records.sessions).toEqual(ready.records.sessions);
            expect(controls.records.requests).toEqual(ready.records.requests);
            expect(controls.records.upgrades).toEqual([]);
            expect(controls.records.errors).toEqual([
              "ERR_SSL_NO_SHARED_CIPHER",
              "ERR_SSL_NO_SHARED_SIGNATURE_ALGORITHMS",
            ]);
          }
          for (const mode of ["direct", "discovery"]) {
            peer.stdin.write("snapshot\n");
            const before = await receive();
            const service =
              mode === "direct"
                ? `wss://localhost:${ready.port}/xmpp`
                : `localhost:${ready.port}`;
            const child = Bun.spawn(
              [
                process.execPath,
                "--eval",
                `
            const {client}=${artifact === "source" ? 'await import("./src/client/index.js")' : artifact === "ESM" ? 'await import("./dist/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
            const entity=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:2000});
            entity.reconnect.stop();entity.on('error',()=>{});let result;
            try{await entity.connect(entity.options.service);result={accepted:true};}
            catch(error){result={accepted:false,name:error.name};}
            finally{await entity.stop();}console.log(JSON.stringify(result));
          `,
              ],
              {
                stdout: "pipe",
                stderr: "pipe",
                timeout: CHILD_TIMEOUT_MS,
                env: {
                  ...process.env,
                  NODE_TLS_REJECT_UNAUTHORIZED: "1",
                  NODE_EXTRA_CA_CERTS: join(certificate.directory, "ca.pem"),
                },
              },
            );
            const [exit, stdout, errors] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
            expect(JSON.parse(stdout)).toEqual({ accepted: true });
            peer.stdin.write("snapshot\n");
            const after = await receive();
            const sessions = after.records.sessions.slice(
              before.records.sessions.length,
            );
            expect(sessions.length).toBeGreaterThan(0);
            expect(
              sessions.every((protocol: string) => protocol === TLS13),
            ).toBe(true);
            expect(
              after.records.handshakes.slice(before.records.handshakes.length),
            ).toEqual(
              sessions.map((protocol: string) => ({
                protocol,
                reused: false,
                cipher: AES128_GCM_SHA256,
              })),
            );
            expect(
              after.records.requests.slice(before.records.requests.length),
            ).toEqual(
              mode === "direct"
                ? []
                : [
                    {
                      path: "/.well-known/host-meta",
                      protocol: TLS13,
                      cipher: AES128_GCM_SHA256,
                    },
                  ],
            );
            expect(
              after.records.upgrades.slice(before.records.upgrades.length),
            ).toEqual([
              {
                path: "/xmpp",
                protocol: TLS13,
                subprotocol: "xmpp",
                cipher: AES128_GCM_SHA256,
              },
            ]);
            expect(
              after.records.errors.slice(before.records.errors.length),
            ).toEqual([]);
          }
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
      PEER_TIMEOUT_MS,
    );
  }
}
