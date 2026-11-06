import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReadableStream } from "node:stream/web";
import { generate } from "selfsigned";

// RFC 9846 §4.7.3: authenticated post-handshake KeyUpdate at the XMPP use
// site, not optional resumption/PHA or a JavaScript cryptographic implementation.
// The pinned independent peer owns encryption, key updates and record parsing.
// https://www.rfc-editor.org/rfc/rfc9846.html#section-4.7.3
const CHILD_TIMEOUT_MS = 12000;
const PEER_TIMEOUT_MS = 15000;
const MESSAGE_TIMEOUT_MS = 6000;
const CONNECTION_TIMEOUT_MS = 2000;
const SETUP_TIMEOUT_MS = 30000;
const TEST_TIMEOUT_MS = 20000;
const HANDSHAKE = 22;
const APPLICATION_DATA = 23;
const ALERT = 21;
const FATAL_ILLEGAL_PARAMETER = "022f";
const FATAL_DECODE_ERROR = "0232";
const NOT_REQUESTED = "1800000100";
const REQUESTED = "1800000101";
const INVALID = "1800000102";
const TLS13_AES128_GCM_SHA256 = 0x1301;
const X25519 = 29;
const SCENARIOS = ["not-requested", "requested", "invalid"] as const;
type Scenario = (typeof SCENARIOS)[number];
type Event = { type: number; bytes: string };
type Records = {
  version: number[];
  cipher: number;
  resumed: boolean;
  group: number;
  before: string[];
  sent: string[];
  received: Event[];
  after: string[];
  eof: boolean;
  errors: { name: string; message: string }[];
};
let directory: string;

