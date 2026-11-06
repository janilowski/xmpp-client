import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";

// RFC 9325 profile entry: versions in rfc7590-versions.test.ts; cipher offers
// and current updates in rfc10015-cipher-offers.test.ts; revocation oracle and
// explicit-CRL capability in rfc9325-revocation.test.ts; CBC/ALPN/SNI in
// rfc9325-cbc.test.ts, rfc7301-alpn.test.ts and rfc6066-sni.test.ts.
// Remaining gaps: #8/#10.
// RFC 9325 §3.5 strengthens RFC 5746 §§3.4/4.1: a TLS 1.2 client must
// emit fatal handshake_failure if the server omits renegotiation_info.
// The separate RFC 9325 ClientHello-extension requirement is not established here.
// This peer completes authenticated TLS, not merely a partial ServerHello.
// https://www.rfc-editor.org/rfc/rfc9325.html#section-3.5
// https://www.rfc-editor.org/rfc/rfc5746.html#section-3.4
const CHILD_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 30000;
const RESPONSE_TIMEOUT_MS = 7000;
const SETUP_TIMEOUT_MS = 30000;
const CIPHER_ECDHE_RSA_AES128_GCM_SHA256 = 0xc02f;
const EXTENDED_MASTER_SECRET = 23;
const RENEGOTIATION_INFO = 65281;
const X25519 = 29;
const FATAL_HANDSHAKE_FAILURE = [2, 40];
type Records = {
  hellos: { version: number[]; cipher: number; extensions: number[] }[];
  sessions: { version: number[]; cipher: number; ecdhCurve: number }[];
  requests: string[];
  upgrades: { path: string; protocol: string }[];
  alerts: number[][];
  errors: { name: string; message: string }[];
};
type Result = {
  accepted: boolean;
  name?: string;
  code?: string;
  node?: string;
  authorized?: boolean;
  protocol?: string;
  body?: string;
};
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-renegotiation-"));
  const authority = await generate(
    [{ name: "commonName", value: "Renegotiation fixture CA" }],
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
  for (const cert of [root, leaf]) {
    expect(Date.parse(cert.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.now());
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

async function observe(
  runtime: "node" | "bundle",
  acknowledgement: "empty" | "absent",
  mode: "direct" | "discovery",
  group: "X25519" | "P-256" = "X25519",
) {
  const peer = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "conformance/fixtures/tls12-renegotiation.py",
      resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
      directory,
      acknowledgement,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: PEER_TIMEOUT_MS },
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
            () => reject(new Error("TLS peer response timed out")),
            RESPONSE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const ready = await receive();
    expect(ready).toMatchObject({ type: "ready", tlslite: "0.8.2" });
    expect(ready.port).toBeNumber();
    const service =
      mode === "direct"
        ? `wss://localhost:${ready.port}/xmpp`
        : `localhost:${ready.port}`;
    const source =
      runtime === "node"
        ? `
      import {connect} from 'node:tls';
      if(process.versions.bun)throw Error('Native Node required');
      let result, received='';
      const socket=connect({host:'localhost',port:${ready.port},servername:'localhost',rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.2',ecdhCurve:${JSON.stringify(group)}},()=>{
        result={accepted:true,node:process.version,authorized:socket.authorized,protocol:socket.getProtocol()};
        socket.write('GET /probe HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n');
      });
      socket.on('data',part=>received+=part);
      socket.on('end',()=>console.log(JSON.stringify({...result,body:received.split('\\r\\n\\r\\n')[1]})));
      socket.on('error',error=>console.log(JSON.stringify({accepted:false,node:process.version,name:error.name,code:error.code})));
    `
        : `
      import {client} from './dist/index.js';
      const entity=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:3000});
      entity.reconnect.stop();entity.on('error',()=>{});let result;
      try{await entity.connect(entity.options.service);result={accepted:true};}
      catch(error){result={accepted:false,name:error.name};}
      finally{await entity.stop();}console.log(JSON.stringify(result));
    `;
    const child = Bun.spawn(
      [
        runtime === "node"
          ? (process.env.XMPP_TEST_NODE ?? "node")
          : process.execPath,
        "--input-type=module",
        "--eval",
        source,
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
    const result = JSON.parse(stdout) as Result;
    expect(result.name).not.toBe("TimeoutError");
    if (runtime === "node") {
      expect(result.node).toMatch(/^v\d+\./);
    }
    peer.stdin.write("snapshot\n");
    const snapshot = await receive();
    expect(snapshot.type).toBe("snapshot");
    const records = snapshot.records as Records;
    if (group === "P-256") {
      return { result, records };
    }
    for (const session of records.sessions) {
      expect(session.ecdhCurve).toBe(X25519);
    }
    expect(records.hellos.length).toBeGreaterThan(0);
    for (const hello of records.hellos) {
      expect(hello.version).toEqual([3, 3]);
      expect(hello.cipher).toBe(CIPHER_ECDHE_RSA_AES128_GCM_SHA256);
      expect(hello.extensions).toContain(EXTENDED_MASTER_SECRET);
      expect(hello.extensions.includes(RENEGOTIATION_INFO)).toBe(
        acknowledgement === "empty",
      );
    }
    expect(
      records.errors.some(
        ({ name }) =>
          ![
            "TLSAbruptCloseError",
            "TLSRemoteAlert",
            "BrokenPipeError",
            "ConnectionResetError",
          ].includes(name),
      ),
    ).toBe(false);
    return { result, records };
  } finally {
    if (peer.exitCode === null) {
      peer.stdin.write("stop\n");
      peer.stdin.end();
    }
    const [exit, errors] = await Promise.all([peer.exited, stderr]);
    expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
  }
}

test("TLS fixture hardening: reject native forced P-256 before HTTP", async () => {
  const { result, records } = await observe("node", "empty", "direct", "P-256");
  expect(result.accepted).toBe(false);
  expect(records.sessions).toEqual([]);
  expect(records.hellos).toEqual([]);
  expect(records.requests).toEqual([]);
  expect(records.upgrades).toEqual([]);
  expect(result.code).toMatch(
    /^ERR_SSL_(SSLV3|SSL\/TLS|TLS)_ALERT_HANDSHAKE_FAILURE$/,
  );
  expect(records.errors).toEqual([
    {
      name: "TLSLocalAlert",
      message: "handshake_failure: No mutual ciphersuite",
    },
  ]);
});

for (const mode of ["direct", "discovery"] as const) {
  describe(`RFC 9325 §3.5: TLS 1.2 renegotiation acknowledgement / ${mode}`, () => {
    let rejected: Awaited<ReturnType<typeof observe>>;
    beforeAll(async () => {
      // Capable independent peer and native strict client controls are setup,
      // never hidden by a version-bounded expected-conformance failure.
      const native = await observe("node", "empty", mode);
      expect(native.result).toMatchObject({
        accepted: true,
        authorized: true,
        protocol: "TLSv1.2",
        body: "probe",
      });
      const legacy = await observe("node", "absent", mode);
      expect(legacy.result.accepted).toBe(false);
      expect(legacy.records.alerts).toEqual([FATAL_HANDSHAKE_FAILURE]);
      expect(legacy.records.sessions).toEqual([]);
      expect(legacy.records.requests).toEqual([]);
      const capable = await observe("bundle", "empty", mode);
      expect(capable.result.accepted).toBe(true);
      expect(capable.records.sessions).toEqual(
        Array.from({ length: mode === "direct" ? 1 : 2 }, () => ({
          version: [3, 3],
          cipher: CIPHER_ECDHE_RSA_AES128_GCM_SHA256,
          ecdhCurve: X25519,
        })),
      );
      expect(capable.records.requests).toEqual(
        mode === "direct" ? ["/xmpp"] : ["/.well-known/host-meta", "/xmpp"],
      );
      expect(capable.records.upgrades).toEqual([
        { path: "/xmpp", protocol: "xmpp" },
      ]);
      rejected = await observe("bundle", "absent", mode);
      // Only the reproduced complete exchange or the required rejection is a
      // coherent result. A broken peer must not become an expected failure.
      if (rejected.result.accepted) {
        expect(rejected.records.sessions).toEqual(capable.records.sessions);
        expect(rejected.records.requests).toEqual(capable.records.requests);
        expect(rejected.records.upgrades).toEqual(capable.records.upgrades);
        expect(rejected.records.alerts).toEqual([]);
      } else {
        expect(rejected.records.alerts).toEqual([FATAL_HANDSHAKE_FAILURE]);
        expect(rejected.records.sessions).toEqual([]);
        expect(rejected.records.requests).toEqual([]);
        expect(rejected.records.upgrades).toEqual([]);
      }
    }, SETUP_TIMEOUT_MS);
    const knownFailure = Bun.version === "1.4.4";
    test.failingIf(knownFailure)(
      `rejects missing acknowledgement with fatal handshake_failure before HTTP${knownFailure ? " [expected Bun 1.4.4 violation #91]" : ""}`,
      () => {
        expect(rejected.result.accepted).toBe(false);
        expect(rejected.records.alerts).toEqual([FATAL_HANDSHAKE_FAILURE]);
        expect(rejected.records.sessions).toEqual([]);
        expect(rejected.records.requests).toEqual([]);
        expect(rejected.records.upgrades).toEqual([]);
      },
    );
  });
}
