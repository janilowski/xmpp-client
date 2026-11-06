import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerHello } from "./fixtures/tls-cbc.mjs";
import { createTLSCertificates } from "./tls-certificates.ts";
import { observeOffers } from "./tls-offers.ts";

// RFC 9325 §4.2: CBC SHOULD NOT be used without negotiated EtM, on either
// endpoint. RFC 7366 §2 requires an empty extension on both sides. A CBC
// offer alone is not a negotiated violation, nor proof of a successful attack.
// The approved #102 native policy excludes CBC, including explicit CBC-only
// configurations; that local policy is stronger than the conditional SHOULD.
// https://www.rfc-editor.org/rfc/rfc9325.html#section-4.2
// https://www.rfc-editor.org/rfc/rfc7366.html#section-2
const ENCRYPT_THEN_MAC = 22;
const SUPPORTED_VERSIONS = 43;
const TLS13_VERSION = 0x0304;
const LEGACY_VERSIONS = new Set([0x0300, 0x0301, 0x0302, 0x0303]);
const TLS12 = "TLSv1.2";
const TLS13 = "TLSv1.3";
const CHILD_TIMEOUT_MS = 8000;
const RESPONSE_TIMEOUT_MS = 7000;
const PEER_TIMEOUT_MS = 30000;
const SETUP_TIMEOUT_MS = 30000;
const CIPHERS = {
  CBC: {
    protocol: TLS12,
    name: "ECDHE-RSA-AES128-SHA256",
    id: "c027",
    standard: "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256",
  },
  GCM: {
    protocol: TLS12,
    name: "ECDHE-RSA-AES128-GCM-SHA256",
    id: "c02f",
    standard: "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
  },
  GCM256: {
    protocol: TLS12,
    name: "ECDHE-RSA-AES256-GCM-SHA384",
    id: "c030",
    standard: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
  },
  TLS13: {
    protocol: TLS13,
    name: "TLS_AES_128_GCM_SHA256",
    id: "1301",
    standard: "TLS_AES_128_GCM_SHA256",
  },
};
// Independent IANA TLS Cipher Suites entries whose names contain _CBC_,
// reviewed 2026-11-06. Not the production filter or only today's native offers.
// https://www.iana.org/assignments/tls-parameters/tls-parameters-4.csv
const CBC_CIPHERS = new Set(
  `
0006 0007 0008 0009 000a 000b 000c 000d 000e 000f 0010 0011 0012 0013 0014
0015 0016 0019 001a 001b 001e 001f 0021 0022 0023 0025 0026 0027 0029 002a
002f 0030 0031 0032 0033 0034 0035 0036 0037 0038 0039 003a 003c 003d 003e
003f 0040 0041 0042 0043 0044 0045 0046 0067 0068 0069 006a 006b 006c 006d
0084 0085 0086 0087 0088 0089 008b 008c 008d 008f 0090 0091 0093 0094 0095
0096 0097 0098 0099 009a 009b 00ae 00af 00b2 00b3 00b6 00b7 00ba 00bb 00bc
00bd 00be 00bf 00c0 00c1 00c2 00c3 00c4 00c5 c003 c004 c005 c008 c009 c00a
c00d c00e c00f c012 c013 c014 c017 c018 c019 c01a c01b c01c c01d c01e c01f
c020 c021 c022 c023 c024 c025 c026 c027 c028 c029 c02a c034 c035 c036 c037
c038 c03c c03d c03e c03f c040 c041 c042 c043 c044 c045 c046 c047 c048 c049
c04a c04b c04c c04d c04e c04f c064 c065 c066 c067 c068 c069 c070 c071 c072
c073 c074 c075 c076 c077 c078 c079 c094 c095 c096 c097 c098 c099 c09a c09b
`
    .trim()
    .split(/\s+/),
);
type Extension = { type: number; value: string };
type Connection = {
  id: number;
  clientHello: { ciphers: string[]; extensions: Extension[] } | null;
  serverHello: {
    cipher: string;
    compression: number;
    extensions: Extension[];
  } | null;
  errors: string[];
};
type Records = {
  connections: Connection[];
  sessions: { id: number; protocol: string; cipher: string; reused: boolean }[];
  requests: { id: number; path: string }[];
  upgrades: { id: number; path: string; subprotocol: string }[];
  errors: string[];
  observerErrors: string[];
};
type Message = {
  type: string;
  port: number;
  node: string;
  probe: {
    accepted: boolean;
    authorized: boolean;
    receivedHTTP: boolean;
    protocol: string;
    cipher: string;
    reused: boolean;
    key: { type: string; name: string };
  };
  records: Records;
};
let directory: string;
let certificateDirectory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-cbc-"));
  const certificates = await createTLSCertificates(directory);
  certificateDirectory = certificates.find(
    ({ name }) => name === "rsa-pkcs1",
  )!.directory;
}, SETUP_TIMEOUT_MS);
afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

