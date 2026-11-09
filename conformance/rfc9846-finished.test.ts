import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReadableStream } from "node:stream/web";
import { generate } from "selfsigned";

// RFC 9846 §4.5.3: a valid certificate and CertificateVerify do not replace
// Finished authentication. The pinned peer changes one Finished bit before
// ordinary TLS record encryption; no JavaScript cryptography or bad AEAD tag.
// https://www.rfc-editor.org/rfc/rfc9846.html#section-4.5.3
const FINISHED_HEADER = "14000020";
const FINISHED_BYTES = 36;
const FATAL = 2;
const DECRYPT_ERROR = 51;
const GENERAL_ERROR = 117;
const TLS13_AES128_GCM_SHA256 = 0x1301;
const X25519 = 29;
const RSA_KEY_BITS = 2048;
const CHILD_TIMEOUT_MS = 12000;
const PEER_TIMEOUT_MS = 15000;
const RESPONSE_TIMEOUT_MS = 7000;
const SETUP_TIMEOUT_MS = 30000;
const SCENARIOS = ["valid", "invalid"] as const;
type Scenario = (typeof SCENARIOS)[number];
type Runtime = "native" | "source" | "ESM" | "minified";
type Mode = "direct" | "discovery";
type Connection = {
  hellos: string[];
  responses: string[];
  finished: { original: string; sent: string }[];
  session: null | { version: number[]; cipher: number; resumed: boolean };
  group: number | null;
  requests: string[];
  upgrades: { path: string; protocol: string }[];
  alerts: number[][];
  errors: { name: string; message: string }[];
};
type Result = {
  phase: string;
  accepted: boolean;
  name?: string;
  code?: string;
  message?: string;
  authorized?: boolean;
  alpn?: string | false;
  protocol?: string;
  body?: string;
  node?: string;
};
let directory: string;

function verifyFinished(record: Connection, scenario: Scenario) {
  assert.equal(
    record.finished.length,
    1,
    "Missing or repeated Finished witness",
  );
  const { original, sent } = record.finished[0];
  for (const source of [original, sent]) {
    assert.match(source, /^(?:[0-9a-f]{2})+$/, "Invalid Finished hex");
    assert.equal(source.length, FINISHED_BYTES * 2, "Invalid Finished length");
    assert.equal(
      source.slice(0, 8),
      FINISHED_HEADER,
      "Invalid Finished header",
    );
  }
  if (scenario === "valid") {
    assert.equal(sent, original, "Valid Finished was modified");
    return;
  }
  assert.equal(
    sent.slice(0, -2),
    original.slice(0, -2),
    "Unrelated Finished bytes changed",
  );
  assert.equal(
    Number.parseInt(sent.slice(-2), 16) ^
      Number.parseInt(original.slice(-2), 16),
    1,
    "Finished authentication bit was not changed",
  );
}

function verifyRefusal(result: Result, records: Connection[]) {
  assert.equal(result.accepted, false, "Client accepted an invalid Finished");
  assert.notEqual(
    result.name,
    "TimeoutError",
    "Timeout is not Finished refusal",
  );
  assert.ok(records.length > 0, "No client connection observed");
  for (const record of records) {
    verifyFinished(record, "invalid");
    assert.ok(record.hellos.length > 0, "No ClientHello observed");
    assert.equal(record.group, X25519);
    assert.equal(record.session, null, "TLS session accepted invalid Finished");
    assert.deepEqual(
      record.requests,
      [],
      "HTTP sent before Finished authentication",
    );
    assert.deepEqual(
      record.upgrades,
      [],
      "WebSocket upgraded despite invalid Finished",
    );
    assert.equal(
      record.alerts.length,
      1,
      "Missing or repeated fatal TLS refusal",
    );
    assert.equal(record.alerts[0].length, 2, "Invalid TLS alert length");
    assert.equal(record.alerts[0][0], FATAL, "Finished refusal must be fatal");
    // §6.2 permits concealing the specific error, not an incorrect diagnosis.
    assert.ok(
      [DECRYPT_ERROR, GENERAL_ERROR].includes(record.alerts[0][1]),
      "Wrong Finished refusal alert",
    );
    assert.equal(record.errors.length, 1);
    assert.equal(
      record.errors[0].name,
      "TLSRemoteAlert",
      "Peer failed before authenticated refusal",
    );
  }
}

