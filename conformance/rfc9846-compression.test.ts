import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReadableStream } from "node:stream/web";
import { generate } from "selfsigned";
import { parseHello } from "./fixtures/client-hello.mjs";

// RFC 5246 §7.4.1.3 selects compression from the actual ClientHello list.
// RFC 9325 §3.3 separately recommends disabling TLS 1.2 compression; it is not
// a universal MUST NOT. RFC 9846 §§4.2.3/6.2 require abort for nonzero TLS 1.3
// compression, and illegal_parameter (or general_error) if an alert is sent.
// This is record compression, not certificate or WebSocket compression.
// https://www.rfc-editor.org/rfc/rfc5246.html#section-7.4.1.3
// https://www.rfc-editor.org/rfc/rfc9325.html#section-3.3
// https://www.rfc-editor.org/rfc/rfc9846.html#section-4.2.3
const CLIENT_HELLO = 1;
const SERVER_HELLO = 2;
const CHANGE_CIPHER_SPEC = 20;
const ALERT = 21;
const HANDSHAKE = 22;
const PROTECTED_RECORD = 23;
// This peer uses AES-GCM: alert(2), inner content type(1), authentication tag(16).
const MIN_PROTECTED_ALERT_BYTES = 19;
const FATAL = 2;
const ILLEGAL_PARAMETER = 47;
const GENERAL_ERROR = 117;
const DECODE_ERROR = 50;
const NULL_COMPRESSION = 0;
const DEFLATE_COMPRESSION = 1;
const TLS12_CIPHER = 0xc02f;
const TLS13_CIPHER = 0x1301;
const X25519 = 29;
const RSA_KEY_BITS = 2048;
const CHILD_TIMEOUT_MS = 12000;
const PEER_TIMEOUT_MS = 15000;
const RESPONSE_TIMEOUT_MS = 7000;
const SETUP_TIMEOUT_MS = 30000;
const VERSIONS = [3, 4] as const;
const PROTOCOLS = { 3: "TLSv1.2", 4: "TLSv1.3" } as const;
const SCENARIOS = ["valid", "invalid"] as const;
type Version = (typeof VERSIONS)[number];
type Scenario = (typeof SCENARIOS)[number];
type Runtime = "native" | "source" | "ESM" | "minified";
type Mode = "direct" | "discovery";
type Connection = {
  hellos: string[];
  server_hellos: { original: string; sent: string }[];
  client_messages: number[];
  wire: { kind: number; payload: string }[];
  wire_pending: number;
  protected_alerts: number[][];
  closed: null | "eof" | "reset";
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
  protocol?: string;
  body?: string;
  node?: string;
};
let directory: string;

function verifyCompressionAlert(alert: number[]) {
  assert.equal(alert.length, 2, "Invalid TLS alert length");
  assert.equal(alert[0], FATAL, "Compression refusal must be fatal");
  assert.ok(
    [ILLEGAL_PARAMETER, GENERAL_ERROR].includes(alert[1]),
    `Wrong TLS 1.3 compression refusal alert: ${alert[1]}`,
  );
}

// Read the byte after the bounded session-id vector and selected cipher.
// The fixture's own field value is not an oracle for the serialized message.
function compression(source: string) {
  assert.match(source, /^(?:[0-9a-f]{2})+$/, "Invalid ServerHello hex");
  const data = Buffer.from(source, "hex");
  assert.ok(data.length >= 42, "Truncated ServerHello");
  assert.equal(data[0], SERVER_HELLO, "Not a ServerHello");
  assert.equal(
    data.readUIntBE(1, 3),
    data.length - 4,
    "Invalid handshake length",
  );
  const sessionSize = data[38];
  assert.ok(sessionSize <= 32, "Oversized session id");
  const offset = 41 + sessionSize;
  assert.ok(offset < data.length, "Truncated compression field");
  return { data, offset, value: data[offset] };
}

