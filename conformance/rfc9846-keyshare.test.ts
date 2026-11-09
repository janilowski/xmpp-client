import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";
import { parseHello } from "./fixtures/client-hello.mjs";

// RFC 9846 §4.3.8: client shares follow supported_groups and must not be
// reused across connections. Peer reuse remains explicitly permitted.
// Three successful cycles are bounded samples, not proof of RNG independence,
// private-key erasure, every group, browser behavior or server-share handling.
// https://datatracker.ietf.org/doc/html/rfc9846#section-4.3.8
const SUPPORTED_GROUPS = 10;
const KEY_SHARE = 51;
const CLIENT_HELLO = 1;
const X25519 = 29;
const TLS13_AES128_GCM_SHA256 = 0x1301;
const RSA_KEY_BITS = 2048;
const CONNECTIONS = 3;
const CHILD_TIMEOUT_MS = 15000;
const PEER_TIMEOUT_MS = 30000;
const RESPONSE_TIMEOUT_MS = 7000;
const SETUP_TIMEOUT_MS = 30000;
type Hello = ReturnType<typeof parseHello>;
type Share = { group: number; key: string };
type Connection = {
  hellos: string[];
  session: null | { version: number[]; cipher: number; resumed: boolean };
  group: number | null;
  requests: string[];
  upgrades: { path: string; protocol: string }[];
  errors: { name: string; message: string }[];
};
let directory: string;

function clientShares(hello: Hello): Share[] {
  const groupExtensions = hello.extensions.filter(
    ({ type }) => type === SUPPORTED_GROUPS,
  );
  const shareExtensions = hello.extensions.filter(
    ({ type }) => type === KEY_SHARE,
  );
  assert.equal(
    groupExtensions.length,
    1,
    "Missing or duplicate supported_groups",
  );
  assert.equal(shareExtensions.length, 1, "Missing or duplicate key_share");
  const supported = Buffer.from(groupExtensions[0]!.value, "hex");
  assert.ok(supported.length >= 4, "Truncated supported_groups");
  assert.equal(
    supported.readUInt16BE(0),
    supported.length - 2,
    "Invalid supported_groups length",
  );
  assert.equal(supported.length % 2, 0, "Unpaired supported group");
  const groups: number[] = [];
  for (let offset = 2; offset < supported.length; offset += 2) {
    const group = supported.readUInt16BE(offset);
    assert.ok(!groups.includes(group), "Duplicate supported group");
    groups.push(group);
  }
  const source = Buffer.from(shareExtensions[0]!.value, "hex");
  assert.ok(source.length >= 2, "Truncated key_share");
  assert.equal(
    source.readUInt16BE(0),
    source.length - 2,
    "Invalid key_share length",
  );
  const shares: Share[] = [];
  let previous = -1;
  for (let offset = 2; offset < source.length;) {
    assert.ok(offset + 4 <= source.length, "Truncated key-share header");
    const group = source.readUInt16BE(offset);
    const length = source.readUInt16BE(offset + 2);
    offset += 4;
    assert.ok(
      length > 0 && offset + length <= source.length,
      "Invalid key-share value",
    );
    const position = groups.indexOf(group);
    assert.ok(
      position > previous,
      "Unlisted, duplicate or unordered key-share group",
    );
    previous = position;
    shares.push({
      group,
      key: source.subarray(offset, offset + length).toString("hex"),
    });
    offset += length;
  }
  return shares;
}

function validateFreshShares(connections: Share[][][]) {
  assert.ok(connections.length >= 2, "Insufficient independent connections");
  const previous = new Set<string>();
  for (const hellos of connections) {
    assert.ok(hellos.length > 0, "Missing connection ClientHello");
    const current = new Set<string>();
    for (const shares of hellos) {
      for (const { group, key } of shares) {
        // RFC 8701 §3.1 permits arbitrary GREASE placeholder values.
        if ((group & 0x0f0f) === 0x0a0a && group >> 8 === (group & 255)) {
          continue;
        }
        const value = `${group}:${key}`;
        assert.ok(
          !previous.has(value),
          "Client reused a key share across connections",
        );
        current.add(value);
      }
    }
    // A cookie-only HRR may repeat a share within the same connection.
    for (const value of current) {
      previous.add(value);
    }
  }
}

