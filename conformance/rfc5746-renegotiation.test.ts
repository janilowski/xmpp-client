import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";
import { readFrame } from "./xml.ts";

// RFC 5746 §3.5 / RFC 6120 §5.3.5: secure renegotiation is optional, not
// prohibited. A supporting client must abort missing or mismatched binding.
// Unlike #91, the initial handshake here acknowledges secure renegotiation.
// https://www.rfc-editor.org/rfc/rfc5746.html#section-3.5
// https://www.rfc-editor.org/rfc/rfc6120.html#section-5.3.5
const TEST_TIMEOUT_MS = 20000;
const PROCESS_TIMEOUT_MS = 12000;
const XMPP_TIMEOUT_MS = 3000;
const TLS12 = [3, 3];
const ECDHE_RSA_AES128_GCM_SHA256 = 0xc02f;
const EMPTY_RENEGOTIATION_SCSV = 0x00ff;
const X25519 = 29;
const SHA256_RSA = [4, 1];
const FATAL_HANDSHAKE_FAILURE = [2, 40];
const FATAL_ILLEGAL_PARAMETER = [2, 47];
const FATAL_INTERNAL_ERROR = [2, 80];
const VERIFY_DATA_BYTES = 12;
const HANDSHAKE_HEADER_BYTES = 4;
const TLS_VERSION_BYTES = 2;
const TLS_RANDOM_BYTES = 32;
const SERVER_HELLO = 2;
const RENEGOTIATION_INFO = 65281;
const EXTENDED_MAIN_SECRET = 23;
const XML_AFTER_REFUSAL =
  '<error xmlns="http://etherx.jabber.org/streams"><policy-violation xmlns="urn:ietf:params:xml:ns:xmpp-streams"/></error>';
const SCENARIOS = ["absent", "wrong-client", "wrong-server"] as const;
type Scenario = (typeof SCENARIOS)[number] | "correct";
type Records = {
  initial: {
    version: number[];
    cipher: number;
    group: number;
    signature: number[];
    info: string;
    ems: boolean;
    clientFinished: string;
    serverFinished: string;
    serverHello: string;
  };
  application: string[];
  renegotiation: {
    decision: "attempted" | "declined";
    clientInfo?: string | null;
    ciphers?: number[];
    serverInfo?: string | null;
    serverHello?: string;
  };
  alerts: number[][];
  sentAlerts: number[][];
  applicationAfterViolation: string[];
  eof: boolean;
  errors: { name: string; message: string }[];
};
let directory: string;

// Independent bounds/extension reader for the fixture's actual serialized
// ServerHello. A claimed wrong binding must not accidentally be just absent.
function readServerHello(source: string) {
  const bytes = Buffer.from(source, "hex");
  assert.ok(
    bytes.length >=
      HANDSHAKE_HEADER_BYTES + TLS_VERSION_BYTES + TLS_RANDOM_BYTES + 1,
  );
  assert.equal(bytes[0], SERVER_HELLO);
  assert.equal(
    bytes.readUIntBE(1, HANDSHAKE_HEADER_BYTES - 1),
    bytes.length - HANDSHAKE_HEADER_BYTES,
  );
  const version = [
    ...bytes.subarray(
      HANDSHAKE_HEADER_BYTES,
      HANDSHAKE_HEADER_BYTES + TLS_VERSION_BYTES,
    ),
  ];
  let position = HANDSHAKE_HEADER_BYTES + TLS_VERSION_BYTES + TLS_RANDOM_BYTES;
  position += 1 + bytes[position]!;
  assert.ok(position + 5 <= bytes.length);
  const cipher = bytes.readUInt16BE(position);
  position += 2;
  const compression = bytes[position++];
  assert.equal(bytes.readUInt16BE(position), bytes.length - position - 2);
  position += 2;
  const extensions = [];
  while (position < bytes.length) {
    assert.ok(position + 4 <= bytes.length);
    const type = bytes.readUInt16BE(position);
    const length = bytes.readUInt16BE(position + 2);
    position += 4;
    assert.ok(position + length <= bytes.length);
    extensions.push({
      type,
      value: bytes.subarray(position, position + length).toString("hex"),
    });
    position += length;
  }
  return { version, cipher, compression, extensions };
}

