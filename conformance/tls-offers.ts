import assert from "node:assert/strict";
import { ClientHello } from "./fixtures/client-hello.mjs";

export const OFFER_TIMEOUT_MS = 10000;
export const OFFER_MODES = ["direct WSS", "HTTPS discovery"] as const;
export type OfferMode = (typeof OFFER_MODES)[number];
export type Hello = NonNullable<ReturnType<ClientHello["feed"]>>;

// RFC 10015 §4 / Table 4, IANA TLS Cipher Suites (reviewed 2026-10-30).
// Independent static-RSA inventory, not all registry entries marked "D".
// https://www.rfc-editor.org/rfc/rfc10015.html#section-5.4
// https://www.iana.org/assignments/tls-parameters/tls-parameters-4.csv
export const STATIC_RSA = new Set([
  "0001",
  "0002",
  "0003",
  "0004",
  "0005",
  "0006",
  "0007",
  "0008",
  "0009",
  "000a",
  "002e",
  "002f",
  "0035",
  "003b",
  "003c",
  "003d",
  "0041",
  "0084",
  "0092",
  "0093",
  "0094",
  "0095",
  "0096",
  "009c",
  "009d",
  "00ac",
  "00ad",
  "00b6",
  "00b7",
  "00b8",
  "00b9",
  "00ba",
  "00c0",
  "c03c",
  "c03d",
  "c050",
  "c051",
  "c068",
  "c069",
  "c06e",
  "c06f",
  "c07a",
  "c07b",
  "c092",
  "c093",
  "c098",
  "c099",
  "c09c",
  "c09d",
  "c0a0",
  "c0a1",
  "ccae",
]);

// Each observation owns a native process and ephemeral port. Fixture assertions
// belong to setup, outside the version-bounded expected conformance failures.
export async function observeOffers(exercise: (port: number) => Promise<void>) {
  const child = Bun.spawn(
    [
      process.env.XMPP_TEST_NODE ?? "node",
      "conformance/fixtures/client-hello-peer.mjs",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: OFFER_TIMEOUT_MS,
    },
  );
  const reader = child.stdout.getReader();
  let pending = "";
  const receive = async () => {
    while (!pending.includes("\n")) {
      const { done, value } = await reader.read();
      assert.equal(
        done,
        false,
        "Native ClientHello observer exited before its response",
      );
      pending += new TextDecoder().decode(value);
    }
    const end = pending.indexOf("\n");
    const message = JSON.parse(pending.slice(0, end));
    pending = pending.slice(end + 1);
    return message;
  };
  try {
    const ready = (await receive()) as { type: string; port: number };
    assert.equal(ready.type, "ready");
    assert.ok(Number.isInteger(ready.port) && ready.port > 0);
    await exercise(ready.port);
    child.stdin.write("snapshot\n");
    const observed = (await receive()) as {
      type: string;
      hellos: string[];
      errors: string[];
    };
    assert.equal(observed.type, "snapshot");
    assert.deepEqual(observed.errors, []);
    assert.ok(observed.hellos.length > 0, "No ClientHello observed");
    return observed.hellos.map((source) => {
      const hello = new ClientHello().feed(Buffer.from(source, "base64"));
      assert.ok(hello, "Incomplete ClientHello snapshot");
      return hello;
    });
  } finally {
    child.stdin.write("stop\n");
    child.stdin.end();
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    assert.equal(exit, 0);
    assert.equal(stderr, "");
  }
}

export function validateOfferControls(hellos: Hello[]) {
  for (const hello of hellos) {
    assert.equal(hello.version, "0303");
    assert.ok(hello.ciphers.includes("c02f"), "Missing ECDHE positive control");
    assert.ok(
      hello.ciphers.includes("1301"),
      "Missing TLS 1.3 positive control",
    );
    const versions = hello.extensions.find(
      (extension) => extension.type === 43,
    );
    assert.ok(versions, "Missing supported_versions");
    const bytes = Buffer.from(versions.value, "hex");
    assert.equal(bytes[0], bytes.length - 1);
    assert.equal(bytes[0] % 2, 0);
    const offered = [];
    for (let index = 1; index < bytes.length; index += 2) {
      offered.push(bytes.subarray(index, index + 2).toString("hex"));
    }
    assert.ok(
      offered.includes("0303"),
      "Missing TLS 1.2 applicability control",
    );
    assert.ok(
      offered.includes("0304"),
      "Missing TLS 1.3 applicability control",
    );
  }
}
