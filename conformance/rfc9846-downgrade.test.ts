import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";
import { parseHello } from "./fixtures/client-hello.mjs";

// RFC 9846 §4.2.3: TLS 1.3 clients must reject either exact downgrade
// sentinel in a TLS 1.2 ServerHello, but retain ordinary TLS 1.2 compatibility.
// https://www.rfc-editor.org/rfc/rfc9846.html#section-4.2.3
const CLIENT_HELLO = 1;
const SERVER_HELLO = 2;
const SUPPORTED_VERSIONS = 43;
const TLS12 = 0x0303;
const TLS13 = 0x0304;
const TLS12_CIPHER = 0xc02f;
const TLS12_SENTINEL = "444f574e47524401";
const TLS11_SENTINEL = "444f574e47524400";
const NEAR_MATCH = "444f574e47524402";
const FATAL = 2;
const ILLEGAL_PARAMETER = 47;
const GENERAL_ERROR = 117;
const FATAL_ILLEGAL_PARAMETER = [FATAL, ILLEGAL_PARAMETER];
const X25519 = 29;
const RSA_KEY_BITS = 2048;
const CHILD_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 30000;
const RESPONSE_TIMEOUT_MS = 7000;
const SETUP_TIMEOUT_MS = 30000;
const SCENARIOS = [
  "ordinary",
  "near-match",
  "tls12-sentinel",
  "tls11-sentinel",
] as const;
type Scenario = (typeof SCENARIOS)[number];
type Runtime =
  "native TLS1.2" | "native TLS1.3" | "source" | "ESM" | "minified";
