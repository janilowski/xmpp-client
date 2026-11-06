import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";
import { parseHello } from "./fixtures/client-hello.mjs";

// RFC 7301 entry point: §3 extension encoding and HTTP transport negotiation;
// RFC 9325 §3.8 requires ALPN support and recommends refusing unoffered selections.
// An absent server ALPN response is valid. XMPP is the WebSocket subprotocol, not our
// TLS ALPN. Unsolicited extensions and resumed handshakes are separate scopes.
// https://www.rfc-editor.org/rfc/rfc7301.html#section-3
// https://www.rfc-editor.org/rfc/rfc9325.html#section-3.8
const ALPN = 16;
const SERVER_HELLO = 2;
const ENCRYPTED_EXTENSIONS = 8;
const HTTP_PROTOCOL = "http/1.1";
const FATAL = 2;
const ILLEGAL_PARAMETER = 47;
const X25519 = 29;
const TLS12_CIPHER = 0xc02f;
const TLS13_CIPHER = 0x1301;
const RSA_KEY_BITS = 2048;
const CHILD_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 30000;
const RESPONSE_TIMEOUT_MS = 7000;
const SETUP_TIMEOUT_MS = 30000;
const VERSIONS = [3, 4] as const;
const PROTOCOLS = { 3: "TLSv1.2", 4: "TLSv1.3" } as const;
const SCENARIOS = ["none", "offered", "unoffered"] as const;
type Version = (typeof VERSIONS)[number];
type Scenario = (typeof SCENARIOS)[number];
type Mode = "direct" | "discovery";
type Runtime = "native" | "source" | "ESM" | "minified";
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
  alpn?: string | false;
  protocol?: string;
  body?: string;
  node?: string;
};
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-alpn-"));
  const authority = await generate(
    [{ name: "commonName", value: "ALPN fixture CA" }],
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

// Independent bounded readers validate serialized vectors, not fixture objects.
function protocols(source: Buffer) {
  assert.ok(source.length >= 3, "Truncated ALPN vector");
  assert.equal(
    source.readUInt16BE(0),
    source.length - 2,
    "Invalid ALPN length",
  );
  const values: string[] = [];
  for (let offset = 2; offset < source.length;) {
    const length = source[offset++];
    assert.ok(
      length > 0 && offset + length <= source.length,
      "Invalid ALPN name",
    );
    values.push(source.subarray(offset, offset + length).toString("hex"));
    offset += length;
  }
  return values;
}

function selectedProtocol(source: string, version: Version) {
  const data = Buffer.from(source, "hex");
  assert.ok(data.length >= 6, "Truncated server handshake");
  assert.equal(data[0], version === 3 ? SERVER_HELLO : ENCRYPTED_EXTENSIONS);
  assert.equal(
    data.readUIntBE(1, 3),
    data.length - 4,
    "Invalid handshake length",
  );
  // ServerHello: version(2), random(32), session-id vector, cipher(2), null(1).
  const offset = version === 3 ? 4 + 38 + data[4 + 34] : 4;
  assert.ok(offset + 2 <= data.length, "Truncated server extensions");
  const size = data.readUInt16BE(offset);
  assert.equal(
    offset + 2 + size,
    data.length,
    "Invalid extension block length",
  );
  const selections: string[][] = [];
  for (let index = offset + 2; index < data.length;) {
    assert.ok(index + 4 <= data.length, "Truncated extension header");
    const type = data.readUInt16BE(index);
    const length = data.readUInt16BE(index + 2);
    index += 4;
    assert.ok(index + length <= data.length, "Truncated extension value");
    if (type === ALPN) {
      const values = protocols(data.subarray(index, index + length));
      assert.equal(values.length, 1, "Server must select exactly one protocol");
      selections.push(values);
    }
    index += length;
  }
  assert.ok(selections.length <= 1, "Duplicate ALPN response");
  return selections[0]?.[0] ?? null;
}

function validateRefusal(
  result: Result,
  records: Connection[],
  version: Version,
) {
  assert.equal(
    result.accepted,
    false,
    "Client accepted an unoffered ALPN protocol",
  );
  assert.notEqual(result.name, "TimeoutError", "Timeout is not ALPN refusal");
  assert.ok(records.length > 0, "No client connection observed");
  for (const record of records) {
    assert.equal(
      record.session,
      null,
      "TLS session completed despite unoffered ALPN",
    );
    assert.deepEqual(record.requests, [], "HTTP sent despite unoffered ALPN");
    assert.deepEqual(
      record.upgrades,
      [],
      "WebSocket upgraded despite unoffered ALPN",
    );
    assert.equal(record.alerts.length, 1, "Missing fatal TLS refusal");
    assert.equal(record.alerts[0][0], FATAL, "ALPN refusal must be fatal");
    if (version === 4) {
      // RFC 9846 §6: syntactically valid but semantically invalid parameters.
      assert.equal(record.alerts[0][1], ILLEGAL_PARAMETER);
    }
  }
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
            assert.equal(done, false, "ALPN peer exited before its response");
            pending += new TextDecoder().decode(value);
          }
          const end = pending.indexOf("\n");
          const value = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          return value;
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("ALPN peer response timed out")),
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
        ALPNProtocols:['http/1.1'],ecdhCurve:'X25519',minVersion:${JSON.stringify(PROTOCOLS[version])},maxVersion:${JSON.stringify(PROTOCOLS[version])}
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