function verifySelection(record: Connection, scenario: Scenario) {
  assert.ok(record.hellos.length > 0, "No ClientHello observed");
  for (const source of record.hellos) {
    assert.match(source, /^(?:[0-9a-f]{2})+$/, "Invalid ClientHello hex");
    const bytes = Buffer.from(source, "hex");
    assert.ok(bytes.length >= 4, "Truncated ClientHello header");
    assert.equal(bytes[0], CLIENT_HELLO);
    assert.equal(bytes.readUIntBE(1, 3), bytes.length - 4);
    assert.equal(
      parseHello(bytes.subarray(4)).compression,
      "00",
      "Client offered compression",
    );
  }
  assert.equal(
    record.server_hellos.length,
    1,
    "Missing or repeated ServerHello",
  );
  const { original, sent } = record.server_hellos[0];
  const before = compression(original);
  const after = compression(sent);
  assert.equal(
    before.value,
    NULL_COMPRESSION,
    "Baseline was not null compression",
  );
  assert.equal(after.offset, before.offset);
  assert.equal(after.data.length, before.data.length);
  assert.deepEqual(
    after.data.subarray(0, after.offset),
    before.data.subarray(0, before.offset),
    "Unrelated ServerHello bytes changed",
  );
  assert.deepEqual(
    after.data.subarray(after.offset + 1),
    before.data.subarray(before.offset + 1),
    "Unrelated ServerHello bytes changed",
  );
  assert.equal(
    after.value,
    scenario === "valid" ? NULL_COMPRESSION : DEFLATE_COMPRESSION,
    "Wrong compression selection",
  );
}

function verifyRefusal(
  result: Result,
  records: Connection[],
  version: Version,
) {
  assert.equal(result.accepted, false, "Client accepted unoffered compression");
  assert.notEqual(
    result.name,
    "TimeoutError",
    "Timeout is not compression refusal",
  );
  assert.ok(records.length > 0, "No client connection observed");
  for (const record of records) {
    verifySelection(record, "invalid");
    assert.equal(record.wire_pending, 0, "Partial client record after refusal");
    const handshake: Buffer[] = [];
    const plaintextAlerts: number[][] = [];
    let protectedRecords = 0;
    for (const item of record.wire) {
      assert.match(
        item.payload,
        /^(?:[0-9a-f]{2})+$/,
        "Invalid client record hex",
      );
      const payload = Buffer.from(item.payload, "hex");
      if (item.kind === HANDSHAKE) {
        handshake.push(payload);
      } else if (item.kind === CHANGE_CIPHER_SPEC && version === 4) {
        assert.equal(item.payload, "01", "Invalid compatibility CCS");
      } else if (item.kind === ALERT) {
        assert.equal(payload.length, 2, "Invalid plaintext alert length");
        plaintextAlerts.push([...payload]);
      } else if (item.kind === PROTECTED_RECORD && version === 4) {
        assert.ok(
          payload.length >= MIN_PROTECTED_ALERT_BYTES,
          "Truncated protected alert record",
        );
        protectedRecords += 1;
      } else {
        assert.fail("Unexpected client record after unoffered compression");
      }
    }
    assert.equal(
      Buffer.concat(handshake).toString("hex"),
      record.hellos.join(""),
      "Extra client handshake bytes after refusal",
    );
    assert.equal(
      protectedRecords,
      record.protected_alerts.length,
      "Unverified protected client records after refusal",
    );
    assert.deepEqual(
      record.alerts,
      [...plaintextAlerts, ...record.protected_alerts],
      "TLS alert recorder disagrees with received records",
    );
    assert.deepEqual(
      record.client_messages,
      [CLIENT_HELLO],
      "Client continued the handshake after unoffered compression",
    );
    assert.ok(
      ["eof", "reset"].includes(record.closed ?? ""),
      "Client transport remained open before cleanup",
    );
    assert.equal(record.session, null, "TLS accepted unoffered compression");
    assert.deepEqual(
      record.requests,
      [],
      "HTTP sent after unoffered compression",
    );
    assert.deepEqual(
      record.upgrades,
      [],
      "WebSocket upgraded after unoffered compression",
    );
    assert.ok(record.alerts.length <= 1, "Repeated TLS refusal alert");
    for (const alert of record.alerts) {
      assert.equal(alert.length, 2, "Invalid TLS alert length");
      assert.equal(alert[0], FATAL, "Compression refusal must be fatal");
    }
  }
}