function verifyNativeRefusal(result: Result, records: Connection[]) {
  // Node HTTPS is an independent digest-check control, not a supported-client
  // conformance claim: it can destroy its transport before flushing the alert.
  assert.equal(result.accepted, false);
  assert.equal(result.code, "EPROTO");
  assert.match(
    result.message ?? "",
    /tls_process_finished:digest check failed/,
  );
  assert.equal(records.length, 1);
  for (const record of records) {
    verifyFinished(record, "invalid");
    assert.ok(record.hellos.length > 0);
    assert.equal(record.group, X25519);
    assert.equal(record.session, null);
    assert.deepEqual(record.requests, []);
    assert.deepEqual(record.upgrades, []);
    assert.equal(record.errors.length, 1);
    assert.ok(
      ["TLSRemoteAlert", "TLSAbruptCloseError"].includes(record.errors[0].name),
    );
  }
}

test("RFC 9846 §4.5.3: literal witness isolates a Finished authentication bit", () => {
  const original = "14000020" + "a5".repeat(32);
  const sent = original.slice(0, -2) + "a4";
  const record = { finished: [{ original, sent }] } as Connection;
  expect(() => verifyFinished(record, "invalid")).not.toThrow();
  expect(() =>
    verifyFinished(
      { ...record, finished: [{ original, sent: original }] },
      "valid",
    ),
  ).not.toThrow();
  for (const broken of [
    { finished: [] },
    { finished: [...record.finished, ...record.finished] },
    { finished: [{ original, sent: original }] },
    { finished: [{ original, sent: sent.slice(0, -2) }] },
    { finished: [{ original, sent: sent.slice(0, -2) + "a7" }] },
    { finished: [{ original, sent: "14000021" + sent.slice(8) }] },
    {
      finished: [{ original, sent: sent.slice(0, 10) + "a4" + sent.slice(12) }],
    },
  ]) {
    expect(() => verifyFinished(broken as Connection, "invalid")).toThrow();
  }
});