// A bounded JSON-line subprocess channel keeps fixture failure separate from
// normative assertions and drains every process before releasing its reader.
function startPeer(args: string[]) {
  const process = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: PROCESS_TIMEOUT_MS,
  });
  const reader = process.stdout.getReader();
  const errors = new Response(process.stderr).text();
  let pending = "";
  return {
    process,
    async receive() {
      while (!pending.includes("\n")) {
        const { done, value } = await reader.read();
        assert.equal(done, false, "TLS peer exited before its response");
        pending += new TextDecoder().decode(value);
      }
      const end = pending.indexOf("\n");
      const message = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      return message;
    },
    async finish() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        pending += new TextDecoder().decode(value);
      }
      assert.equal(pending, "", "Unexpected trailing peer output");
      assert.deepEqual(await Promise.all([process.exited, errors]), [0, ""]);
    },
    async close() {
      process.kill();
      try {
        await Promise.all([process.exited, errors]);
      } finally {
        reader.releaseLock();
      }
    },
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-post-handshake-"));
  const authority = await generate(
    [{ name: "commonName", value: "Renegotiation CA" }],
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
  expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
  for (const certificate of [root, leaf]) {
    expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
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

test(
  "§3.5 native capability control: full secure renegotiation",
  async () => {
    const peer = startPeer([
      process.env.XMPP_TEST_NODE ?? "node",
      "conformance/fixtures/tls12-renegotiation-positive.mjs",
      directory,
    ]);
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      const ready = await peer.receive();
      expect(ready.node).toMatch(/^v\d+\./);
      expect(Number.isInteger(ready.port) && ready.port > 0).toBe(true);
      child = Bun.spawn(
        [
          process.env.XMPP_TEST_NODE ?? "node",
          "--input-type=module",
          "--eval",
          `
        import assert from 'node:assert/strict';
        import {connect} from 'node:tls';
        if(process.versions.bun){throw Error('Native Node required');}
        const socket=connect({host:'localhost',port:${ready.port},servername:'localhost',rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.2',ecdhCurve:'X25519'},()=>{assert.equal(socket.authorized,true);socket.write('PING');});
        const result={received:'',errors:[]};
        socket.on('data',data=>{result.received+=data.toString();if(result.received==='PONGRENEWED'){socket.write('DONE');}});
        socket.on('error',error=>{result.errors.push(error.message);socket.destroy();});
        socket.on('close',()=>console.log(JSON.stringify(result)));
        `,
        ],
        {
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: join(directory, "ca.pem"),
            NODE_TLS_REJECT_UNAUTHORIZED: "1",
          },
          stdin: "ignore",
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
      expect(JSON.parse(stdout)).toEqual({
        received: "PONGRENEWEDEND",
        errors: [],
      });
      peer.process.stdin.write("finish\n");
      peer.process.stdin.end();
      const records = await peer.receive();
      expect(records).toMatchObject({
        requested: true,
        received: "PINGDONE",
        errors: [],
      });
      expect(records.finished).toHaveLength(2);
      for (const value of records.finished) {
        expect(value).toMatch(/^[a-f\d]{24}$/);
      }
      expect(records.finished[0]).not.toBe(records.finished[1]);
      await peer.finish();
    } finally {
      child?.kill();
      if (child) {
        await child.exited;
      }
      await peer.close();
    }
  },
  TEST_TIMEOUT_MS,
);

async function observeUnsafe(
  runtime:
    | "node"
    | "node-decline"
    | "node-continue"
    | "bun-control"
    | "source"
    | "minified",
  scenario: Scenario,
  peerAbort: "withheld" | "queued" = scenario === "correct"
    ? "queued"
    : "withheld",
) {
  const native = runtime.startsWith("node");
  const control = native || runtime === "bun-control";
  const peer = startPeer([
    process.env.XMPP_TEST_PYTHON ?? "python3",
    "conformance/fixtures/tls12-post-handshake.py",
    resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
    directory,
    scenario,
    control ? "control" : "xmpp",
    peerAbort,
  ]);
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    const ready = await peer.receive();
    expect(ready.tlslite).toBe("0.8.2");
    expect(Number.isInteger(ready.port) && ready.port > 0).toBe(true);
    const source = control
      ? `
      import {connect} from 'node:tls';
      import {constants} from 'node:crypto';
      if(${native} && process.versions.bun){throw new Error('Native Node required');}
      const keepAlive=setInterval(()=>{},1000);let socket;
      process.stdin.on('data',data=>{if(data.toString().includes('continue')){socket.write(${JSON.stringify(XML_AFTER_REFUSAL)});}if(data.toString().includes('dispose')){socket.destroy();}if(data.toString().includes('finish')){clearInterval(keepAlive);process.stdin.destroy();}});
      const result={received:'',errors:[]};
      socket=connect({host:'localhost',port:${ready.port},servername:'localhost',minVersion:'TLSv1.2',maxVersion:'TLSv1.2',ecdhCurve:'X25519',secureOptions:${["node-decline", "node-continue"].includes(runtime) ? "constants.SSL_OP_NO_RENEGOTIATION" : "0"},rejectUnauthorized:true},()=>{if(!socket.authorized)throw Error('Unverified control');socket.write('PING');});
      socket.on('data',data=>{result.received+=data.toString();if(result.received==='PONG'){socket.write('GO');}});
      socket.on('error',error=>{result.errors.push(error.code);socket.destroy();});
      socket.on('close',()=>console.log(JSON.stringify(result)));
    `
      : `
      import assert from 'node:assert/strict';
      const keepAlive=setInterval(()=>{},1000);
      const released=new Promise(resolve=>process.stdin.once('data',()=>{clearInterval(keepAlive);process.stdin.destroy();resolve();}));
      const {client,xml}=${runtime === "source" ? 'await import("./src/client/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
      const xmpp=client({service:'wss://localhost:${ready.port}/xmpp',domain:'example.test',username:'user',password:'password',resource:'r',timeout:${XMPP_TIMEOUT_MS}});
      xmpp.reconnect.stop();const errors=[],messages=[];
      xmpp.on('error',error=>{errors.push({name:error.name,message:error.message,code:error.code});});
      xmpp.on('stanza',element=>{if(element.is('message')){messages.push(element.getChildText('body'));}});
      try{
        await xmpp.start();assert.equal(xmpp.jid.toString(),'user@example.test/r');
        const received=new Promise(resolve=>xmpp.on('stanza',element=>{if(element.is('message')){resolve(element.getChildText('body'));}}));
        await xmpp.send(xml('message',{to:'friend@example.test'},xml('body',{},'probe')));
        assert.equal(await received,'reply');
        assert.deepEqual(errors,[]);
        const disconnected=new Promise(resolve=>xmpp.once('disconnect',resolve));
        await xmpp.send(xml('message',{to:'friend@example.test'},xml('body',{},'renegotiate')));
        await disconnected;assert.deepEqual(messages,['reply']);
        assert.equal(errors.some(error=>error.name==='TimeoutError'),false);
        console.log(JSON.stringify({received:messages,errors}));
        await released;
      }finally{await xmpp.stop();}
    `;
    child = Bun.spawn(
      [
        native ? (process.env.XMPP_TEST_NODE ?? "node") : process.execPath,
        "--input-type=module",
        "--eval",
        source,
      ],
      {
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(directory, "ca.pem"),
          NODE_TLS_REJECT_UNAUTHORIZED: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: PROCESS_TIMEOUT_MS,
      },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const first = await peer.receive();
    expect(["alert", "observed"]).toContain(first.phase);
    if (control && first.phase === "alert") {
      if (runtime === "node-continue") {
        child.stdin.write("continue\n");
        await child.stdin.flush();
        expect(await peer.receive()).toEqual({
          phase: "application-after-refusal",
        });
      }
      // OpenSSL supplies an independent TLS rejection, not an XMPP closure
      // oracle. Its driver owns cleanup after the observed fatal alert.
      child.stdin.write("dispose\n");
      await child.stdin.flush();
    }
    const observed = first.phase === "observed" ? first : await peer.receive();
    expect(observed.phase).toBe("observed");
    const records = observed.records as Records;
    expect(records.errors).toEqual([]);
    expect(records.initial).toMatchObject({
      version: TLS12,
      cipher: ECDHE_RSA_AES128_GCM_SHA256,
      group: X25519,
      signature: SHA256_RSA,
      info: "",
      ems: true,
    });
    for (const value of [
      records.initial.clientFinished,
      records.initial.serverFinished,
    ]) {
      expect(value).toMatch(/^[a-f\d]{24}$/);
    }
    const initial = readServerHello(records.initial.serverHello);
    expect(initial).toMatchObject({
      version: TLS12,
      cipher: ECDHE_RSA_AES128_GCM_SHA256,
      compression: 0,
    });
    expect(
      initial.extensions.filter(({ type }) => type === RENEGOTIATION_INFO),
    ).toEqual([{ type: RENEGOTIATION_INFO, value: "00" }]);
    expect(
      initial.extensions.filter(({ type }) => type === EXTENDED_MAIN_SECRET),
    ).toEqual([{ type: EXTENDED_MAIN_SECRET, value: "" }]);
    if (records.renegotiation.decision === "attempted") {
      expect(records.renegotiation.clientInfo).toBe(
        records.initial.clientFinished,
      );
      expect(records.renegotiation.ciphers).not.toContain(
        EMPTY_RENEGOTIATION_SCSV,
      );
      expect(records.renegotiation.ciphers).toContain(
        ECDHE_RSA_AES128_GCM_SHA256,
      );
      const binding = Buffer.from(
        records.initial.clientFinished + records.initial.serverFinished,
        "hex",
      );
      assert.ok(records.renegotiation.serverHello);
      const second = readServerHello(records.renegotiation.serverHello);
      expect(second).toMatchObject({
        version: TLS12,
        cipher: ECDHE_RSA_AES128_GCM_SHA256,
        compression: 0,
      });
      expect(
        second.extensions.filter(({ type }) => type !== RENEGOTIATION_INFO),
      ).toEqual(
        initial.extensions.filter(({ type }) => type !== RENEGOTIATION_INFO),
      );
      expect(second.extensions).toContainEqual({
        type: EXTENDED_MAIN_SECRET,
        value: "",
      });
      const info = second.extensions.filter(
        ({ type }) => type === RENEGOTIATION_INFO,
      );
      if (scenario === "absent") {
        expect(records.renegotiation.serverInfo).toBeNull();
        expect(info).toEqual([]);
      } else {
        if (scenario !== "correct") {
          binding[scenario === "wrong-client" ? 0 : VERIFY_DATA_BYTES]! ^= 1;
        }
        expect(records.renegotiation.serverInfo).toBe(binding.toString("hex"));
        expect(info).toEqual([
          {
            type: RENEGOTIATION_INFO,
            value: Buffer.concat([
              Buffer.from([binding.length]),
              binding,
            ]).toString("hex"),
          },
        ]);
      }
    } else {
      // Unsupported renegotiation may close immediately without an alert.
      // That branch proves refusal/closure, not bad ServerHello validation.
      expect(records.renegotiation).toEqual({ decision: "declined" });
    }
    expect(records.sentAlerts).toEqual(
      records.renegotiation.decision === "attempted" && peerAbort === "queued"
        ? [FATAL_INTERNAL_ERROR]
        : [],
    );
    expect(records.eof).toBe(true);
    // Only withheld mode establishes client-initiated closure; queued mode
    // is a separate RI-parsing control, not independent shutdown evidence.
    if (runtime !== "node-continue") {
      expect(records.applicationAfterViolation).toEqual([]);
    }
    child.stdin.write("finish\n");
    child.stdin.end();
    const [exit, output, errors] = await Promise.all([
      child.exited,
      stdout,
      stderr,
    ]);
    expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
    const client = JSON.parse(output);
    expect(client.received).toEqual(control ? "PONG" : ["reply"]);
    peer.process.stdin.write("finish\n");
    peer.process.stdin.end();
    await peer.finish();
    return { records, client };
  } finally {
    child?.kill();
    if (child) {
      await child.exited;
    }
    await peer.close();
  }
}

test.each(SCENARIOS)(
  "§3.5 native rejection control / %s",
  async (scenario) => {
    const { records } = await observeUnsafe("node", scenario);
    expect(records.renegotiation.decision).toBe("attempted");
    // OpenSSL can use illegal_parameter for a wrong binding; this control
    // establishes independent rejection, not exact XMPP/RFC 5746 compliance.
    expect([FATAL_HANDSHAKE_FAILURE, FATAL_ILLEGAL_PARAMETER]).toContainEqual(
      records.alerts[0],
    );
    expect(records.application).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "§5.3.5 native control: declining optional renegotiation is allowed",
  async () => {
    const { records } = await observeUnsafe("node-decline", "absent");
    expect(records.renegotiation).toEqual({ decision: "declined" });
  },
  TEST_TIMEOUT_MS,
);

test(
  "§5.3.5 oracle rejects XML output after a renegotiation refusal",
  async () => {
    const { records } = await observeUnsafe("node-continue", "absent");
    expect(records.renegotiation).toEqual({ decision: "declined" });
    expect(records.applicationAfterViolation).toEqual([
      Buffer.from(XML_AFTER_REFUSAL).toString("hex"),
    ]);
    expect(() =>
      assert.deepEqual(records.applicationAfterViolation, []),
    ).toThrow(assert.AssertionError);
  },
  TEST_TIMEOUT_MS,
);

test(
  "§3.5 raw Bun control distinguishes the peer internal_error alert",
  async () => {
    const { records, client } = await observeUnsafe("bun-control", "correct");
    if (records.renegotiation.decision === "attempted") {
      expect(records.alerts).toEqual([]);
      expect(client.errors).toEqual(["ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR"]);
    }
  },
  TEST_TIMEOUT_MS,
);

test.each(SCENARIOS)(
  "§3.5 paired raw control: unsafe binding precedes the queued peer abort / %s",
  async (scenario) => {
    const { records } = await observeUnsafe("bun-control", scenario, "queued");
    if (records.renegotiation.decision === "attempted") {
      expect(records.alerts).toEqual([FATAL_HANDSHAKE_FAILURE]);
    }
  },
  TEST_TIMEOUT_MS,
);

for (const artifact of ["source", "minified"] as const) {
  test(
    `§3.5 paired control: correct binding reaches the peer abort / ${artifact}`,
    async () => {
      const { records, client } = await observeUnsafe(artifact, "correct");
      if (records.renegotiation.decision === "attempted") {
        expect(records.alerts).toEqual([]);
        expect(() =>
          assert.deepEqual(records.alerts, [FATAL_HANDSHAKE_FAILURE]),
        ).toThrow(assert.AssertionError);
        // WebSocket surfaces a generic TLS failure, not the native alert code.
        // The separate raw control distinguishes internal_error from RI failure.
        expect(client.errors).toEqual([
          { name: "Error", message: expect.stringMatching(/TLS|SSL/) },
        ]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.each(SCENARIOS)(
    `§3.5 / RFC 6120 §5.3.5: reject unsafe renegotiation without a peer alert or FIN / ${artifact} / %s`,
    async (scenario) => {
      const { records } = await observeUnsafe(artifact, scenario);
      if (records.renegotiation.decision === "attempted") {
        expect(records.alerts).toEqual([FATAL_HANDSHAKE_FAILURE]);
      }
      expect(records.application).toHaveLength(6);
      for (const index of [0, 2]) {
        const events = readFrame(records.application[index]!);
        const root = events[0];
        assert.ok(root && "open" in root);
        expect(root.open).toBe("{urn:ietf:params:xml:ns:xmpp-framing}open");
        expect(root.attributes["{}to"]).toBe("example.test");
        expect(root.attributes["{}version"]).toBe("1.0");
        expect(events.slice(1)).toEqual([{ close: root.open }]);
      }
      expect(readFrame(records.application[1]!)).toEqual(
        readFrame(
          '<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">AHVzZXIAcGFzc3dvcmQ=</auth>',
        ),
      );
      const binding = readFrame(records.application[3]!);
      const iq = binding[0];
      assert.ok(iq && "open" in iq && iq.attributes["{}id"]);
      iq.attributes["{}id"] = "binding";
      expect(binding).toEqual(
        readFrame(
          '<iq xmlns="jabber:client" type="set" id="binding"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>r</resource></bind></iq>',
        ),
      );
      for (const [index, body] of [
        [4, "probe"],
        [5, "renegotiate"],
      ] as const) {
        expect(readFrame(records.application[index]!)).toEqual(
          readFrame(
            `<message xmlns="jabber:client" to="friend@example.test"><body>${body}</body></message>`,
          ),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
}
