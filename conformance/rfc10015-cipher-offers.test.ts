import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ClientHello, parseHello } from "./fixtures/client-hello.mjs";
import {
  FINITE_FIELD_DH,
  OFFER_MODES,
  OFFER_TIMEOUT_MS,
  STATIC_RSA,
  observeOffers,
  signatureAlgorithms,
  validateOfferControls,
  validateOfferExtensions,
  validateFiniteFieldDHOffers,
  validateSignatureHashes,
  type Hello,
} from "./tls-offers.ts";

const MD5_SIGNATURE_HASH = 1;
const SHA1_SIGNATURE_HASH = 2;
const nativeSignatures = new Map<string, number[]>();

beforeAll(async () => {
  for (const mode of OFFER_MODES) {
    const hellos = await observeOffers(async (port) => {
      // Observe each native API without the application adapter. Its actual
      // strong defaults, not the production constant, are the maintenance oracle.
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        if(${JSON.stringify(mode)} === 'direct WSS') {
          await new Promise((resolve,reject)=>{
            const socket=new WebSocket('wss://localhost:${port}/xmpp', {protocols:['xmpp'],tls:{rejectUnauthorized:true}});
            socket.addEventListener('error',()=>resolve());
            socket.addEventListener('open',()=>{socket.close();reject(Error('Raw observer cannot establish TLS'));});
          });
        } else {
          try {await fetch('https://localhost:${port}/.well-known/host-meta',{tls:{rejectUnauthorized:true}});throw Error('Raw observer cannot establish TLS');}
          catch(error) {if(error.message==='Raw observer cannot establish TLS'){throw error;}}
        }
      `,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: OFFER_TIMEOUT_MS,
          env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "1" },
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exit, stdout, stderr }).toEqual({
        exit: 0,
        stdout: "",
        stderr: "",
      });
    });
    validateOfferControls(hellos);
    validateOfferExtensions(hellos);
    expect(hellos.length).toBeGreaterThan(0);
    const signatures = signatureAlgorithms(hellos[0]);
    for (const hello of hellos) {
      expect(signatureAlgorithms(hello)).toEqual(signatures);
    }
    nativeSignatures.set(mode, signatures);
  }
}, OFFER_TIMEOUT_MS);

// RFC 10015 §4 prohibits offering static-RSA suites, not only negotiating them.
// https://www.rfc-editor.org/rfc/rfc10015.html#section-4
// The raw observer stops before ServerHello: no certificate/negotiation claim.
test("RFC 10015 offer oracle: independent fragmented ClientHello and malformed bounds", () => {
  const body = Buffer.from(
    "0303" + "00".repeat(32) + "00" + "0006" + "009cc02f1301" + "0100" + "0000",
    "hex",
  );
  const header = Buffer.alloc(4);
  header[0] = 1;
  header.writeUIntBE(body.length, 1, 3);
  const handshake = Buffer.concat([header, body]);
  const record = (data: Buffer) =>
    Buffer.concat([
      Buffer.from([22, 3, 1, data.length >> 8, data.length & 255]),
      data,
    ]);
  const source = Buffer.concat([
    record(handshake.subarray(0, 7)),
    record(handshake.subarray(7)),
  ]);
  for (let split = 0; split <= source.length; split++) {
    const reader = new ClientHello();
    const hello =
      reader.feed(source.subarray(0, split)) ??
      reader.feed(source.subarray(split));
    expect(hello?.ciphers).toEqual(["009c", "c02f", "1301"]);
  }
  const reader = new ClientHello();
  let hello: Hello | undefined;
  for (const byte of source) {
    hello = reader.feed(Buffer.from([byte])) ?? hello;
  }
  expect(hello?.ciphers).toEqual(["009c", "c02f", "1301"]);
  expect(hello?.compression).toBe("00");
  // RFC 9155 §2: the independent reader preserves a weak scheme beside SHA-256.
  expect(
    parseHello(
      Buffer.concat([
        body.subarray(0, -2),
        Buffer.from("000a000d0006000404010201", "hex"),
      ]),
    ).extensions,
  ).toEqual([{ type: 13, value: "000404010201" }]);
  // Literal alternatives ensure the observer does not hardcode null support.
  for (const compression of ["01", "0100"]) {
    const alternate = Buffer.concat([
      body.subarray(0, -4),
      Buffer.from([compression.length / 2]),
      Buffer.from(compression, "hex"),
      Buffer.from("0000", "hex"),
    ]);
    expect(parseHello(alternate).compression).toBe(compression);
  }
  expect(new ClientHello().feed(source.subarray(0, -1))).toBeUndefined();
  expect(() =>
    new ClientHello().feed(Buffer.from([22, 3, 1, 255, 255])),
  ).toThrow("Invalid record length");
  const malformed = Buffer.from(body);
  malformed.writeUInt16BE(65534, 35);
  expect(() => parseHello(malformed)).toThrow("Truncated ClientHello field");
  malformed.writeUInt16BE(5, 35);
  expect(() => parseHello(malformed)).toThrow("Invalid cipher vector");
  expect(() =>
    parseHello(
      Buffer.concat([body.subarray(0, -2), Buffer.from("000100", "hex")]),
    ),
  ).toThrow("Truncated extension header");
  expect(STATIC_RSA.size).toBe(52);
  expect(
    ["009c", "009d", "002f", "0035"].every((id) => STATIC_RSA.has(id)),
  ).toBe(true);
  expect(STATIC_RSA.has("c02f")).toBe(false);
  expect(STATIC_RSA.has("1301")).toBe(false);
});

test("RFC 10015 offer oracle: native OpenSSL independently constrained ECDHE control", async () => {
  const hellos = await observeOffers(async (port) => {
    // Only this independent control is constrained, never the tested runtime.
    const child = Bun.spawn(
      [
        "openssl",
        "s_client",
        "-connect",
        `127.0.0.1:${port}`,
        "-tls1_2",
        "-cipher",
        "ECDHE-RSA-AES128-GCM-SHA256",
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: OFFER_TIMEOUT_MS,
      },
    );
    expect(await child.exited).toBe(1);
  });
  expect(hellos).toHaveLength(1);
  // Some OpenSSL versions signal secure renegotiation with SCSV, not an extension.
  expect(hellos[0].ciphers.filter((id) => id !== "00ff")).toEqual(["c02f"]);
});

test("RFC 10015 §§2–3 oracle: complete DH/DHE inventory without banning ECDH or TLS 1.3 groups", () => {
  // Independent RFC table-name/IANA-ID cross-check: 62 + 69 entries, no gaps.
  expect(FINITE_FIELD_DH.size).toBe(131);
  expect(
    createHash("sha256")
      .update([...FINITE_FIELD_DH].toSorted().join(":"))
      .digest("hex"),
  ).toBe("a61f68ff3b2ee7ca7a33b92f66bc879a6149aac145b841e14b750d7ecdbb6038");
  const hello: Hello = {
    version: "0303",
    compression: "00",
    // ECDHE, TLS 1.3, static ECDH, SCSV and GREASE are distinct from FFDH.
    ciphers: ["c02f", "1301", "c02d", "00ff", "0a0a"],
    extensions: [
      { type: 43, value: "0403040303" },
      { type: 10, value: "000401000101" }, // ffdhe2048 and ffdhe3072.
    ],
  };
  expect(() => validateFiniteFieldDHOffers([hello])).not.toThrow();
  expect(() => validateFiniteFieldDHOffers([])).toThrow("No ClientHello");
  // Literal samples cover static/anonymous/DSS/RSA/PSK and legacy/AEAD suites.
  for (const cipher of [
    "000b",
    "0017",
    "00a0",
    "c07e",
    "0011",
    "009e",
    "00aa",
    "c0a6",
    "ccad",
  ]) {
    expect(() =>
      validateFiniteFieldDHOffers([
        hello,
        { ...hello, ciphers: [...hello.ciphers, cipher] },
      ]),
    ).toThrow("Finite-field DH cipher suites are prohibited");
  }
});

for (const mode of OFFER_MODES) {
  for (const artifact of ["source", "ESM", "minified"] as const) {
    for (const policy of [
      "default",
      "ALL",
      "ECDHE-RSA-AES128-GCM-SHA256",
      "TLS_AES_128_GCM_SHA256",
    ]) {
      describe(`RFC 10015 §4: Bun ${artifact} ${mode} / ${policy}`, () => {
        let hellos: Hello[];
        beforeAll(async () => {
          hellos = await observeOffers(async (port) => {
            const service =
              mode === "direct WSS"
                ? `wss://localhost:${port}/xmpp`
                : `localhost:${port}`;
            const child = Bun.spawn(
              [
                process.execPath,
                "--eval",
                `
          const {client}=${
            artifact === "source"
              ? 'await import("./src/client/index.js")'
              : artifact === "ESM"
                ? 'await import("./dist/index.js")'
                : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'
          };
          if(${JSON.stringify(policy)}!=="default") {
            process.getBuiltinModule("node:tls").DEFAULT_CIPHERS=${JSON.stringify(policy)};
          }
          const xmpp=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:2000});
          xmpp.reconnect.stop();xmpp.on('error',()=>{});
          try{await xmpp.connect(xmpp.options.service);throw new Error('Raw observer cannot establish TLS');}
          catch(error){console.log(JSON.stringify({name:error.name,message:error.message}));}
          finally{await xmpp.stop();}
        `,
              ],
              {
                stdout: "pipe",
                stderr: "pipe",
                timeout: OFFER_TIMEOUT_MS,
                env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "1" },
              },
            );
            const [exit, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
            expect(JSON.parse(stdout).name).not.toBe("TimeoutError");
            expect(JSON.parse(stdout).message).not.toBe(
              "Raw observer cannot establish TLS",
            );
          });
          if (policy !== "TLS_AES_128_GCM_SHA256") {
            validateOfferControls(hellos);
          } else {
            for (const hello of hellos) {
              expect(hello.compression).toBe("00");
            }
          }
        }, OFFER_TIMEOUT_MS);

        test("RFC 9325 §§4.2.1/4.5/4.6: safe point-format, SHA-256 and HMAC offers", () => {
          expect(() => validateOfferExtensions(hellos)).not.toThrow();
        });

        // RFC 9155 applies to TLS 1.2, not the TLS-1.3-only policy above.
        if (policy !== "TLS_AES_128_GCM_SHA256") {
          test("RFC 9155 §2: TLS 1.2 offers omit MD5/SHA-1 signature hashes", () => {
            expect(() => validateSignatureHashes(hellos)).not.toThrow();
          });
          test("RFC 10015 §§2–3: TLS 1.2 offers omit finite-field DH/DHE suites", () => {
            expect(() => validateFiniteFieldDHOffers(hellos)).not.toThrow();
          });
        }

        test("local maintenance policy: preserves current native strong signature order", () => {
          const strong = nativeSignatures.get(mode)!.filter((scheme) => {
            const hash = scheme >> 8;
            return hash !== MD5_SIGNATURE_HASH && hash !== SHA1_SIGNATURE_HASH;
          });
          for (const hello of hellos) {
            expect(signatureAlgorithms(hello)).toEqual(strong);
          }
        });

        test("offers no static-RSA suites and preserves the application policy", () => {
          expect(
            hellos.map((hello) =>
              hello.ciphers.filter((id) => STATIC_RSA.has(id)),
            ),
          ).toEqual(hellos.map(() => []));
          for (const hello of hellos) {
            if (policy === "TLS_AES_128_GCM_SHA256") {
              expect(hello.ciphers.toSorted()).toEqual([
                "1301",
                "1302",
                "1303",
              ]);
              expect(
                hello.extensions.find(({ type }) => type === 43)?.value,
              ).toBe("020304");
            } else if (policy === "ECDHE-RSA-AES128-GCM-SHA256") {
              expect(
                hello.ciphers.filter(
                  (id) => !["1301", "1302", "1303"].includes(id),
                ),
              ).toEqual(["c02f"]);
            }
          }
        });
      });
    }
  }
}
