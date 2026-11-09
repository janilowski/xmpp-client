import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";

// RFC 9846 §§4.4.2/4.5.1–4.5.3: initial CertificateRequest without a supplied
// client identity. Native TLS owns cryptography; the independent pinned peer
// verifies Finished before serving HTTP. Provisioned identities/PHA are separate.
// https://www.rfc-editor.org/rfc/rfc9846.html#section-4.5.1
const CERTIFICATE_REQUEST = 13;
const CERTIFICATE = 11;
const FINISHED = 20;
const SIGNATURE_ALGORITHMS = 13;
const EMPTY_CERTIFICATE = "0b00000400000000";
const TLS13_AES128_GCM_SHA256 = 0x1301;
const X25519 = 29;
const SHA256_BYTES = 32;
const RSA_KEY_BITS = 2048;
const CHILD_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 20000;
const RESPONSE_TIMEOUT_MS = 7000;
const SETUP_TIMEOUT_MS = 30000;
const SCENARIOS = ["none", "optional"] as const;
type Scenario = (typeof SCENARIOS)[number];
type Runtime = "native" | "source" | "ESM" | "minified";
type Mode = "direct" | "discovery";
type Connection = {
  requests: string[];
  authentication: string[];
  session: null | { version: number[]; cipher: number; resumed: boolean };
  group: number | null;
  http: string[];
  upgrades: { path: string; protocol: string }[];
  errors: { name: string; message: string }[];
};
type Result = {
  accepted: boolean;
  name?: string;
  authorized?: boolean;
  alpn?: string | false;
  protocol?: string;
  body?: string;
  node?: string;
};
let directory: string;

function handshake(source: string, type: number) {
  assert.match(source, /^(?:[0-9a-f]{2})+$/, "Invalid handshake hex");
  const data = Buffer.from(source, "hex");
  assert.ok(data.length >= 4, "Truncated handshake header");
  assert.equal(data[0], type, "Unexpected handshake message");
  assert.equal(
    data.readUIntBE(1, 3),
    data.length - 4,
    "Invalid handshake length",
  );
  return data.subarray(4);
}

function verifyRequest(source: string) {
  const data = handshake(source, CERTIFICATE_REQUEST);
  assert.ok(data.length >= 3, "Truncated CertificateRequest");
  assert.equal(data[0], 0, "Initial request context must be empty");
  assert.equal(
    data.readUInt16BE(1),
    data.length - 3,
    "Invalid extension length",
  );
  const algorithms: number[][] = [];
  const extensions = new Set<number>();
  for (let offset = 3; offset < data.length;) {
    assert.ok(offset + 4 <= data.length, "Truncated extension header");
    const type = data.readUInt16BE(offset);
    const length = data.readUInt16BE(offset + 2);
    offset += 4;
    assert.ok(offset + length <= data.length, "Truncated extension value");
    assert.equal(extensions.has(type), false, "Duplicate extension");
    extensions.add(type);
    if (type === SIGNATURE_ALGORITHMS) {
      const value = data.subarray(offset, offset + length);
      assert.ok(value.length >= 4, "Empty signature algorithms");
      assert.equal(
        value.readUInt16BE(0),
        value.length - 2,
        "Invalid signature list length",
      );
      assert.equal(value.length % 2, 0, "Partial signature algorithm");
      const schemes: number[] = [];
      for (let index = 2; index < value.length; index += 2) {
        schemes.push(value.readUInt16BE(index));
      }
      algorithms.push(schemes);
    }
    offset += length;
  }
  assert.equal(algorithms.length, 1, "Missing signature_algorithms");
}

function verifyAuthentication(record: Connection, scenario: Scenario) {
  assert.deepEqual(record.session, {
    version: [3, 4],
    cipher: TLS13_AES128_GCM_SHA256,
    resumed: false,
  });
  assert.equal(record.group, X25519);
  assert.deepEqual(record.errors, [], "Peer did not verify the handshake");
  assert.equal(record.http.length, 1, "No authenticated HTTP exchange");
  assert.equal(record.requests.length, scenario === "optional" ? 1 : 0);
  for (const request of record.requests) {
    verifyRequest(request);
  }
  assert.deepEqual(
    record.authentication.map((source) => Buffer.from(source, "hex")[0]),
    scenario === "optional" ? [CERTIFICATE, FINISHED] : [FINISHED],
    "Missing, reordered or unsolicited client authentication message",
  );
  if (scenario === "optional") {
    assert.equal(
      record.authentication[0],
      EMPTY_CERTIFICATE,
      "Client certificate must have empty context and list",
    );
  }
  const finished = record.authentication.at(-1);
  assert.ok(finished);
  assert.equal(handshake(finished, FINISHED).length, SHA256_BYTES);
}