function negotiatedEtM(connection: Connection) {
  return [connection.clientHello, connection.serverHello].every((hello) => {
    const extensions = hello?.extensions.filter(
      ({ type }) => type === ENCRYPT_THEN_MAC,
    );
    return extensions?.length === 1 && extensions[0]?.value === "";
  });
}

test("RFC 7366 §2 observer: literal EtM, fragmentation and malformed bounds", () => {
  // TLS record + ServerHello: TLS 1.2, zero random, empty session ID, C027,
  // null compression and the literal empty EtM extension. No production encoder.
  const source = Buffer.from(
    "16030300300200002c0303" + "00".repeat(32) + "00c02700000400160000",
    "hex",
  );
  const expected = {
    version: "0303",
    cipher: "c027",
    compression: 0,
    extensions: [{ type: ENCRYPT_THEN_MAC, value: "" }],
  };
  for (let split = 0; split <= source.length; split++) {
    const reader = new ServerHello();
    expect(
      reader.feed(source.subarray(0, split)) ??
        reader.feed(source.subarray(split)),
    ).toEqual(expected);
  }
  const reader = new ServerHello();
  let observed;
  for (const byte of source) {
    observed = reader.feed(Buffer.from([byte])) ?? observed;
  }
  expect(observed).toEqual(expected);
  const body = source.subarray(5);
  const fragmented = Buffer.concat([
    Buffer.from([22, 3, 3, 0, 7]),
    body.subarray(0, 7),
    Buffer.from([22, 3, 3, 0, body.length - 7]),
    body.subarray(7),
  ]);
  expect(new ServerHello().feed(fragmented)).toEqual(expected);
  const malformed = Buffer.from(source);
  malformed[48] = 5;
  expect(() => new ServerHello().feed(malformed)).toThrow(
    "Invalid extensions length",
  );
});

test("RFC 7366 §2 oracle requires both empty EtM extensions", () => {
  const hello = { extensions: [{ type: ENCRYPT_THEN_MAC, value: "" }] };
  const connection = {
    id: 1,
    clientHello: { ...hello, ciphers: ["c027"] },
    serverHello: { ...hello, cipher: "c027", compression: 0 },
    errors: [],
  };
  expect(negotiatedEtM(connection)).toBe(true);
  expect(
    negotiatedEtM({
      ...connection,
      serverHello: { ...connection.serverHello, extensions: [] },
    }),
  ).toBe(false);
  expect(
    negotiatedEtM({
      ...connection,
      clientHello: {
        ...connection.clientHello,
        extensions: [{ type: ENCRYPT_THEN_MAC, value: "00" }],
      },
    }),
  ).toBe(false);
  expect(
    negotiatedEtM({
      ...connection,
      serverHello: {
        ...connection.serverHello,
        extensions: [...hello.extensions, ...hello.extensions],
      },
    }),
  ).toBe(false);
  expect(CBC_CIPHERS.size).toBe(180);
  for (const cipher of ["000a", "c013", "c023", "c027", "c028", "c09b"]) {
    expect(CBC_CIPHERS.has(cipher)).toBe(true);
  }
  for (const cipher of ["c02f", "c02b", "cca8", "1301", "c0ac"]) {
    expect(CBC_CIPHERS.has(cipher)).toBe(false);
  }
});