test("RFC 7301 §3.1: independent literal ALPN vectors and response bounds", () => {
  const extension = "000f0010000b000908687474702f312e31";
  const server = "02000037" + "0303" + "00".repeat(32) + "00c02f00" + extension;
  const encrypted = "08000011" + extension;
  expect(selectedProtocol(server, 3)).toBe("687474702f312e31");
  expect(selectedProtocol(encrypted, 4)).toBe("687474702f312e31");
  expect(selectedProtocol("080000020000", 4)).toBeNull();
  expect(
    selectedProtocol("02000028" + "0303" + "00".repeat(32) + "00c02f000000", 3),
  ).toBeNull();
  expect(protocols(Buffer.from("000201ff", "hex"))).toEqual(["ff"]);
  expect(protocols(Buffer.from("000c02683208687474702f312e31", "hex"))).toEqual(
    ["6832", "687474702f312e31"],
  );
  for (const malformed of [
    "",
    "0000",
    "000100",
    "00020868",
    "000908687474702f312e",
  ]) {
    expect(() => protocols(Buffer.from(malformed, "hex"))).toThrow();
  }
  expect(() => selectedProtocol(encrypted.slice(0, -2), 4)).toThrow();
  expect(() =>
    selectedProtocol("08000011000f0010000b0009026832056f74686572", 4),
  ).toThrow("Server must select exactly one protocol");
});

test("ALPN refusal oracle rejects permissive outcomes, missing alerts and application leakage", () => {
  const record: Connection = {
    hellos: [],
    responses: [],
    session: null,
    group: null,
    requests: [],
    upgrades: [],
    alerts: [[FATAL, ILLEGAL_PARAMETER]],
    errors: [],
  };
  expect(() => validateRefusal({ accepted: false }, [record], 4)).not.toThrow();
  expect(() => validateRefusal({ accepted: true }, [record], 4)).toThrow();
  expect(() =>
    validateRefusal({ accepted: false, name: "TimeoutError" }, [record], 4),
  ).toThrow();
  expect(() => validateRefusal({ accepted: false }, [], 4)).toThrow();
  for (const broken of [
    { ...record, alerts: [] },
    { ...record, alerts: [[1, ILLEGAL_PARAMETER]] },
    { ...record, alerts: [[FATAL, 0]] },
    { ...record, requests: ["/.well-known/host-meta"] },
    { ...record, upgrades: [{ path: "/xmpp", protocol: "xmpp" }] },
    {
      ...record,
      session: { version: [3, 4], cipher: TLS13_CIPHER, resumed: false },
    },
  ]) {
    expect(() => validateRefusal({ accepted: false }, [broken], 4)).toThrow();
  }
});

for (const version of VERSIONS) {
  for (const scenario of SCENARIOS) {
    for (const runtime of ["native", "source", "ESM", "minified"] as const) {
      for (const mode of runtime === "native"
        ? (["direct"] as const)
        : (["direct", "discovery"] as const)) {
        test(
          `RFC 7301 §3 / RFC 9325 §3.8: ${PROTOCOLS[version]} ${runtime} ${mode}, ${scenario} ALPN selection`,
          async () => {
            const { result, records } = await observe(
              version,
              scenario,
              runtime,
              mode,
            );
            expect(records.length).toBeGreaterThan(0);
            for (const record of records) {
              expect(record.hellos.length).toBeGreaterThan(0);
              expect(record.responses.length).toBeGreaterThan(0);
              const offers = record.hellos.map((source) => {
                const bytes = Buffer.from(source, "hex");
                expect(bytes[0]).toBe(1);
                expect(bytes.readUIntBE(1, 3)).toBe(bytes.length - 4);
                const extensions = parseHello(
                  bytes.subarray(4),
                ).extensions.filter(({ type }) => type === ALPN);
                expect(extensions.length).toBeLessThanOrEqual(1);
                // Establish this case's applicability. An unsolicited ALPN
                // extension is a different failure, not an unoffered choice.
                if (scenario !== "none") {
                  expect(extensions.length).toBe(1);
                }
                return extensions.length
                  ? protocols(Buffer.from(extensions[0].value, "hex"))
                  : [];
              });
              for (const response of record.responses) {
                const selected = selectedProtocol(response, version);
                if (scenario === "none") {
                  expect(selected).toBeNull();
                  continue;
                }
                expect(selected).not.toBeNull();
                for (const offered of offers) {
                  expect(offered.includes(selected!)).toBe(
                    scenario === "offered",
                  );
                }
                if (scenario === "offered") {
                  expect(selected).toBe(
                    Buffer.from(HTTP_PROTOCOL).toString("hex"),
                  );
                }
              }
            }
            if (scenario === "unoffered") {
              if (runtime === "native") {
                expect(result).toMatchObject({
                  accepted: false,
                  code: "EPROTO",
                });
                expect(result.message).toMatch(
                  /tls_parse_stoc_alpn:bad extension/,
                );
                expect(
                  records.every(
                    (record) =>
                      record.session === null &&
                      !record.requests.length &&
                      !record.upgrades.length,
                  ),
                ).toBe(true);
              } else {
                validateRefusal(result, records, version);
                if (mode === "direct") {
                  expect(result.message).toContain("INVALID_ALPN_PROTOCOL");
                }
              }
              return;
            }
            expect(result.accepted).toBe(true);
            for (const record of records) {
              expect(record.session).toEqual({
                version: [3, version],
                cipher: version === 3 ? TLS12_CIPHER : TLS13_CIPHER,
                resumed: false,
              });
              expect(record.group).toBe(X25519);
              expect(record.errors).toEqual([]);
            }
            const requests = records.flatMap((record) => record.requests);
            const upgrades = records.flatMap((record) => record.upgrades);
            if (runtime === "native") {
              expect(result.node).toMatch(/^v\d+\./);
              expect(result).toMatchObject({
                authorized: true,
                alpn: scenario === "none" ? false : HTTP_PROTOCOL,
                protocol: PROTOCOLS[version],
                body: "authenticated ALPN peer",
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
}