test("RFC 9846 §4.2.3: literal ServerHello reader locates only compression", () => {
  for (const sessionSize of [0, 1, 32]) {
    const body =
      "0303" +
      "a5".repeat(32) +
      sessionSize.toString(16).padStart(2, "0") +
      "5a".repeat(sessionSize) +
      "1301000000";
    const original =
      "02" + (body.length / 2).toString(16).padStart(6, "0") + body;
    const parsed = compression(original);
    expect(parsed.offset).toBe(41 + sessionSize);
    expect(parsed.value).toBe(NULL_COMPRESSION);
    for (const value of [DEFLATE_COMPRESSION, 255]) {
      const sent = Buffer.from(parsed.data);
      sent[parsed.offset] = value;
      expect(compression(sent.toString("hex")).value).toBe(value);
    }
    for (const broken of [
      "",
      original.slice(0, -2),
      "03" + original.slice(2),
      "02000000" + original.slice(8),
      original.slice(0, 76) + "21" + original.slice(78),
    ]) {
      expect(() => compression(broken)).toThrow();
    }
  }
});

test("RFC 9846 §6.2: compression alerts permit general_error, not an unrelated code", () => {
  for (const code of [ILLEGAL_PARAMETER, GENERAL_ERROR]) {
    expect(() => verifyCompressionAlert([FATAL, code])).not.toThrow();
  }
  for (const alert of [
    [],
    [FATAL],
    [FATAL, ILLEGAL_PARAMETER, 0],
    [1, ILLEGAL_PARAMETER],
    [FATAL, 0],
    [FATAL, 40],
    [FATAL, DECODE_ERROR],
    [FATAL, 51],
    [FATAL, 255],
  ]) {
    expect(() => verifyCompressionAlert(alert)).toThrow();
  }
});

