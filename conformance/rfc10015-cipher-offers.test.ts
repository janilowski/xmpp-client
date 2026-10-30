import { beforeAll, describe, expect, test } from "bun:test";
import { ClientHello, parseHello } from "./fixtures/client-hello.mjs";
import {
  OFFER_MODES,
  OFFER_TIMEOUT_MS,
  STATIC_RSA,
  observeOffers,
  validateOfferControls,
  type Hello,
} from "./tls-offers.ts";

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

for (const mode of OFFER_MODES) {
  describe(`RFC 10015 §4: Bun bundle ${mode}`, () => {
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
          import {client} from './dist/index.js';
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
      validateOfferControls(hellos);
    }, OFFER_TIMEOUT_MS);

    const knownFailure = Bun.version === "1.4.4";
    test.failingIf(knownFailure)(
      `offers no static-RSA suites${knownFailure ? " [expected Bun 1.4.4 violation #86]" : ""}`,
      () => {
        expect(
          hellos.map((hello) =>
            hello.ciphers.filter((id) => STATIC_RSA.has(id)),
          ),
        ).toEqual(hellos.map(() => []));
      },
    );
  });
}