function verifyExchange(
  records: Records,
  scenario: Scenario,
  protocol: "native" | "xmpp",
) {
  assert.deepEqual(records.version, [3, 4]);
  assert.equal(records.cipher, TLS13_AES128_GCM_SHA256);
  assert.equal(records.resumed, false);
  assert.equal(records.group, X25519);
  assert.deepEqual(
    records.before,
    protocol === "native" ? ["READY", "GO"] : ["before", "ready"],
  );
  assert.deepEqual(records.errors, [], JSON.stringify(records));
  assert.equal(
    records.sent[0],
    scenario === "invalid"
      ? INVALID
      : scenario === "requested"
        ? REQUESTED
        : NOT_REQUESTED,
  );
  // The peer may answer an independently initiated client update as well.
  assert.ok(records.sent.slice(1).every((bytes) => bytes === NOT_REQUESTED));
  if (scenario === "invalid") {
    assert.deepEqual(
      records.received.filter(({ type }) => type === APPLICATION_DATA),
      [],
    );
    assert.deepEqual(records.after, []);
    assert.equal(records.eof, true);
    const alerts = records.received.filter(({ type }) => type === ALERT);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.bytes, /^02[0-9a-f]{2}$/);
    return;
  }
  assert.deepEqual(
    records.after,
    protocol === "native" ? ["AFTER"] : ["after"],
  );
  assert.equal(records.eof, false);
  assert.deepEqual(
    records.received.filter(({ type }) => type === ALERT),
    [],
  );
  const application = records.received.findIndex(
    ({ type }) => type === APPLICATION_DATA,
  );
  assert.ok(application >= 0, "Missing authenticated application response");
  if (scenario === "requested") {
    assert.ok(
      records.received
        .slice(0, application)
        .some(
          ({ type, bytes }) => type === HANDSHAKE && bytes === NOT_REQUESTED,
        ),
      "Missing reciprocal KeyUpdate before application data",
    );
  }
}

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
                "KeyUpdate child exited before its response",
              );
              pending += new TextDecoder().decode(value);
            }
            const end = pending.indexOf("\n");
            const result = JSON.parse(pending.slice(0, end));
            pending = pending.slice(end + 1);
            return result;
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("KeyUpdate child response timed out")),
              MESSAGE_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function exchange(
  artifact: "native" | "source" | "ESM" | "minified",
  scenario: Scenario,
) {
  const native = artifact === "native";
  const peer = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "conformance/fixtures/tls13-keyupdate.py",
      resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
      directory,
      scenario,
      native ? "control" : "xmpp",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: PEER_TIMEOUT_MS },
  );
  const peerMessages = messages(peer.stdout);
  const peerErrors = new Response(peer.stderr).text();
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let childMessages: ReturnType<typeof messages> | undefined;
  let childErrors: Promise<string> | undefined;
  let completed = false;
  let result:
    | {
        records: Records;
        client: {
          phase: string;
          authorized?: boolean;
          protocol?: string;
          jid?: string;
          messages: string[];
          errors: string[];
        };
      }
    | undefined;
  const failures: unknown[] = [];
  try {
    const ready = await peerMessages.receive();
    expect(ready.phase).toBe("ready");
    expect(ready.tlslite).toBe("0.8.2");
    expect(Number.isInteger(ready.port) && ready.port > 0).toBe(true);
    const code = native
      ? `
      import assert from 'node:assert/strict';import {connect} from 'node:tls';
      assert.equal(process.versions.bun,undefined,'Native Node required');
      setInterval(()=>{},1000);const result={phase:'result',authorized:false,protocol:null,messages:[],errors:[]};
      let pending='',stage=0;
      const socket=connect({host:'localhost',port:${ready.port},servername:'localhost',rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',ecdhCurve:'X25519'},()=>{
        result.authorized=socket.authorized;result.protocol=socket.getProtocol();socket.write('READY');
      });
      socket.on('data',data=>{
        pending+=data.toString();
        for(const token of ['BEFORE','CHALLENGE','AFTER-OK'].slice(stage)){
          if(pending.length<token.length){break;}
          assert.equal(pending.slice(0,token.length),token);pending=pending.slice(token.length);stage++;result.messages.push(token);
          if(token==='BEFORE'){socket.write('GO');}
          if(token==='CHALLENGE'){socket.write('AFTER');}
          if(token==='AFTER-OK'){console.log(JSON.stringify(result));}
        }
      });
      // This raw control owns its TLSSocket cleanup; target WebSockets below do not.
      socket.on('error',error=>{result.errors.push(error.code??error.message);socket.destroy();if(${JSON.stringify(scenario)}==='invalid'){console.log(JSON.stringify(result));}});
    `
      : `
      const {client,xml}=${artifact === "source" ? 'await import("./src/client/index.js")' : artifact === "ESM" ? 'await import("./dist/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
      setInterval(()=>{},1000);
      const entity=client({service:'wss://localhost:${ready.port}/xmpp',domain:'example.test',username:'user',password:'password',resource:'r',timeout:${CONNECTION_TIMEOUT_MS}});
      entity.reconnect.stop();const result={phase:'result',jid:null,messages:[],errors:[]};
      entity.on('error',error=>result.errors.push(error.message));
      const waiting=new Map(['before-ok','challenge','after-ok'].map(body=>{let resolve;const promise=new Promise(done=>resolve=done);return[body,{promise,resolve}];}));
      entity.on('stanza',element=>{if(element.is('message')){const body=element.getChildText('body');result.messages.push(body);waiting.get(body)?.resolve();}});
      try {
        await entity.start();result.jid=entity.jid.toString();
        const disconnected=new Promise(resolve=>entity.once('disconnect',resolve));
        await entity.send(xml('message',{to:'friend@example.test'},xml('body',{},'before')));await waiting.get('before-ok').promise;
        await entity.send(xml('message',{to:'friend@example.test'},xml('body',{},'ready')));
        if(${JSON.stringify(scenario)}==='invalid'){await disconnected;}
        else {await waiting.get('challenge').promise;await entity.send(xml('message',{to:'friend@example.test'},xml('body',{},'after')));await waiting.get('after-ok').promise;}
        console.log(JSON.stringify(result));
      } catch(error){console.log(JSON.stringify({phase:'failed',name:error.name,message:error.message}));}
    `;
    child = Bun.spawn(
      [
        native ? (process.env.XMPP_TEST_NODE ?? "node") : process.execPath,
        "--input-type=module",
        "--eval",
        code,
      ],
      {
        env: {
          ...process.env,
          NODE_TLS_REJECT_UNAUTHORIZED: "1",
          NODE_EXTRA_CA_CERTS: join(directory, "ca.pem"),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: CHILD_TIMEOUT_MS,
      },
    );
    childMessages = messages(child.stdout);
    childErrors = new Response(child.stderr).text();
    const observed = await peerMessages.receive();
    expect(observed.phase).toBe("observed");
    const client = await childMessages.receive();
    expect(client.phase).toBe("result");
    // Fatal EOF is observed while both children are still alive and the peer
    // has withheld TCP FIN. Harness cleanup cannot satisfy the closure oracle.
    expect(peer.exitCode).toBeNull();
    expect(child.exitCode).toBeNull();
    result = { records: observed.records, client };
    completed = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    try {
      if (completed && peer.exitCode === null) {
        peer.stdin.write("finish\n");
        peer.stdin.end();
      } else if (peer.exitCode === null) {
        peer.kill();
      }
    } catch (error) {
      failures.push(error);
      peer.kill();
    } finally {
      if (child?.exitCode === null) {
        child.kill();
      }
      try {
        const [peerExit, errors, _childExit, clientErrors] =
          await Promise.allSettled([
            peer.exited,
            peerErrors,
            child?.exited,
            childErrors,
          ]);
        for (const outcome of [peerExit, errors, _childExit, clientErrors]) {
          if (outcome.status === "rejected") {
            failures.push(outcome.reason);
          }
        }
        if (
          completed &&
          peerExit.status === "fulfilled" &&
          errors.status === "fulfilled" &&
          clientErrors.status === "fulfilled"
        ) {
          expect({
            exit: peerExit.value,
            errors: errors.value,
            clientErrors: clientErrors.value,
          }).toEqual({ exit: 0, errors: "", clientErrors: "" });
        }
      } finally {
        try {
          peerMessages.reader.releaseLock();
        } finally {
          childMessages?.reader.releaseLock();
        }
      }
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    throw failures[0];
  }
  return result!;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-keyupdate-"));
  const authority = await generate(
    [{ name: "commonName", value: "KeyUpdate fixture CA" }],
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
  const pair = await generate([{ name: "commonName", value: "localhost" }], {
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
  const leaf = new X509Certificate(pair.cert);
  expect(root.ca).toBe(true);
  expect(root.verify(root.publicKey)).toBe(true);
  expect(leaf.ca).toBe(false);
  expect(leaf.subject).toBe("CN=localhost");
  expect(leaf.verify(root.publicKey)).toBe(true);
  expect(leaf.checkPrivateKey(createPrivateKey(pair.private))).toBe(true);
  expect(leaf.checkHost("localhost", { subject: "never" })).toBe("localhost");
  for (const certificate of [root, leaf]) {
    expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
  }
  await Promise.all([
    writeFile(join(directory, "ca.pem"), authority.cert),
    writeFile(join(directory, "leaf.pem"), pair.cert),
    writeFile(join(directory, "key.pem"), pair.private),
  ]);
  // Capable setup is established independently before library conformance.
  for (const scenario of SCENARIOS) {
    const { records, client } = await exchange("native", scenario);
    verifyExchange(records, scenario, "native");
    if (scenario === "invalid") {
      expect(records.received.filter(({ type }) => type === ALERT)).toEqual([
        { type: ALERT, bytes: FATAL_ILLEGAL_PARAMETER },
      ]);
    }
    expect(client.authorized).toBe(true);
    expect(client.protocol).toBe("TLSv1.3");
    expect(client.messages).toEqual(
      scenario === "invalid" ? ["BEFORE"] : ["BEFORE", "CHALLENGE", "AFTER-OK"],
    );
    if (scenario === "invalid") {
      expect(client.errors.length).toBeGreaterThanOrEqual(1);
    } else {
      expect(client.errors).toEqual([]);
    }
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("KeyUpdate recorder excludes pre-trigger replies and delegates sending", async () => {
  // Isolate observation bookkeeping; the actual TLS peers still verify keys.
  const child = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "-c",
      `
import ast
import json
from pathlib import Path

calls = []
class KeyUpdate:
    def write(self):
        return bytes.fromhex("1800000100")

class TLSConnection:
    def _sendMsg(self, message, *args, **kwargs):
        calls.append({"update": isinstance(message, KeyUpdate),
                      "args": list(args), "kwargs": kwargs})
        yield "delegated"

path = "conformance/fixtures/tls13-keyupdate.py"
tree = ast.parse(Path(path).read_text())
recorder = next(node for node in tree.body
                if isinstance(node, ast.ClassDef) and node.name == "ObservedTLS")
scope = {"TLSConnection": TLSConnection, "KeyUpdate": KeyUpdate,
         "observing": False, "records": {"sent": []}}
exec(compile(ast.Module(body=[recorder], type_ignores=[]), path, "exec"), scope)
connection = scope["ObservedTLS"]()
before_output = list(connection._sendMsg(KeyUpdate(), "before", phase="setup"))
before = list(scope["records"]["sent"])
scope["observing"] = True
after_output = list(connection._sendMsg(KeyUpdate(), "after", phase="observed"))
other_output = list(connection._sendMsg(object(), "other", phase="observed"))
print(json.dumps({"before": before, "after": scope["records"]["sent"],
                  "calls": calls, "output": [before_output, after_output, other_output]}))
`,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS },
  );
  const [exit, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
  expect(JSON.parse(output)).toEqual({
    before: [],
    after: [NOT_REQUESTED],
    calls: [
      { update: true, args: ["before"], kwargs: { phase: "setup" } },
      { update: true, args: ["after"], kwargs: { phase: "observed" } },
      { update: false, args: ["other"], kwargs: { phase: "observed" } },
    ],
    output: [["delegated"], ["delegated"], ["delegated"]],
  });
});

test("RFC 9846 §4.7.3 oracle rejects missing/late updates and incomplete fatal closure", () => {
  const base: Records = {
    version: [3, 4],
    cipher: TLS13_AES128_GCM_SHA256,
    resumed: false,
    group: X25519,
    before: ["before", "ready"],
    sent: [REQUESTED],
    received: [
      { type: HANDSHAKE, bytes: NOT_REQUESTED },
      { type: APPLICATION_DATA, bytes: "6166746572" },
    ],
    after: ["after"],
    eof: false,
    errors: [],
  };
  expect(() => verifyExchange(base, "requested", "xmpp")).not.toThrow();
  expect(() =>
    verifyExchange(
      { ...base, received: base.received.slice(1) },
      "requested",
      "xmpp",
    ),
  ).toThrow("Missing reciprocal KeyUpdate");
  expect(() =>
    verifyExchange(
      {
        ...base,
        sent: [REQUESTED, NOT_REQUESTED],
        received: [{ type: HANDSHAKE, bytes: REQUESTED }, ...base.received],
      },
      "requested",
      "xmpp",
    ),
  ).not.toThrow();
  expect(() =>
    verifyExchange(
      { ...base, received: [...base.received].reverse() },
      "requested",
      "xmpp",
    ),
  ).toThrow("Missing reciprocal KeyUpdate");
  expect(() =>
    verifyExchange(
      {
        ...base,
        received: [{ type: HANDSHAKE, bytes: REQUESTED }, base.received[1]!],
      },
      "requested",
      "xmpp",
    ),
  ).toThrow("Missing reciprocal KeyUpdate");
  const invalid = {
    ...base,
    sent: [INVALID],
    received: [{ type: ALERT, bytes: FATAL_ILLEGAL_PARAMETER }],
    after: [],
    eof: true,
  };
  expect(() => verifyExchange(invalid, "invalid", "xmpp")).not.toThrow();
  expect(() =>
    verifyExchange(
      { ...invalid, received: [{ type: ALERT, bytes: "0128" }] },
      "invalid",
      "xmpp",
    ),
  ).toThrow();
  expect(() =>
    verifyExchange(
      {
        ...invalid,
        received: [
          ...invalid.received,
          { type: APPLICATION_DATA, bytes: "6c617465" },
        ],
      },
      "invalid",
      "xmpp",
    ),
  ).toThrow();
  expect(() =>
    verifyExchange({ ...invalid, eof: false }, "invalid", "xmpp"),
  ).toThrow();
});

for (const artifact of ["source", "ESM", "minified"] as const) {
  for (const scenario of SCENARIOS) {
    describe(`RFC 9846 §4.7.3: authenticated XMPP ${scenario} / ${artifact}`, () => {
      let observed: Awaited<ReturnType<typeof exchange>>;
      beforeAll(async () => {
        observed = await exchange(artifact, scenario);
      }, TEST_TIMEOUT_MS);

      test("preserves authenticated exchange and rejects later data after fatal input", () => {
        const { records, client } = observed;
        expect(client.jid).toBe("user@example.test/r");
        expect(client.messages).toEqual(
          scenario === "invalid"
            ? ["before-ok"]
            : ["before-ok", "challenge", "after-ok"],
        );
        if (scenario === "invalid") {
          expect(client.errors.length).toBeGreaterThanOrEqual(1);
        } else {
          expect(client.errors).toEqual([]);
        }
        verifyExchange(records, scenario, "xmpp");
        if (scenario === "invalid" && Bun.version === "1.4.4") {
          // Keep the known failure narrow: other fatal outcomes are not #106.
          expect([FATAL_ILLEGAL_PARAMETER, FATAL_DECODE_ERROR]).toContain(
            records.received.find(({ type }) => type === ALERT)!.bytes,
          );
        }
      });

      if (scenario === "invalid") {
        // Only the exact native alert is expected to fail; setup, EOF and
        // application isolation above remain unconditional requirements.
        const verify = Bun.version === "1.4.4" ? test.failing : test;
        verify(
          `emits fatal illegal_parameter${Bun.version === "1.4.4" ? " [expected Bun 1.4.4 violation #106]" : ""}`,
          () => {
            expect(
              observed.records.received.filter(({ type }) => type === ALERT),
            ).toEqual([{ type: ALERT, bytes: FATAL_ILLEGAL_PARAMETER }]);
          },
        );
      }
    });
  }
}