type Mode = "direct" | "discovery";
type Connection = {
  hellos: string[];
  responses: string[];
  session: null | { version: number[]; cipher: number; resumed: boolean };
  group: number | null;
  requests: string[];
  upgrades: { path: string; protocol: string }[];
  alerts: number[][];
  errors: { name: string; message: string }[];
};
type Result = {
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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-downgrade-"));
  const authority = await generate(
    [{ name: "commonName", value: "Downgrade fixture CA" }],
    {
      keySize: RSA_KEY_BITS,
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
      keySize: RSA_KEY_BITS,
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
  expect(leaf.checkHost("localhost", { subject: "never" })).toBe("localhost");
  for (const item of [root, leaf]) {
    expect(Date.parse(item.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(item.validTo)).toBeGreaterThan(Date.now());
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

function offeredVersions(source: string) {
  const data = Buffer.from(source, "hex");
  assert.ok(data.length >= 4, "Truncated ClientHello");
  assert.equal(data[0], CLIENT_HELLO);
  assert.equal(data.readUIntBE(1, 3), data.length - 4);
  const extensions = parseHello(data.subarray(4)).extensions.filter(
    ({ type }) => type === SUPPORTED_VERSIONS,
  );
  assert.ok(extensions.length <= 1, "Duplicate supported_versions");
  if (!extensions.length) {
    return [];
  }
  const bytes = Buffer.from(extensions[0].value, "hex");
  assert.ok(bytes.length >= 3, "Empty supported_versions");
  assert.equal(bytes[0], bytes.length - 1, "Invalid supported_versions length");
  assert.equal(bytes[0] % 2, 0, "Partial supported version");
  const versions: number[] = [];
  for (let offset = 1; offset < bytes.length; offset += 2) {
    versions.push(bytes.readUInt16BE(offset));
  }
  return versions;
}

function serverHello(source: string) {
  const data = Buffer.from(source, "hex");
  assert.ok(data.length >= 42, "Truncated ServerHello");
  assert.equal(data[0], SERVER_HELLO);
  assert.equal(data.readUIntBE(1, 3), data.length - 4);
  assert.equal(data.readUInt16BE(4), TLS12);
  const sessionLength = data[38];
  assert.ok(sessionLength <= 32, "Invalid session ID");
  const end = 42 + sessionLength;
  assert.ok(end <= data.length, "Truncated ServerHello fields");
  assert.equal(data[end - 1], 0, "Unexpected compression");
  if (data.length > end) {
    assert.ok(end + 2 <= data.length, "Truncated extension block");
    assert.equal(end + 2 + data.readUInt16BE(end), data.length);
  }
  return {
    random: data.subarray(6, 38).toString("hex"),
    cipher: data.readUInt16BE(end - 3),
  };
}

test("downgrade byte oracle distinguishes exact sentinel suffixes and valid alternatives", () => {
  const prefix = "020000260303";
  for (const marker of [TLS12_SENTINEL, TLS11_SENTINEL, NEAR_MATCH]) {
    const hello = serverHello(prefix + "ab".repeat(24) + marker + "00c02f00");
    expect(hello.random.slice(-16)).toBe(marker);
    expect(hello.cipher).toBe(TLS12_CIPHER);
  }
  const interior = TLS12_SENTINEL + "ab".repeat(24);
  expect(serverHello(prefix + interior + "00c02f00").random).toBe(interior);
  expect(() => serverHello(prefix + "ab".repeat(31) + "00c02f00")).toThrow();
  expect(() => serverHello("080000020000")).toThrow();
});

test("downgrade applicability oracle reads actual supported_versions and rejects malformed bounds", () => {
  const prefix = "010000340303" + "00".repeat(32);
  const hello = prefix + "000002c02f01000009002b00050403040303";
  expect(offeredVersions(hello)).toEqual([TLS13, TLS12]);
  expect(
    offeredVersions(prefix + "000002c02f01000009002b00050403047f17"),
  ).toEqual([TLS13, 0x7f17]);
  expect(() =>
    offeredVersions(prefix + "000002c02f01000009002b00050303040303"),
  ).toThrow();
  expect(() => offeredVersions(hello.slice(0, -2))).toThrow();
});

function verifyRefusal(result: Result, records: Connection[]) {
  assert.equal(result.accepted, false, "Client accepted a downgrade sentinel");
  assert.notEqual(
    result.name,
    "TimeoutError",
    "Timeout is not downgrade refusal",
  );
  assert.ok(records.length > 0, "No client connection observed");
  for (const record of records) {
    assert.equal(
      record.session,
      null,
      "TLS session completed despite downgrade",
    );
    assert.deepEqual(record.requests, [], "HTTP sent despite downgrade");
    assert.deepEqual(
      record.upgrades,
      [],
      "WebSocket upgraded despite downgrade",
    );
    assert.equal(record.alerts.length, 1, "Missing or repeated fatal alert");
    assert.equal(record.alerts[0].length, 2, "Malformed fatal alert");
    assert.equal(record.alerts[0][0], FATAL);
    // RFC 9846 §6.2 also permits concealing this specific rejection reason.
    assert.ok(
      [ILLEGAL_PARAMETER, GENERAL_ERROR].includes(record.alerts[0][1]),
      "Incorrect fatal downgrade alert",
    );
  }
}

test("downgrade refusal oracle rejects acceptance, timeouts, application leaks and wrong alerts", () => {
  const record: Connection = {
    hellos: [],
    responses: [],
    session: null,
    group: null,
    requests: [],
    upgrades: [],
    alerts: [FATAL_ILLEGAL_PARAMETER],
    errors: [],
  };
  expect(() => verifyRefusal({ accepted: false }, [record])).not.toThrow();
  expect(() =>
    verifyRefusal({ accepted: false }, [{ ...record, alerts: [[2, 117]] }]),
  ).not.toThrow();
  expect(() => verifyRefusal({ accepted: true }, [record])).toThrow();
  expect(() =>
    verifyRefusal({ accepted: false, name: "TimeoutError" }, [record]),
  ).toThrow();
  expect(() => verifyRefusal({ accepted: false }, [])).toThrow();
  for (const broken of [
    { ...record, alerts: [] },
    { ...record, alerts: [[1, 47]] },
    { ...record, alerts: [[1, 117]] },
    { ...record, alerts: [[2, 50]] },
    { ...record, alerts: [[2, 40]] },
    { ...record, requests: ["/.well-known/host-meta"] },
    { ...record, upgrades: [{ path: "/xmpp", protocol: "xmpp" }] },
    {
      ...record,
      session: { version: [3, 3], cipher: TLS12_CIPHER, resumed: false },
    },
  ]) {
    expect(() => verifyRefusal({ accepted: false }, [broken])).toThrow();
  }
});

test("downgrade alert recorder retains plaintext fatal after compatibility CCS and ignores opaque GCM records", async () => {
  const child = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "-c",
      `
import ast, json, sys, types
with open(sys.argv[1]) as source:
    tree = ast.parse(source.read())
observer = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "ObservedSocket")
scope = {"TLS_RECORD_HEADER_BYTES": 5, "MAX_TLS_RECORD_BYTES": 18432,
         "TLS_ALERT_BYTES": 2, "ContentType": types.SimpleNamespace(alert=21, change_cipher_spec=20)}
exec(compile(ast.Module(body=[observer], type_ignores=[]), sys.argv[1], "exec"), scope)
class Raw:
    def __init__(self, chunks):
        self.chunks = [chunk for chunk in chunks if chunk] + [b""]
    def recv(self, size):
        return self.chunks.pop(0)
def observe(chunks):
    record = {"alerts": []}
    socket = scope["ObservedSocket"](Raw(chunks), record)
    while socket.recv(16384):
        pass
    return record["alerts"]
# Literal TLS records, not a cryptographic verifier. The opaque 26-byte
# payload stands for GCM explicit nonce(8), alert(2) and tag(16).
ccs = bytes.fromhex("140303000101")
fatal = bytes.fromhex("1503030002022f")
opaque = bytes.fromhex("150303001a") + bytes(26)
wire = ccs + fatal + opaque
results = [observe([wire[:split], wire[split:]]) for split in range(len(wire) + 1)]
results.append(observe([bytes([value]) for value in wire]))
try:
    opaque_records = observe([opaque])
except AssertionError as error:
    opaque_records = {"error": str(error)}
print(json.dumps({"fragmented": results, "opaque": opaque_records}))
    `,
      "conformance/fixtures/tls-downgrade.py",
    ],
    { stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const records = JSON.parse(stdout) as {
    fragmented: number[][][];
    opaque: unknown;
  };
  expect(records.fragmented.length).toBeGreaterThan(0);
  for (const alerts of records.fragmented) {
    expect(alerts).toEqual([FATAL_ILLEGAL_PARAMETER]);
  }
  expect(records.opaque).toEqual([]);
});

async function observe(scenario: Scenario, runtime: Runtime, mode: Mode) {
  const peer = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "conformance/fixtures/tls-downgrade.py",
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
  let observation: { result: Result; records: Connection[] } | undefined;
  const failures: unknown[] = [];
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
              "Downgrade peer exited before its response",
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
            () => reject(new Error("Downgrade peer response timed out")),
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
    const native = runtime.startsWith("native");
    const service =
      mode === "direct"
        ? `wss://localhost:${ready.port}/xmpp`
        : `localhost:${ready.port}`;
    const source = native
      ? `
      import tls from 'node:tls';import {readFileSync} from 'node:fs';
      if(process.versions.bun){throw Error('Native Node required');}
      const socket=tls.connect({host:'localhost',port:${ready.port},servername:'localhost',
        ca:readFileSync(${JSON.stringify(join(directory, "ca.pem"))}),rejectUnauthorized:true,
        ALPNProtocols:['http/1.1'],ecdhCurve:'X25519',minVersion:'TLSv1.2',maxVersion:${JSON.stringify(runtime === "native TLS1.2" ? "TLSv1.2" : "TLSv1.3")}
      });let response='';
      // Send HTTP only after authentication; an early HTTPS write can mask the
      // native alert. Explicit destroy on error is control cleanup, not proof
      // of the library/runtime's automatic socket-closure policy.
      socket.on('secureConnect',()=>socket.write('GET /probe HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'));
      socket.on('data',data=>response+=data);
      socket.on('end',()=>console.log(JSON.stringify({accepted:response.startsWith('HTTP/1.1 200 OK\\r\\n'),node:process.version,authorized:socket.authorized,protocol:socket.getProtocol(),body:response.split('\\r\\n\\r\\n')[1]})));
      socket.on('error',error=>{console.log(JSON.stringify({accepted:false,node:process.version,name:error.name,code:error.code,message:error.message}));socket.destroy();});
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
        native ? (process.env.XMPP_TEST_NODE ?? "node") : process.execPath,
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
    observation = { result, records: snapshot.records };
    completed = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    try {
      if (completed && peer.exitCode === null) {
        peer.stdin.write("stop\n");
        peer.stdin.end();
      } else {
        peer.kill();
      }
    } catch (error) {
      failures.push(error);
      peer.kill();
    }
    const [exit, errors] = await Promise.allSettled([peer.exited, stderr]);
    for (const result of [exit, errors]) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
    if (
      completed &&
      exit.status === "fulfilled" &&
      errors.status === "fulfilled"
    ) {
      expect({ exit: exit.value, errors: errors.value }).toEqual({
        exit: 0,
        errors: "",
      });
    }
  } catch (error) {
    failures.push(error);
  } finally {
    reader.releaseLock();
  }
  if (failures.length) {
    throw failures[0];
  }
  assert.ok(observation);
  return observation;
}

for (const scenario of SCENARIOS) {
  for (const runtime of [
    "native TLS1.2",
    "native TLS1.3",
    "source",
    "ESM",
    "minified",
  ] as const) {
    for (const mode of runtime.startsWith("native")
      ? (["direct"] as const)
      : (["direct", "discovery"] as const)) {
      test(
        `RFC 9846 §4.2.3: ${runtime} ${mode}, ${scenario} ServerHello random`,
        async () => {
          const { result, records } = await observe(scenario, runtime, mode);
          const marker =
            scenario === "tls12-sentinel"
              ? TLS12_SENTINEL
              : scenario === "tls11-sentinel"
                ? TLS11_SENTINEL
                : scenario === "near-match"
                  ? NEAR_MATCH
                  : undefined;
          expect(records.length).toBeGreaterThan(0);
          for (const record of records) {
            expect(record.hellos.length).toBeGreaterThan(0);
            expect(record.responses.length).toBeGreaterThan(0);
            for (const hello of record.hellos) {
              // The lower-capability control is deliberate: it authenticates the
              // same marked peer without triggering the TLS 1.3-only requirement.
              expect(offeredVersions(hello).includes(TLS13)).toBe(
                runtime !== "native TLS1.2",
              );
            }
            for (const source of record.responses) {
              const hello = serverHello(source);
              expect(hello.cipher).toBe(TLS12_CIPHER);
              if (marker) {
                expect(hello.random.slice(-16)).toBe(marker);
              } else {
                expect([TLS12_SENTINEL, TLS11_SENTINEL]).not.toContain(
                  hello.random.slice(-16),
                );
              }
            }
            expect(
              record.errors.every(({ name }) =>
                [
                  "TLSRemoteAlert",
                  "TLSAbruptCloseError",
                  "BrokenPipeError",
                  "ConnectionResetError",
                ].includes(name),
              ),
            ).toBe(true);
          }
          if (scenario.endsWith("sentinel") && runtime !== "native TLS1.2") {
            verifyRefusal(result, records);
            return;
          }
          expect(result.accepted).toBe(true);
          for (const record of records) {
            expect(record.session).toEqual({
              version: [3, 3],
              cipher: TLS12_CIPHER,
              resumed: false,
            });
            expect(record.group).toBe(X25519);
            expect(record.errors).toEqual([]);
          }
          const requests = records.flatMap((record) => record.requests);
          const upgrades = records.flatMap((record) => record.upgrades);
          if (runtime.startsWith("native")) {
            expect(result.node).toMatch(/^v\d+\./);
            expect(result).toMatchObject({
              authorized: true,
              protocol: "TLSv1.2",
              body: "authenticated downgrade peer",
            });
            expect(requests).toEqual(["/probe"]);
            expect(upgrades).toEqual([]);
          } else {
            expect(requests).toEqual(
              mode === "direct"
                ? ["/xmpp"]
                : ["/.well-known/host-meta", "/xmpp"],
            );
            expect(upgrades).toEqual([{ path: "/xmpp", protocol: "xmpp" }]);
          }
        },
        PEER_TIMEOUT_MS,
      );
    }
  }
}