async function exercise(
  artifact: string,
  mode: string,
  port: number,
  policy?: string,
) {
  const service =
    mode === "direct" ? `wss://localhost:${port}/xmpp` : `localhost:${port}`;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import tls from 'node:tls';
    const policy=${JSON.stringify(policy) ?? "undefined"};if(policy!==undefined){tls.DEFAULT_CIPHERS=policy;}
    const configured=tls.DEFAULT_CIPHERS;
    const {client}=${artifact === "source" ? 'await import("./src/client/index.js")' : artifact === "ESM" ? 'await import("./dist/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
    const xmpp=client({service:${JSON.stringify(service)},domain:'distinct-xmpp-service.test',timeout:2000});
    xmpp.reconnect.stop();xmpp.on('error',()=>{});let result;
    try{await xmpp.connect(xmpp.options.service);result={accepted:true};}
    catch(error){result={accepted:false,name:error.name};}
    finally{await xmpp.stop();}
    console.log(JSON.stringify({...result,globalUnchanged:tls.DEFAULT_CIPHERS===configured}));
  `,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
      env: {
        ...process.env,
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
        NODE_EXTRA_CA_CERTS: join(certificateDirectory, "ca.pem"),
      },
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(stdout) as {
    accepted: boolean;
    name?: string;
    globalUnchanged: boolean;
  };
  expect(result.name).not.toBe("TimeoutError");
  expect(result.globalUnchanged).toBe(true);
  return result;
}

const scenarios = [
  {
    name: "CBC requires negotiated EtM or refusal",
    peer: CIPHERS.CBC,
    outcome: "cbc",
  },
  { name: "paired GCM remains usable", peer: CIPHERS.GCM, outcome: "accept" },
  {
    name: "paired TLS 1.3 remains usable",
    peer: CIPHERS.TLS13,
    outcome: "accept",
  },
  {
    name: "configured GCM remains usable",
    peer: CIPHERS.GCM,
    outcome: "accept",
    policy: CIPHERS.GCM.name,
  },
  {
    name: "configured GCM cannot broaden to AES256",
    peer: CIPHERS.GCM256,
    outcome: "reject",
    policy: CIPHERS.GCM.name,
  },
  {
    name: "approved policy: CBC-only fails closed",
    peer: CIPHERS.CBC,
    outcome: "reject",
    policy: CIPHERS.CBC.name,
  },
  {
    name: "approved policy: CBC-only cannot fall back to GCM",
    peer: CIPHERS.GCM,
    outcome: "reject",
    policy: CIPHERS.CBC.name,
  },
  {
    name: "approved policy: CBC-only cannot fall back to TLS 1.3",
    peer: CIPHERS.TLS13,
    outcome: "reject",
    policy: CIPHERS.CBC.name,
  },
  {
    name: "native TLS 1.3-only remains usable",
    peer: CIPHERS.TLS13,
    outcome: "accept",
    policy: CIPHERS.TLS13.name,
  },
  {
    name: "native TLS 1.3-only cannot reopen TLS 1.2",
    peer: CIPHERS.GCM,
    outcome: "reject",
    policy: CIPHERS.TLS13.name,
  },
] as const;
for (const artifact of ["source", "ESM", "minified"]) {
  for (const mode of ["direct", "discovery"]) {
    for (const scenario of scenarios) {
      test(
        `RFC 9325 §4.2 / #102: ${scenario.name} / ${artifact} ${mode}`,
        async () => {
          const peer = Bun.spawn(
            [
              process.env.XMPP_TEST_NODE ?? "node",
              "conformance/fixtures/tls-cbc.mjs",
              certificateDirectory,
              scenario.peer.protocol,
              scenario.peer.name,
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
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                (async () => {
                  while (!pending.includes("\n")) {
                    const { done, value } = await reader.read();
                    expect(done).toBe(false);
                    pending += new TextDecoder().decode(value);
                  }
                  const end = pending.indexOf("\n");
                  const message = JSON.parse(pending.slice(0, end)) as Message;
                  pending = pending.slice(end + 1);
                  return message;
                })(),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("CBC peer response timed out")),
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
            expect(ready.type).toBe("ready");
            expect(ready.node).toMatch(/^v\d+\./);
            expect(Number.isInteger(ready.port) && ready.port > 0).toBe(true);
            expect(ready.probe).toMatchObject({
              accepted: true,
              authorized: true,
              receivedHTTP: true,
              protocol: scenario.peer.protocol,
              cipher: scenario.peer.standard,
              reused: false,
            });
            expect(["X25519", "x25519"]).toContain(ready.probe.key.name);
            expect(ready.records.observerErrors).toEqual([]);
            expect(ready.records.errors).toEqual([]);
            expect(ready.records.connections).toHaveLength(1);
            const control = ready.records.connections[0]!;
            expect(control.clientHello?.ciphers).toContain(scenario.peer.id);
            expect(control.serverHello).toMatchObject({
              cipher: scenario.peer.id,
              compression: 0,
            });
            expect(control.errors).toEqual([]);
            if (scenario.peer === CIPHERS.CBC) {
              expect(negotiatedEtM(control)).toBe(true);
            }
            const result = await exercise(
              artifact,
              mode,
              ready.port,
              "policy" in scenario ? scenario.policy : undefined,
            );
            peer.stdin.write("snapshot\n");
            const snapshot = await receive();
            expect(snapshot.type).toBe("snapshot");
            const records = snapshot.records;
            expect(records.observerErrors).toEqual([]);
            expect(
              records.connections.every(({ errors }) =>
                errors.every((code) => ["ECONNRESET", "EPIPE"].includes(code)),
              ),
            ).toBe(true);
            const sessions = records.sessions.slice(
              ready.records.sessions.length,
            );
            const requests = records.requests.slice(
              ready.records.requests.length,
            );
            const upgrades = records.upgrades;
            if (scenario.outcome === "cbc") {
              const unsafe = sessions.filter(
                ({ id }) =>
                  !negotiatedEtM(
                    records.connections.find(
                      (connection) => connection.id === id,
                    )!,
                  ),
              );
              const unsafeIds = new Set(unsafe.map(({ id }) => id));
              // The baseline must fail here on actual protected HTTP, not on a
              // missing offer, fixture setup, crash, timeout or TLS exception.
              expect(
                [...requests, ...upgrades].filter(({ id }) =>
                  unsafeIds.has(id),
                ),
              ).toEqual([]);
              expect(unsafe).toEqual([]);
            } else {
              expect(result.accepted).toBe(scenario.outcome === "accept");
            }
            if (!result.accepted) {
              expect(requests).toEqual([]);
              expect(upgrades).toEqual([]);
              if (scenario.outcome === "reject") {
                expect(sessions).toEqual([]);
              }
            } else {
              expect(records.errors).toEqual([]);
              expect(sessions.length).toBe(mode === "direct" ? 1 : 2);
              for (const session of sessions) {
                expect(session).toMatchObject({
                  protocol: scenario.peer.protocol,
                  cipher: scenario.peer.standard,
                  reused: false,
                });
                const connection = records.connections.find(
                  ({ id }) => id === session.id,
                )!;
                expect(connection.serverHello).toMatchObject({
                  cipher: scenario.peer.id,
                  compression: 0,
                });
              }
              expect(requests.map(({ path }) => path)).toEqual(
                mode === "direct" ? [] : ["/.well-known/host-meta"],
              );
              expect(
                upgrades.map(({ path, subprotocol }) => ({
                  path,
                  subprotocol,
                })),
              ).toEqual([{ path: "/xmpp", subprotocol: "xmpp" }]);
              if (
                "policy" in scenario &&
                scenario.policy === CIPHERS.GCM.name
              ) {
                for (const connection of records.connections.slice(
                  ready.records.connections.length,
                )) {
                  expect(
                    connection.clientHello?.ciphers.filter(
                      (id) => !["1301", "1302", "1303", "00ff"].includes(id),
                    ),
                  ).toEqual([CIPHERS.GCM.id]);
                }
              }
              if (
                "policy" in scenario &&
                scenario.policy === CIPHERS.TLS13.name
              ) {
                for (const connection of records.connections.slice(
                  ready.records.connections.length,
                )) {
                  const extension = connection.clientHello?.extensions.find(
                    ({ type }) => type === SUPPORTED_VERSIONS,
                  );
                  expect(extension).toBeDefined();
                  const bytes = Buffer.from(extension!.value, "hex");
                  expect(bytes[0]).toBe(bytes.length - 1);
                  expect(bytes.length % 2).toBe(1);
                  const versions = [];
                  for (let index = 1; index < bytes.length; index += 2) {
                    versions.push(bytes.readUInt16BE(index));
                  }
                  expect(versions).toContain(TLS13_VERSION);
                  expect(
                    versions.filter((version) => LEGACY_VERSIONS.has(version)),
                  ).toEqual([]);
                }
              }
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
    for (const [name, policy] of [
      ["defaults", undefined],
      [
        "ALL and both restored SHA256 CBC suites",
        "ALL:ECDHE-RSA-AES128-SHA256:ECDHE-ECDSA-AES128-SHA256",
      ],
    ] as const) {
      test(
        `Approved #102 CBC offer policy: ${name} / ${artifact} ${mode}`,
        async () => {
          const hellos = await observeOffers(async (port) => {
            await exercise(artifact, mode, port, policy);
          });
          for (const hello of hellos) {
            expect(hello.ciphers.filter((id) => CBC_CIPHERS.has(id))).toEqual(
              [],
            );
            expect(hello.ciphers).toContain(CIPHERS.GCM.id);
          }
        },
        PEER_TIMEOUT_MS,
      );
    }
  }
}