test("RFC 9846 §4.3.8 oracle: empty and sparse client share lists remain valid", () => {
  const hello: Hello = {
    version: "0303",
    ciphers: ["1301"],
    compression: "00",
    extensions: [
      { type: 10, value: "00080a0a0017001d001e" },
      { type: 51, value: "0000" },
    ],
  };
  expect(clientShares(hello)).toEqual([]);
  hello.extensions[1].value = "00290a0a0001aa001d0020" + "11".repeat(32);
  expect(clientShares(hello)).toEqual([
    { group: 0x0a0a, key: "aa" },
    { group: 29, key: "11".repeat(32) },
  ]);
  for (const value of [
    "",
    "0001",
    "0003001d",
    "0006001d001d001e",
    "0008001d0017001e",
  ]) {
    expect(() =>
      clientShares({
        ...hello,
        extensions: [{ type: 10, value }, hello.extensions[1]],
      }),
    ).toThrow();
  }
});

test("RFC 9846 §4.3.8 oracle: reject duplicate, unordered, unoffered and truncated shares", () => {
  const hello: Hello = {
    version: "0303",
    ciphers: ["1301"],
    compression: "00",
    extensions: [
      { type: 10, value: "0004001d001e" },
      { type: 51, value: "0000" },
    ],
  };
  for (const value of [
    "",
    "0001",
    "000100",
    "0004001d0000",
    "0005001d0002aa",
    "000a001d0001aa001d0001bb",
    "000a001e0001aa001d0001bb",
    "000500170001aa",
  ]) {
    expect(() =>
      clientShares({
        ...hello,
        extensions: [hello.extensions[0], { type: 51, value }],
      }),
    ).toThrow();
  }
  for (const extensions of [
    [],
    [hello.extensions[0]],
    [hello.extensions[1]],
    [...hello.extensions, hello.extensions[0]],
    [...hello.extensions, hello.extensions[1]],
  ]) {
    expect(() => clientShares({ ...hello, extensions })).toThrow();
  }
});

