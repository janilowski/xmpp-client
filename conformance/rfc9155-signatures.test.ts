import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";

// RFC 9155 entry point: §2 ClientHello offers are exercised with RFC 10015 in
// rfc10015-cipher-offers.test.ts and ../test/browser-cipher-offers.test.ts.
// §4 requires fatal illegal_parameter on MD5/SHA-1 ServerKeyExchange signatures.
// These cases concern TLS handshake signatures, not SHA-1 HMAC or certificate
// signatures. Client-certificate CertificateVerify (§5) is not configured here.
// https://www.rfc-editor.org/rfc/rfc9155.html#section-4
const RESPONSE_TIMEOUT_MS = 7000;
const CHILD_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 30000;
const SETUP_TIMEOUT_MS = 30000;
const FATAL_ILLEGAL_PARAMETER = [2, 47];
const CIPHER_ECDHE_RSA_AES128_GCM_SHA256 = 0xc02f;
const X25519 = 29;
const RSA_SIGNATURE = 1;
const SHA256_HASH = 4;
const SHA1_HASH = 2;
const MD5_HASH = 1;
// RFC 8017 Appendix B.1: independent DER DigestInfo prefixes.
const DIGEST_INFO_PREFIXES = {
  sha256: "3031300d060960864801650304020105000420",
  sha1: "3021300906052b0e03021a05000414",
  md5: "3020300c06082a864886f70d020505000410",
};
type Signature = { scheme: number[]; input: string; signature: string };
type Records = {
  hellos: { version: number[]; cipher: number; extensions: number[] }[];
  signatures: Signature[];
  sessions: { version: number[]; cipher: number; ecdhCurve: number }[];
  requests: string[];
  upgrades: { path: string; protocol: string }[];
  alerts: number[][];
  errors: { name: string; message: string }[];
};
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-tls-signatures-"));
  const authority = await generate(
    [{ name: "commonName", value: "Handshake signature fixture CA" }],
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
  for (const certificate of [root, leaf]) {
    expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
  }
  await Promise.all([
    writeFile(join(directory, "ca.pem"), authority.cert),
    writeFile(join(directory, "leaf.pem"), certificate.cert),
    writeFile(join(directory, "key.pem"), certificate.private),
  ]);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["direct", "discovery"]) {
  for (const artifact of ["source", "ESM", "minified"]) {
    for (const [hash, hashId] of [
      ["sha256", SHA256_HASH],
      ["sha1", SHA1_HASH],
      ["md5", MD5_HASH],
    ] as const) {
      test(
        `RFC 9155 §4: Bun ${artifact} ${mode}, forced ${hash} ServerKeyExchange`,
        async () => {
          const peer = Bun.spawn(
            [
              process.env.XMPP_TEST_PYTHON ?? "python3",
              "conformance/fixtures/tls12-renegotiation.py",
              resolve(
                process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer",
              ),
              directory,
              "empty",
              hash,
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
            const operation = (async () => {
              while (!pending.includes("\n")) {
                const { done, value } = await reader.read();
                expect(done).toBe(false);
                pending += new TextDecoder().decode(value);
              }
              const end = pending.indexOf("\n");
              const value = JSON.parse(pending.slice(0, end));
              pending = pending.slice(end + 1);
              return value;
            })();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                operation,
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(new Error("Signature peer response timed out")),
                    RESPONSE_TIMEOUT_MS,
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
            expect(ready).toMatchObject({ type: "ready", tlslite: "0.8.2" });
            expect(ready.port).toBeNumber();
            const service =
              mode === "direct"
                ? `wss://localhost:${ready.port}/xmpp`
                : `localhost:${ready.port}`;
            const child = Bun.spawn(
              [
                process.execPath,
                "--eval",
                `
          const {client}=${
            artifact === "source"
              ? 'await import("./src/client/index.js")'
              : artifact === "ESM"
                ? 'await import("./dist/index.js")'
                : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'
          };
          const entity=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:3000});
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
                  NODE_EXTRA_CA_CERTS: join(directory, "ca.pem"),
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
            expect(result.name).not.toBe("TimeoutError");
            peer.stdin.write("snapshot\n");
            const snapshot = await receive();
            expect(snapshot.type).toBe("snapshot");
            const records = snapshot.records as Records;
            expect(records.hellos.length).toBeGreaterThan(0);
            expect(records.signatures).toHaveLength(records.hellos.length);
            for (const signature of records.signatures) {
              expect(signature.scheme).toEqual([hashId, RSA_SIGNATURE]);
              expect(signature.input).toMatch(/^[0-9a-f]+$/);
              expect(signature.signature).toMatch(/^[0-9a-f]+$/);
            }
            // Native RSA padding + independent DigestInfo checks exact randoms and
            // parameters, without enabling SHA-1 verification in host crypto policy.
            const verifier = Bun.spawn(
              [
                process.env.XMPP_TEST_NODE ?? "node",
                "--input-type=module",
                "--eval",
                `
          import {constants,createHash,createPublicKey,publicDecrypt} from 'node:crypto';import {readFileSync} from 'node:fs';
          if(process.versions.bun){throw Error('Native Node required');}
          const key=createPublicKey(readFileSync(process.argv[1]));
          const prefix=Buffer.from(${JSON.stringify(DIGEST_INFO_PREFIXES[hash])},'hex');
          console.log(JSON.stringify(JSON.parse(process.argv[2]).map(({input,signature})=>{
            const expected=Buffer.concat([prefix,createHash(${JSON.stringify(hash)}).update(Buffer.from(input,'hex')).digest()]);
            return publicDecrypt({key,padding:constants.RSA_PKCS1_PADDING},Buffer.from(signature,'hex')).equals(expected);
          })));
        `,
                join(directory, "leaf.pem"),
                JSON.stringify(records.signatures),
              ],
              { stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS },
            );
            const [verifiedExit, verified, verifyErrors] = await Promise.all([
              verifier.exited,
              new Response(verifier.stdout).text(),
              new Response(verifier.stderr).text(),
            ]);
            expect({ verifiedExit, verifyErrors }).toEqual({
              verifiedExit: 0,
              verifyErrors: "",
            });
            expect(JSON.parse(verified)).toEqual(
              records.signatures.map(() => true),
            );
            if (hash === "sha256") {
              expect(result).toEqual({ accepted: true });
              expect(records.sessions).toEqual(
                records.hellos.map(() => ({
                  version: [3, 3],
                  cipher: CIPHER_ECDHE_RSA_AES128_GCM_SHA256,
                  ecdhCurve: X25519,
                })),
              );
              expect(records.requests).toEqual(
                mode === "direct"
                  ? ["/xmpp"]
                  : ["/.well-known/host-meta", "/xmpp"],
              );
              expect(records.upgrades).toEqual([
                { path: "/xmpp", protocol: "xmpp" },
              ]);
            } else {
              expect(result.accepted).toBe(false);
              expect(records.sessions).toEqual([]);
              expect(records.requests).toEqual([]);
              expect(records.upgrades).toEqual([]);
              expect(records.alerts).toEqual(
                records.hellos.map(() => FATAL_ILLEGAL_PARAMETER),
              );
            }
            completed = true;
          } catch (error) {
            failures.push(error);
          }
          // Preserve the first failure while reaping the peer and releasing
          // its reader, including failed observations or a broken shutdown pipe.
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
}