test("RFC 9846 §§4.4.2/4.5.1: literal initial request and empty client certificate", () => {
  expect(() => verifyRequest("0d00000b000008000d000400020804")).not.toThrow();
  expect(handshake(EMPTY_CERTIFICATE, CERTIFICATE).toString("hex")).toBe(
    "00000000",
  );
  for (const broken of [
    "",
    "0d000003000000",
    "0d00000b010008000d000400020804",
    "0d00000b000009000d000400020804",
    "0d00000b000008000d0004000208",
    "0d00000b000008000d000400030804",
    "0d000009000006000d00020000",
    "0d00000a000007000d0003000108",
    "0d000013000010000d000400020804000d000400020804",
  ]) {
    expect(() => verifyRequest(broken)).toThrow();
  }
});

test("RFC 9846 §§4.5.1–4.5.3: authentication oracle rejects missing, reordered and unsolicited messages", () => {
  const finished = "14000020" + "a5".repeat(32);
  const record: Connection = {
    requests: ["0d00000b000008000d000400020804"],
    authentication: ["0b00000400000000", finished],
    session: { version: [3, 4], cipher: 0x1301, resumed: false },
    group: 29,
    http: ["/probe"],
    upgrades: [],
    errors: [],
  };
  expect(() => verifyAuthentication(record, "optional")).not.toThrow();
  expect(() =>
    verifyAuthentication(
      { ...record, requests: [], authentication: [finished] },
      "none",
    ),
  ).not.toThrow();
  for (const broken of [
    { ...record, requests: [] },
    { ...record, requests: [...record.requests, ...record.requests] },
    { ...record, authentication: [finished] },
    { ...record, authentication: [EMPTY_CERTIFICATE] },
    { ...record, authentication: [finished, EMPTY_CERTIFICATE] },
    {
      ...record,
      authentication: [EMPTY_CERTIFICATE, "0f00000408040000", finished],
    },
    { ...record, authentication: [EMPTY_CERTIFICATE, finished, finished] },
    { ...record, authentication: ["0b0000050100000000", finished] },
    { ...record, authentication: ["0b0000050000000100", finished] },
    { ...record, authentication: [EMPTY_CERTIFICATE, finished.slice(0, -2)] },
    {
      ...record,
      authentication: [EMPTY_CERTIFICATE, "1400001f" + "a5".repeat(31)],
    },
    { ...record, group: null },
    { ...record, session: null },
    {
      ...record,
      errors: [{ name: "TLSLocalAlert", message: "Finished invalid" }],
    },
    { ...record, http: [] },
  ]) {
    expect(() => verifyAuthentication(broken, "optional")).toThrow();
  }
  expect(() =>
    verifyAuthentication({ ...record, requests: [] }, "none"),
  ).toThrow();
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-client-auth-"));
  const authority = await generate(
    [{ name: "commonName", value: "Client-auth fixture CA" }],
    {
      keySize: RSA_KEY_BITS,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
  );
  const leaf = await generate([{ name: "commonName", value: "localhost" }], {
    keySize: RSA_KEY_BITS,
    algorithm: "sha256",
    ca: { key: authority.private, cert: authority.cert },
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
    ],
  });
  const root = new X509Certificate(authority.cert);
  const certificate = new X509Certificate(leaf.cert);
  expect(root.ca).toBe(true);
  expect(root.verify(root.publicKey)).toBe(true);
  expect(certificate.ca).toBe(false);
  expect(certificate.verify(root.publicKey)).toBe(true);
  expect(certificate.checkPrivateKey(createPrivateKey(leaf.private))).toBe(
    true,
  );
  expect(certificate.checkHost("localhost", { subject: "never" })).toBe(
    "localhost",
  );
  for (const item of [root, certificate]) {
    expect(Date.parse(item.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(item.validTo)).toBeGreaterThan(Date.now());
  }
  await Promise.all([
    writeFile(join(directory, "ca.pem"), authority.cert),
    writeFile(join(directory, "leaf.pem"), leaf.cert),
    writeFile(join(directory, "key.pem"), leaf.private),
  ]);
}, SETUP_TIMEOUT_MS);
afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function observe(scenario: Scenario, runtime: Runtime, mode: Mode) {
  const peer = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "conformance/fixtures/tls13-client-auth.py",
      resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
      directory,
      scenario,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: PEER_TIMEOUT_MS },
  );
  const reader = peer.stdout.getReader();
  const stderr = new Response(peer.stderr).text();
  let pending = "";
  let completed = false;
  const receive = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          while (!pending.includes("\n")) {
            const { done, value } = await reader.read();
            assert.equal(
              done,
              false,
              "Client-auth peer exited before its response",
            );
            pending += new TextDecoder().decode(value);
          }
          const end = pending.indexOf("\n");
          const value = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          return value;
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Client-auth peer response timed out")),
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
    expect(Number.isInteger(ready.port) && ready.port > 0).toBe(true);
    const service =
      mode === "direct"
        ? `wss://localhost:${ready.port}/xmpp`
        : `localhost:${ready.port}`;
    const source =
      runtime === "native"
        ? `
      import https from 'node:https';import {readFileSync} from 'node:fs';
      if(process.versions.bun){throw Error('Native Node required');}
      const request=https.get('https://localhost:${ready.port}/probe',{
        ca:readFileSync(${JSON.stringify(join(directory, "ca.pem"))}),rejectUnauthorized:true,
        ALPNProtocols:['http/1.1'],ecdhCurve:'X25519',minVersion:'TLSv1.3',maxVersion:'TLSv1.3'
      },response=>{
        const socket=response.socket;let body='';response.on('data',data=>body+=data);
        response.on('end',()=>console.log(JSON.stringify({accepted:true,node:process.version,authorized:socket.authorized,alpn:socket.alpnProtocol,protocol:socket.getProtocol(),body})));
      });request.on('error',error=>console.log(JSON.stringify({accepted:false,node:process.version,name:error.name,code:error.code,message:error.message})));
    `
        : `
      const {client}=${runtime === "source" ? 'await import("./src/client/index.js")' : runtime === "ESM" ? 'await import("./dist/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
      const entity=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:3000});
      entity.reconnect.stop();entity.on('error',()=>{});let result;
      try{await entity.connect(entity.options.service);result={accepted:true};}
      catch(error){result={accepted:false,name:error.name,code:error.code,message:error.message};}
      finally{await entity.stop();}console.log(JSON.stringify(result));
    `;
    const child = Bun.spawn(
      [
        runtime === "native"
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
    peer.stdin.write("snapshot\n");
    const snapshot = await receive();
    expect(snapshot.type).toBe("snapshot");
    completed = true;
    return { result, records: snapshot.records as Connection[] };
  } finally {
    if (completed && peer.exitCode === null) {
      peer.stdin.write("stop\n");
      peer.stdin.end();
    } else {
      peer.kill();
    }
    const [exit, errors] = await Promise.all([peer.exited, stderr]);
    reader.releaseLock();
    expect(errors).toBe("");
    if (completed) {
      expect(exit).toBe(0);
    }
  }
}