test("Compression refusal oracle rejects acceptance, late handshakes and cleanup evidence", () => {
  const original = "02000028" + "0303" + "00".repeat(32) + "00c02f000000";
  const sent = "02000028" + "0303" + "00".repeat(32) + "00c02f010000";
  const hello = "0303" + "00".repeat(32) + "000002c02f01000000";
  const record: Connection = {
    hellos: ["01" + (hello.length / 2).toString(16).padStart(6, "0") + hello],
    server_hellos: [{ original, sent }],
    client_messages: [CLIENT_HELLO],
    wire: [
      {
        kind: HANDSHAKE,
        payload:
          "01" + (hello.length / 2).toString(16).padStart(6, "0") + hello,
      },
      { kind: ALERT, payload: "022f" },
    ],
    wire_pending: 0,
    protected_alerts: [],
    closed: "eof",
    session: null,
    group: null,
    requests: [],
    upgrades: [],
    alerts: [[FATAL, ILLEGAL_PARAMETER]],
    errors: [],
  };
  const refused: Result = { phase: "result", accepted: false };
  expect(() => verifyRefusal(refused, [record], 4)).not.toThrow();
  expect(() =>
    verifyRefusal(
      refused,
      [
        {
          ...record,
          alerts: [[FATAL, GENERAL_ERROR]],
          wire: [record.wire[0], { kind: ALERT, payload: "0275" }],
        },
      ],
      4,
    ),
  ).not.toThrow();
  // Alert transmission is SHOULD; mandatory abort and the alert's code are
  // separate. TLS 1.2 does not specify one code for this inconsistent choice.
  expect(() =>
    verifyRefusal(
      refused,
      [{ ...record, alerts: [], wire: [record.wire[0]] }],
      4,
    ),
  ).not.toThrow();
  expect(() =>
    verifyRefusal(
      refused,
      [
        {
          ...record,
          alerts: [[FATAL, 40]],
          wire: [record.wire[0], { kind: ALERT, payload: "0228" }],
        },
      ],
      3,
    ),
  ).not.toThrow();
  expect(() =>
    verifyRefusal(
      refused,
      [
        {
          ...record,
          wire: [
            record.wire[0],
            { kind: CHANGE_CIPHER_SPEC, payload: "01" },
            {
              kind: PROTECTED_RECORD,
              payload: "a5".repeat(MIN_PROTECTED_ALERT_BYTES),
            },
          ],
          protected_alerts: [[FATAL, ILLEGAL_PARAMETER]],
        },
      ],
      4,
    ),
  ).not.toThrow();
  expect(() =>
    verifyRefusal({ ...refused, accepted: true }, [record], 4),
  ).toThrow();
  expect(() =>
    verifyRefusal({ ...refused, name: "TimeoutError" }, [record], 4),
  ).toThrow();
  expect(() => verifyRefusal(refused, [], 4)).toThrow();
  for (const broken of [
    { ...record, closed: null },
    { ...record, wire_pending: 1 },
    { ...record, wire: [] },
    {
      ...record,
      wire: [...record.wire, { kind: HANDSHAKE, payload: "10000000" }],
    },
    {
      ...record,
      wire: [...record.wire, { kind: HANDSHAKE, payload: "14000000" }],
    },
    {
      ...record,
      wire: [...record.wire, { kind: PROTECTED_RECORD, payload: "a5" }],
    },
    {
      ...record,
      wire: [...record.wire, { kind: CHANGE_CIPHER_SPEC, payload: "02" }],
    },
    { ...record, hellos: [] },
    { ...record, server_hellos: [] },
    { ...record, server_hellos: [{ original, sent: original }] },
    { ...record, client_messages: [CLIENT_HELLO, 16] },
    { ...record, client_messages: [CLIENT_HELLO, 20] },
    {
      ...record,
      session: { version: [3, 4], cipher: TLS13_CIPHER, resumed: false },
    },
    { ...record, requests: ["/.well-known/host-meta"] },
    { ...record, upgrades: [{ path: "/xmpp", protocol: "xmpp" }] },
    { ...record, alerts: [[1, ILLEGAL_PARAMETER]] },
    { ...record, alerts: [[FATAL, ILLEGAL_PARAMETER, 0]] },
    { ...record, alerts: [[FATAL, 50]] },
    {
      ...record,
      alerts: [
        [FATAL, ILLEGAL_PARAMETER],
        [FATAL, ILLEGAL_PARAMETER],
      ],
    },
  ]) {
    expect(() => verifyRefusal(refused, [broken], 4)).toThrow();
  }
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-compression-"));
  const authority = await generate(
    [{ name: "commonName", value: "Compression fixture CA" }],
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
                "Compression child exited before its response",
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
              () => reject(new Error("Compression child response timed out")),
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

async function observe(
  version: Version,
  scenario: Scenario,
  runtime: Runtime,
  mode: Mode,
) {
  const peer = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "conformance/fixtures/tls-alpn.py",
      resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
      directory,
      String(version),
      "offered",
      scenario === "valid" ? "none" : "compression",
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
        const request=https.get({hostname:'127.0.0.1',port:${ready.port},path:'/probe',
          servername:'localhost',ca:readFileSync(${JSON.stringify(join(directory, "ca.pem"))}),rejectUnauthorized:true,
          ALPNProtocols:['http/1.1'],ecdhCurve:'X25519',minVersion:${JSON.stringify(PROTOCOLS[version])},maxVersion:${JSON.stringify(PROTOCOLS[version])}
        },response=>{
          const socket=response.socket;let body='';response.on('data',data=>body+=data);
          response.on('end',()=>resolve({phase:'result',accepted:true,node:process.version,authorized:socket.authorized,protocol:socket.getProtocol(),body}));
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
    // Both processes remain alive, and faulty peers retain the TCP descriptor.
    // Neither entity.stop(), child termination nor server FIN proves rejection.
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
      expect(() => verifyRefusal(result, records, version)).not.toThrow();
      if (runtime === "native") {
        // Independent implementation diagnosis, not a Node alert conformance claim.
        expect(result.node).toMatch(/^v\d+\./);
        expect(result.code).toBe("EPROTO");
        expect(result.message).toMatch(/compression/);
        if (version === 4) {
          for (const alert of records.flatMap((record) => record.alerts)) {
            expect(() => verifyCompressionAlert(alert)).not.toThrow();
          }
        }
      } else {
        // The reachable peer also checks the SHOULD recommendation to send an
        // alert. Its absence is not mislabeled as failure of the abort MUST.
        for (const record of records) {
          expect(record.alerts.length).toBe(1);
        }
      }
    } else {
      expect(result.accepted).toBe(true);
      expect(records.length).toBe(
        runtime === "native" || mode === "direct" ? 1 : 2,
      );
      for (const record of records) {
        expect(() => verifySelection(record, scenario)).not.toThrow();
        expect(record.session).toEqual({
          version: [3, version],
          cipher: version === 3 ? TLS12_CIPHER : TLS13_CIPHER,
          resumed: false,
        });
        expect(record.group).toBe(X25519);
        expect(record.errors).toEqual([]);
        expect(record.alerts).toEqual([]);
      }
      const requests = records.flatMap((record) => record.requests);
      const upgrades = records.flatMap((record) => record.upgrades);
      if (runtime === "native") {
        expect(result).toMatchObject({
          authorized: true,
          protocol: PROTOCOLS[version],
          body: "authenticated ALPN peer",
        });
        expect(result.node).toMatch(/^v\d+\./);
        expect(requests).toEqual(["/probe"]);
        expect(upgrades).toEqual([]);
      } else {
        expect(requests).toEqual(
          mode === "direct" ? ["/xmpp"] : ["/.well-known/host-meta", "/xmpp"],
        );
        expect(upgrades).toEqual([{ path: "/xmpp", protocol: "xmpp" }]);
      }
    }
    child.stdin.write("release\n");
    child.stdin.end();
    const [exit, errors] = await Promise.all([child.exited, childErrors]);
    expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
    completed = true;
    return records;
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

for (const version of VERSIONS) {
  for (const scenario of SCENARIOS) {
    for (const runtime of ["native", "source", "ESM", "minified"] as const) {
      for (const mode of runtime === "native"
        ? (["direct"] as const)
        : (["direct", "discovery"] as const)) {
        let alerts: number[][] = [];
        test(
          `RFC ${version === 3 ? "5246 §7.4.1.3" : "9846 §§4.2.3/6.2"}: ${runtime} ${mode}, TLS 1.${version - 1} ${scenario} compression`,
          async () => {
            const records = await observe(version, scenario, runtime, mode);
            alerts = records.flatMap((record) => record.alerts);
            if (
              version === 4 &&
              scenario === "invalid" &&
              runtime !== "native" &&
              Bun.version === "1.4.4"
            ) {
              // #112: bound the known failure to its exact observed alert.
              // All wire, abort and pre-cleanup closure checks already passed.
              expect(alerts).toEqual([[FATAL, DECODE_ERROR]]);
            }
          },
          PEER_TIMEOUT_MS,
        );
        if (version === 4 && scenario === "invalid" && runtime !== "native") {
          const verify = Bun.version === "1.4.4" ? test.failing : test;
          verify(
            `RFC 9846 §§4.2.3/6.2: ${runtime} ${mode} compression alert is illegal_parameter or general_error (#112)`,
            () => {
              for (const alert of alerts) {
                expect(() => verifyCompressionAlert(alert)).not.toThrow();
              }
            },
          );
        }
      }
    }
  }
}