test("RFC 9846 §4.3.8 oracle: compare connections, not repeated hellos or GREASE", () => {
  const first = { group: 29, key: "11".repeat(32) };
  const second = { group: 29, key: "22".repeat(32) };
  const grease = { group: 0x2a2a, key: "00" };
  expect(() =>
    validateFreshShares([
      [[], [first, grease], [first, grease]],
      [[second, grease]],
    ]),
  ).not.toThrow();
  expect(() => validateFreshShares([[[]], [[]]])).not.toThrow();
  expect(() =>
    validateFreshShares([[[first]], [[second]], [[first]]]),
  ).toThrow();
  expect(() => validateFreshShares([])).toThrow();
  expect(() => validateFreshShares([[[first]]])).toThrow();
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-keyshare-"));
  const authority = await generate(
    [{ name: "commonName", value: "Key-share fixture CA" }],
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

async function observe(
  runtime: "native" | "source" | "ESM" | "minified",
  mode: "direct" | "discovery",
) {
  // This existing independent peer supplies real full handshakes and records
  // each TCP connection separately; it never issues resumption tickets.
  const peer = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "conformance/fixtures/tls-alpn.py",
      resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
      directory,
      "4",
      "offered",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: PEER_TIMEOUT_MS },
  );
  const reader = peer.stdout.getReader();
  const peerErrors = new Response(peer.stderr).text();
  let pending = "";
  let completed = false;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
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
              "Key-share peer exited before its response",
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
            () => reject(new Error("Key-share peer response timed out")),
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
    const code =
      runtime === "native"
        ? `
      import assert from 'node:assert/strict';import https from 'node:https';import {readFileSync} from 'node:fs';
      assert.equal(process.versions.bun,undefined,'Native Node required');
      const results=[];
      for(let cycle=0;cycle<${CONNECTIONS};cycle++){
        results.push(await new Promise((resolve,reject)=>{
          const request=https.get('https://localhost:${ready.port}/probe',{
            ca:readFileSync(${JSON.stringify(join(directory, "ca.pem"))}),rejectUnauthorized:true,agent:false,
            ALPNProtocols:['http/1.1'],ecdhCurve:'X25519',minVersion:'TLSv1.3',maxVersion:'TLSv1.3'
          },response=>{
            const socket=response.socket;let body='';response.on('data',data=>body+=data);
            response.on('end',()=>resolve({accepted:true,authorized:socket.authorized,protocol:socket.getProtocol(),body}));
          });request.on('error',reject);
        }));
      }
      console.log(JSON.stringify({pid:process.pid,results}));
    `
        : `
      const {client}=${runtime === "source" ? 'await import("./src/client/index.js")' : runtime === "ESM" ? 'await import("./dist/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
      const results=[];
      for(let cycle=0;cycle<${CONNECTIONS};cycle++){
        const entity=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:3000});
        entity.reconnect.stop();entity.on('error',()=>{});
        try{await entity.connect(entity.options.service);results.push({accepted:true});}
        catch(error){results.push({accepted:false,name:error.name,message:error.message});}
        finally{await entity.stop();}
      }
      console.log(JSON.stringify({pid:process.pid,results}));
    `;
    child = Bun.spawn(
      [
        runtime === "native"
          ? (process.env.XMPP_TEST_NODE ?? "node")
          : process.execPath,
        "--input-type=module",
        "--eval",
        code,
      ],
      {
        stdin: "ignore",
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
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result.pid).toBe(child.pid);
    expect(result.results).toEqual(
      Array.from({ length: CONNECTIONS }, () =>
        runtime === "native"
          ? {
              accepted: true,
              authorized: true,
              protocol: "TLSv1.3",
              body: "authenticated ALPN peer",
            }
          : { accepted: true },
      ),
    );
    peer.stdin.write("snapshot\n");
    const snapshot = await receive();
    expect(snapshot.type).toBe("snapshot");
    const records = snapshot.records as Connection[];
    expect(records).toHaveLength(
      CONNECTIONS * (runtime !== "native" && mode === "discovery" ? 2 : 1),
    );
    const connections: Share[][][] = [];
    for (const record of records) {
      expect(record.session).toEqual({
        version: [3, 4],
        cipher: TLS13_AES128_GCM_SHA256,
        resumed: false,
      });
      expect(record.group).toBe(X25519);
      expect(record.errors).toEqual([]);
      expect(record.hellos.length).toBeGreaterThan(0);
      const hellos = record.hellos.map((source) => {
        const bytes = Buffer.from(source, "hex");
        expect(bytes[0]).toBe(CLIENT_HELLO);
        expect(bytes.readUIntBE(1, 3)).toBe(bytes.length - 4);
        return clientShares(parseHello(bytes.subarray(4)));
      });
      // Empty initial shares are legal: the successful selected exchange, not
      // an initial nonempty-list assertion, establishes freshness applicability.
      expect(
        hellos.some((shares) => shares.some(({ group }) => group === X25519)),
      ).toBe(true);
      connections.push(hellos);
    }
    expect(records.flatMap(({ requests }) => requests).toSorted()).toEqual(
      Array.from({ length: CONNECTIONS }, () =>
        runtime === "native"
          ? ["/probe"]
          : mode === "direct"
            ? ["/xmpp"]
            : ["/.well-known/host-meta", "/xmpp"],
      )
        .flat()
        .toSorted(),
    );
    expect(records.flatMap(({ upgrades }) => upgrades)).toEqual(
      runtime === "native"
        ? []
        : Array.from({ length: CONNECTIONS }, () => ({
            path: "/xmpp",
            protocol: "xmpp",
          })),
    );
    expect(() => validateFreshShares(connections)).not.toThrow();
    completed = true;
  } finally {
    if (completed) {
      peer.stdin.write("stop\n");
      peer.stdin.end();
    } else {
      child?.kill();
      peer.kill();
    }
    const [exit, stderr] = await Promise.all([peer.exited, peerErrors]);
    reader.releaseLock();
    if (completed) {
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    }
  }
}

test(
  "RFC 9846 §4.3.8: native control observes fresh shares after authenticated connections",
  async () => {
    await observe("native", "direct");
  },
  PEER_TIMEOUT_MS,
);

for (const runtime of ["source", "ESM", "minified"] as const) {
  for (const mode of ["direct", "discovery"] as const) {
    test(
      `RFC 9846 §4.3.8: ${runtime} ${mode} client shares remain fresh across authenticated connections`,
      async () => {
        await observe(runtime, mode);
      },
      PEER_TIMEOUT_MS,
    );
  }
}
