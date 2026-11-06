import { expect, test } from "bun:test";
import {
  validateOfferExtensions,
  validateSignatureHashes,
  type Hello,
} from "./tls-offers.ts";

const CHILD_TIMEOUT_MS = 5000;
const OBSERVER_ERROR = "Native ClientHello observer exited before its response";

// Independent literal vectors, not values produced by the TLS runtime or
// validator. EC point formats are optional; SHA-256 has several valid schemes.
test.each([
  ["PKCS1 SHA-256", "00020401"],
  ["ECDSA SHA-256", "00020403"],
  ["Brainpool ECDSA SHA-256", "0002081a"],
  ["PSS RSAE SHA-256", "00020804"],
  ["PSS PSS SHA-256", "00020809"],
  ["unknown and stronger alternatives", "00060a0a08050403"],
] as const)("RFC 9325 offer oracle accepts %s", (_name, value) => {
  const hello: Hello = {
    version: "0303",
    ciphers: ["c02f", "1301"],
    compression: "00",
    extensions: [{ type: 13, value }],
  };
  expect(() => validateOfferExtensions([hello])).not.toThrow();
  hello.extensions.push({ type: 11, value: "0100" });
  expect(() => validateOfferExtensions([hello])).not.toThrow();
});

test.each([
  ["compressed points", [{ type: 11, value: "0101" }], "uncompressed"],
  ["extra point format", [{ type: 11, value: "020001" }], "uncompressed"],
  ["empty point list", [{ type: 11, value: "00" }], "uncompressed"],
  ["bad point list length", [{ type: 11, value: "0200" }], "uncompressed"],
  [
    "duplicate point formats",
    [
      { type: 11, value: "0100" },
      { type: 11, value: "0100" },
    ],
    "Duplicate ec_point_formats",
  ],
  ["truncated HMAC", [{ type: 4, value: "" }], "Truncated HMAC"],
] as const)("RFC 9325 offer oracle rejects %s", (_name, extensions, error) => {
  const hello: Hello = {
    version: "0303",
    ciphers: ["c02f", "1301"],
    compression: "00",
    extensions: [{ type: 13, value: "00020401" }, ...extensions],
  };
  expect(() => validateOfferExtensions([hello])).toThrow(error);
});

test.each([
  ["absent algorithms", [], "Missing or duplicate"],
  [
    "duplicate algorithms",
    [
      { type: 13, value: "00020401" },
      { type: 13, value: "00020401" },
    ],
    "Missing or duplicate",
  ],
  ["empty algorithms", [{ type: 13, value: "0000" }], "Empty or truncated"],
  ["truncated length", [{ type: 13, value: "00" }], "Empty or truncated"],
  ["truncated vector", [{ type: 13, value: "00040401" }], "vector length"],
  [
    "trailing vector bytes",
    [{ type: 13, value: "000204010805" }],
    "vector length",
  ],
  ["partial scheme", [{ type: 13, value: "0003040108" }], "Partial signature"],
  ["no SHA-256", [{ type: 13, value: "000408050603" }], "Missing SHA-256"],
  [
    "SHA-256 only in length bytes",
    [{ type: 13, value: "0401" }],
    "Empty or truncated",
  ],
  [
    "SHA-256 split across schemes",
    [{ type: 13, value: "000406040108" }],
    "Missing SHA-256",
  ],
] as const)(
  "RFC 9325 signature oracle rejects %s",
  (_name, extensions, error) => {
    const hello: Hello = {
      version: "0303",
      ciphers: ["c02f", "1301"],
      compression: "00",
      extensions: [...extensions],
    };
    expect(() => validateOfferExtensions([hello])).toThrow(error);
    if (error !== "Missing SHA-256") {
      expect(() => validateSignatureHashes([hello])).toThrow(error);
    }
  },
);

test("RFC 9325 offer oracle rejects an empty observation", () => {
  expect(() => validateOfferExtensions([])).toThrow("No ClientHello");
});

// RFC 9155 §2 forbids weak signature hashes even beside a SHA-256 scheme.
// These literal TLS 1.2 pairs are independent of runtime offers and the guard.
test.each([
  ["RSA MD5", "0101"],
  ["RSA SHA-1", "0201"],
  ["DSA SHA-1", "0202"],
  ["ECDSA SHA-1", "0203"],
] as const)(
  "RFC 9155 §2 offer oracle rejects %s beside SHA-256",
  (_name, weak) => {
    for (const schemes of [`0401${weak}`, `${weak}0401`]) {
      const hello: Hello = {
        version: "0303",
        ciphers: ["c02f", "1301"],
        compression: "00",
        extensions: [{ type: 13, value: `0004${schemes}` }],
      };
      expect(() => validateSignatureHashes([hello])).toThrow("MD5/SHA-1");
    }
  },
);