test("RFC 9846 §§4.5.3/6.2: refusal oracle rejects acceptance, wrong alerts and application leakage", () => {
  const original = "14000020" + "a5".repeat(32);
  const record: Connection = {
    hellos: ["01"],
    responses: [],
    finished: [{ original, sent: original.slice(0, -2) + "a4" }],
    session: null,
    group: 29,
    requests: [],
    upgrades: [],
    alerts: [[2, 51]],
    errors: [{ name: "TLSRemoteAlert", message: "decrypt_error" }],
  };
  const refused: Result = { phase: "result", accepted: false };
  expect(() => verifyRefusal(refused, [record])).not.toThrow();
  expect(() =>
    verifyRefusal(refused, [{ ...record, alerts: [[2, 117]] }]),
  ).not.toThrow();
  expect(() =>
    verifyRefusal({ ...refused, accepted: true }, [record]),
  ).toThrow();
  expect(() =>
    verifyRefusal({ ...refused, name: "TimeoutError" }, [record]),
  ).toThrow();
  expect(() => verifyRefusal(refused, [])).toThrow();
  for (const broken of [
    { ...record, alerts: [] },
    { ...record, alerts: [[1, 51]] },
    { ...record, alerts: [[1, 117]] },
    { ...record, alerts: [[2, 51, 0]] },
    ...[0, 20, 47, 50, 255].map((description) => ({
      ...record,
      alerts: [[2, description]],
    })),
    {
      ...record,
      alerts: [
        [2, 51],
        [2, 51],
      ],
    },
    { ...record, hellos: [] },
    { ...record, errors: [] },
    {
      ...record,
      errors: [{ name: "TimeoutError", message: "Peer timed out" }],
    },
    { ...record, group: null },
    { ...record, requests: ["/.well-known/host-meta"] },
    { ...record, upgrades: [{ path: "/xmpp", protocol: "xmpp" }] },
    { ...record, session: { version: [3, 4], cipher: 0x1301, resumed: false } },
  ]) {
    expect(() => verifyRefusal(refused, [broken])).toThrow();
  }
  const native = {
    ...refused,
    code: "EPROTO",
    message: "tls_process_finished:digest check failed",
  };
  expect(() => verifyNativeRefusal(native, [record])).not.toThrow();
  expect(() =>
    verifyNativeRefusal({ ...native, accepted: true }, [record]),
  ).toThrow();
  expect(() =>
    verifyNativeRefusal({ ...native, message: "tls_record:bad record mac" }, [
      record,
    ]),
  ).toThrow();
  expect(() =>
    verifyNativeRefusal(native, [{ ...record, requests: ["/probe"] }]),
  ).toThrow();
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-finished-"));
  const authority = await generate(
    [{ name: "commonName", value: "Finished fixture CA" }],
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

function messages(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let pending = "";
  return {
    reader,
    async receive() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            while (!pending.includes("\n")) {
              const { done, value } = await reader.read();
              assert.equal(
                done,
                false,
                "Finished child exited before its response",
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
              () => reject(new Error("Finished child response timed out")),
              RESPONSE_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function observe(scenario: Scenario, runtime: Runtime, mode: Mode) {
  const peer = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "conformance/fixtures/tls-alpn.py",
      resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
      directory,
      "4",
      "offered",
      scenario === "valid" ? "none" : "finished",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: PEER_TIMEOUT_MS },
  );
  const peerMessages = messages(peer.stdout);
  const peerErrors = new Response(peer.stderr).text();
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let childMessages: ReturnType<typeof messages> | undefined;
  let childErrors: Promise<string> | undefined;
  let completed = false;
  try {
    const ready = await peerMessages.receive();
    expect(ready).toMatchObject({ type: "ready", tlslite: "0.8.2" });
    expect(Number.isInteger(ready.port) && ready.port > 0).toBe(true);
    const service =
      mode === "direct"
        ? `wss://localhost:${ready.port}/xmpp`
        : `localhost:${ready.port}`;
    const waiting = `
      import {createInterface} from 'node:readline';
      const input=createInterface({input:process.stdin});const keepAlive=setInterval(()=>{},1000);
      const released=(async()=>{for await(const line of input){if(line==='release'){break;}}})();
    `;
    const source =
      waiting +
      (runtime === "native"
        ? `
      import https from 'node:https';import {readFileSync} from 'node:fs';
      if(process.versions.bun){throw Error('Native Node required');}
      const result=await new Promise(resolve=>{
        const request=https.get('https://localhost:${ready.port}/probe',{
          ca:readFileSync(${JSON.stringify(join(directory, "ca.pem"))}),rejectUnauthorized:true,
          ALPNProtocols:['http/1.1'],ecdhCurve:'X25519',minVersion:'TLSv1.3',maxVersion:'TLSv1.3'
        },response=>{
          const socket=response.socket;let body='';response.on('data',data=>body+=data);
          response.on('end',()=>resolve({phase:'result',accepted:true,node:process.version,authorized:socket.authorized,alpn:socket.alpnProtocol,protocol:socket.getProtocol(),body}));
        });request.on('error',error=>resolve({phase:'result',accepted:false,node:process.version,name:error.name,code:error.code,message:error.message}));
      });console.log(JSON.stringify(result));await released;input.close();clearInterval(keepAlive);
    `
        : `
      const {client}=${runtime === "source" ? 'await import("./src/client/index.js")' : runtime === "ESM" ? 'await import("./dist/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
      const entity=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:3000});
      entity.reconnect.stop();entity.on('error',()=>{});let result;
      try{
        await entity.connect(entity.options.service);
        await entity.write('<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="different-xmpp-domain.test" version="1.0"/>');
        result={phase:'result',accepted:true};
      }catch(error){result={phase:'result',accepted:false,name:error.name,code:error.code,message:error.message};}
      console.log(JSON.stringify(result));await released;await entity.stop();input.close();clearInterval(keepAlive);
    `);
    child = Bun.spawn(
      [
        runtime === "native"
          ? (process.env.XMPP_TEST_NODE ?? "node")
          : process.execPath,
        "--input-type=module",
        "--eval",
        source,
      ],
      {
        stdin: "pipe",
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
    childMessages = messages(child.stdout);
    childErrors = new Response(child.stderr).text();
    const result = (await childMessages.receive()) as Result;
    expect(result.phase).toBe("result");
    expect(result.name).not.toBe("TimeoutError");
    // Observe refusal while the client is waiting, before entity.stop() or
    // process termination. Faulty peers retain their TCP descriptors until stop.
    peer.stdin.write("snapshot\n");
    const snapshot = await peerMessages.receive();
    expect(snapshot.type).toBe("snapshot");
    expect(child.exitCode).toBeNull();
    expect(peer.exitCode).toBeNull();
    expect(snapshot.held).toBe(
      scenario === "invalid" ? snapshot.records.length : 0,
    );
    const records = snapshot.records as Connection[];
    if (scenario === "invalid") {
      if (runtime === "native") {
        expect(() => verifyNativeRefusal(result, records)).not.toThrow();
      } else {
        expect(() => verifyRefusal(result, records)).not.toThrow();
      }
    }
    child.stdin.write("release\n");
    child.stdin.end();
    const [exit, errors] = await Promise.all([child.exited, childErrors]);
    expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
    completed = true;
    return { result, records };
  } finally {
    if (child?.exitCode === null) {
      child.kill();
    }
    if (completed && peer.exitCode === null) {
      peer.stdin.write("stop\n");
      peer.stdin.end();
    } else {
      peer.kill();
    }
    const [exit, errors] = await Promise.all([peer.exited, peerErrors]);
    if (child) {
      await Promise.all([child.exited, childErrors]);
    }
    peerMessages.reader.releaseLock();
    childMessages?.reader.releaseLock();
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
        `RFC 9846 §§4.5.3/6.2: ${runtime} ${mode}, ${scenario} server Finished`,
        async () => {
          const { result, records } = await observe(scenario, runtime, mode);
          if (scenario === "invalid") {
            return;
          }
          expect(result.accepted).toBe(true);
          expect(records.length).toBe(
            runtime === "native" || mode === "direct" ? 1 : 2,
          );
          for (const record of records) {
            expect(() => verifyFinished(record, scenario)).not.toThrow();
            expect(record.session).toEqual({
              version: [3, 4],
              cipher: TLS13_AES128_GCM_SHA256,
              resumed: false,
            });
            expect(record.group).toBe(X25519);
            expect(record.errors).toEqual([]);
            expect(record.alerts).toEqual([]);
          }
          const requests = records.flatMap((record) => record.requests);
          const upgrades = records.flatMap((record) => record.upgrades);
          if (runtime === "native") {
            expect(result.node).toMatch(/^v\d+\./);
            expect(result).toMatchObject({
              authorized: true,
              alpn: "http/1.1",
              protocol: "TLSv1.3",
              body: "authenticated ALPN peer",
            });
            expect(requests).toEqual(["/probe"]);
            expect(upgrades).toEqual([]);
            return;
          }
          expect(requests).toEqual(
            mode === "direct" ? ["/xmpp"] : ["/.well-known/host-meta", "/xmpp"],
          );
          expect(upgrades).toEqual([{ path: "/xmpp", protocol: "xmpp" }]);
        },
        PEER_TIMEOUT_MS,
      );
    }
  }
}