for (const scenario of SCENARIOS) {
  for (const runtime of ["native", "source", "ESM", "minified"] as const) {
    for (const mode of runtime === "native"
      ? (["direct"] as const)
      : (["direct", "discovery"] as const)) {
      test(
        `RFC 9846 §§4.4.2/4.5.1–4.5.3: ${runtime} ${mode}, ${scenario} client authentication`,
        async () => {
          const { result, records } = await observe(scenario, runtime, mode);
          expect(result.accepted).toBe(true);
          expect(records.length).toBe(
            runtime === "native" || mode === "direct" ? 1 : 2,
          );
          for (const record of records) {
            expect(() => verifyAuthentication(record, scenario)).not.toThrow();
          }
          const http = records.flatMap((record) => record.http);
          const upgrades = records.flatMap((record) => record.upgrades);
          if (runtime === "native") {
            expect(result.node).toMatch(/^v\d+\./);
            expect(result).toMatchObject({
              authorized: true,
              alpn: "http/1.1",
              protocol: "TLSv1.3",
              body: "authenticated client-auth peer",
            });
            expect(http).toEqual(["/probe"]);
            expect(upgrades).toEqual([]);
            return;
          }
          expect(http).toEqual(
            mode === "direct" ? ["/xmpp"] : ["/.well-known/host-meta", "/xmpp"],
          );
          expect(upgrades).toEqual([{ path: "/xmpp", protocol: "xmpp" }]);
        },
        PEER_TIMEOUT_MS,
      );
    }
  }
}