test("RFC 9155 §2 offer oracle preserves strong/unknown schemes and SHA-1 HMAC", () => {
  const hello: Hello = {
    version: "0303",
    // SHA-1 record HMAC is distinct from a SHA-1 handshake signature.
    ciphers: ["c013", "c02f", "1301"],
    compression: "00",
    extensions: [{ type: 13, value: "00080401080508070a0a" }],
  };
  expect(() => validateSignatureHashes([hello])).not.toThrow();
});

test("RFC 9155 §2 offer oracle checks every observed ClientHello", () => {
  const hello: Hello = {
    version: "0303",
    ciphers: ["c02f", "1301"],
    compression: "00",
    extensions: [{ type: 13, value: "00020401" }],
  };
  const weak = {
    ...hello,
    extensions: [{ type: 13, value: "000404010201" }],
  };
  expect(() => validateSignatureHashes([hello, weak])).toThrow("MD5/SHA-1");
});

test("RFC 9155 §2 offer oracle rejects an empty observation", () => {
  expect(() => validateSignatureHashes([])).toThrow("No ClientHello");
});

// Harness controls, not RFC requirements: failures must retain their cause,
// reap their observer and release its reader without weakening successful runs.
test.each(["startup", "exercise", "exit", "stderr", "valid"] as const)(
  "ClientHello observer cleanup / %s",
  async (scenario) => {
    const observer = `
      import {createInterface} from 'node:readline';
      console.log(JSON.stringify({type:'ready',port:1}));
      for await (const line of createInterface({input:process.stdin})) {
        if(line==='snapshot') {
          const body=Buffer.from('0303'+'00'.repeat(32)+'00'+'0002c02f'+'0100'+'0000','hex');
          const handshake=Buffer.concat([Buffer.from([1,0,0,body.length]),body]);
          const record=Buffer.concat([Buffer.from([22,3,1,0,handshake.length]),handshake]);
          console.log(JSON.stringify({type:'snapshot',hellos:[record.toString('base64')],errors:[]}));
        }
        if(line==='stop') {
          ${scenario === "exercise" || scenario === "stderr" ? "console.error('observer cleanup diagnostic');" : ""}
          process.exit(${scenario === "exercise" || scenario === "exit" ? 7 : 0});
        }
      }
    `;
    const source = `
      import {observeOffers} from './conformance/tls-offers.ts';
      const spawn=Bun.spawn;
      let peer;
      Bun.spawn=(args,options)=>peer=spawn(${scenario === "startup" ? "args" : JSON.stringify([process.execPath, "--eval", observer])},options);
      const unhandled=[];
      process.on('unhandledRejection',error=>unhandled.push(String(error)));
      let result;
      try {
        const hellos=await observeOffers(async()=>{${scenario === "exercise" ? "throw new Error('exercise failed');" : ""}});
        result={ciphers:hellos.map(hello=>hello.ciphers)};
      } catch(error) {
        result={error:String(error),code:error.code};
      }
      const exit=await peer.exited;
      await new Promise(resolve=>setImmediate(resolve));
      console.log(JSON.stringify({result,exit,locked:peer.stdout.locked,unhandled}));
    `;
    const child = Bun.spawn([process.execPath, "--eval", source], {
      env: { ...process.env, XMPP_TEST_NODE: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const observed = JSON.parse(stdout);
    if (scenario === "startup") {
      expect(observed.result.error).toContain(OBSERVER_ERROR);
      expect(observed.result.code).not.toBe("EPIPE");
    } else if (scenario === "exercise") {
      expect(observed.result.error).toBe("Error: exercise failed");
    } else if (scenario === "valid") {
      expect(observed.result).toEqual({ ciphers: [["c02f"]] });
    } else {
      expect(observed.result.error).toContain("AssertionError");
      expect(observed.result.error).toContain(
        scenario === "exit" ? "7" : "observer cleanup diagnostic",
      );
    }
    expect(observed.exit).toBeNumber();
    expect(observed.locked).toBe(false);
    expect(observed.unhandled).toEqual([]);
  },
  CHILD_TIMEOUT_MS * 2,
);
