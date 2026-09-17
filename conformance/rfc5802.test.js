/* eslint-disable n/no-unsupported-features/node-builtins */
import { afterEach, expect, spyOn, test } from "bun:test";
import { client } from "../src/client/index.js";

// Independent transcripts: RFC 5802 §5 and RFC 7677 §3, user / pencil.
const vectors = [
  [
    "SCRAM-SHA-1",
    "fyko+d2lbbFgONRv9qkxdawL",
    "r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096",
    "c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,p=v0X8v3Bz2T0CJGbJQyF0X+HI4Ts=",
    "v=rmF9pqV8S7suAoZWja4dJRkFsKQ=",
  ],
  [
    "SCRAM-SHA-256",
    "rOprNGfwEbeRWgbNEkqO",
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
    "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
  ],
];
const credentials = { username: "user", password: "pencil" };
let random;
afterEach(() => random?.mockRestore());

function mechanism(name = "SCRAM-SHA-1", nonce = vectors[0][1]) {
  const entity = client({ domain: "example.test" });
  const mech = entity.saslMechanisms.create(name);
  expect(mech).not.toBeNull();
  random = spyOn(crypto, "getRandomValues").mockImplementation(() =>
    Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0)),
  );
  return mech;
}

test.each(vectors)(
  "RFC 5802 / RFC 4013: %s prepares credentials before hashing",
  async (name, nonce, first, response, final) => {
    const mech = mechanism(name, nonce);
    const unicode = { username: "u\u00adser", password: "\uff50en\u00adcil" };
    expect(await mech.response(unicode)).toBe(`n,,n=user,r=${nonce}`);
    await mech.challenge(first);
    expect(await mech.response(unicode)).toBe(response);
    await mech.final(final);
  },
);

test.each(vectors)(
  "RFC vector %s: client proof and server verification",
  async (name, nonce, first, response, final) => {
    const mech = mechanism(name, nonce);
    expect(await mech.response(credentials)).toBe(`n,,n=user,r=${nonce}`);
    await mech.challenge(first);
    expect(await mech.response(credentials)).toBe(response);
    await expect(mech.final(final)).resolves.toBeUndefined();
  },
);

test.each([
  "r=wrong,s=QQ==,i=4096",
  "r=fyko+d2lbbFgONRv9qkxdawL,s=QQ==,i=4096",
  "r=fyko+d2lbbFgONRv9qkxdawL ,s=QQ==,i=4096",
  "r=fyko+d2lbbFgONRv9qkxdawL\n,s=QQ==,i=4096",
  "r=fyko+d2lbbFgONRv9qkxdawLmore,s=QQ==,i=4096\n",
  "s=QQ==,r=fyko+d2lbbFgONRv9qkxdawLmore,i=4096",
  "m=required,r=fyko+d2lbbFgONRv9qkxdawLmore,s=QQ==,i=4096",
  ...[
    "0",
    "-1",
    "01",
    "1.5",
    "1e4",
    "+4096",
    " 4096",
    "1000001",
    "999999999999999999999",
  ].map((i) => `r=fyko+d2lbbFgONRv9qkxdawLmore,s=QQ==,i=${i}`),
  ...["Q", "QR==", "QQ", " QQ==", "QQ==\n", "QQ-_"].map(
    (s) => `r=fyko+d2lbbFgONRv9qkxdawLmore,s=${s},i=4096`,
  ),
  ...[
    ",r=other",
    ",i=4096",
    ",s=QQ==",
    ",x=a,x=b",
    ",m=required",
    ",xx=a",
    ",x=",
    ",x=\0",
    ",",
  ].map((tail) => vectors[0][2] + tail),
])("RFC 5802 §§5–7: reject malformed server-first %j", async (first) => {
  const mech = mechanism();
  await mech.response(credentials);
  await expect(mech.challenge(first)).rejects.toThrow("SCRAM");
});

test.each([
  "",
  "v=",
  "v=AAAA",
  "v=AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "v=rmF9pqV8S7suAoZWja4dJRkFsKR=",
  "e=invalid-proof",
  vectors[0][4] + ",v=AAAA",
  vectors[0][4] + ",e=invalid-proof",
  "x=first," + vectors[0][4],
  vectors[0][4] + ",m=required",
  vectors[0][4] + ",x=a,x=b",
])(
  "RFC 5802 §5: reject missing, forged or ambiguous server-final %j",
  async (final) => {
    const mech = mechanism();
    await mech.response(credentials);
    await mech.challenge(vectors[0][2]);
    await mech.response(credentials);
    await expect(mech.final(final)).rejects.toThrow("SCRAM");
  },
);

test("RFC 5802 §§5–7: optional extensions are accepted; final may arrive as a challenge", async () => {
  const mech = mechanism();
  await mech.response(credentials);
  await mech.challenge(vectors[0][2]);
  await mech.response(credentials);
  await mech.challenge(vectors[0][4] + ",x=ignored");
  expect(await mech.response(credentials)).toBe("");
  await expect(mech.final("")).resolves.toBeUndefined();
});

test("RFC 5802 §5: early success and out-of-order responses fail", async () => {
  const mech = mechanism();
  await mech.response(credentials);
  await expect(mech.final(vectors[0][4])).rejects.toThrow("SCRAM");
  await expect(mech.response(credentials)).rejects.toThrow("SCRAM");
});

test("RFC 5802 §5: repeated server-first cannot overwrite pending state", async () => {
  const mech = mechanism();
  await mech.response(credentials);
  await mech.challenge(vectors[0][2]);
  await expect(mech.challenge(vectors[0][2])).rejects.toThrow("SCRAM");
  await expect(mech.response(credentials)).rejects.toThrow("SCRAM");
});

test("RFC 3629 / RFC 5802 §7: invalid UTF-8 challenge is rejected", async () => {
  const mech = mechanism();
  await mech.response(credentials);
  await expect(mech.challenge(new Uint8Array([0xc0, 0xaf]))).rejects.toThrow();
});

test("RFC 5802 §7: UTF-8 decoding must not hide an unexpected BOM", async () => {
  const mech = mechanism();
  await mech.response(credentials);
  await expect(
    mech.challenge(new TextEncoder().encode("\uFEFF" + vectors[0][2])),
  ).rejects.toThrow("SCRAM");
});

test("local SCRAM message bound rejects oversized extensions before derivation", async () => {
  const mech = mechanism();
  await mech.response(credentials);
  await expect(
    mech.challenge(vectors[0][2] + ",x=" + "a".repeat(16_384)),
  ).rejects.toThrow("SCRAM: invalid message length");
});

test("RFC 5802 §§2.2, 5.1: ASCII credentials retain case and escape GS2 delimiters", async () => {
  const mech = mechanism();
  expect(
    await mech.response({
      username: "a,=B",
      password: "x",
      authzid: "other,=User",
    }),
  ).toBe("n,a=other=2C=3DUser,n=a=2C=3DB,r=fyko+d2lbbFgONRv9qkxdawL");
});

test.each([
  { username: "", password: "x" },
  { username: "u\0ser", password: "x" },
  { username: "user\n", password: "x" },
  { username: "user", password: "x\n" },
  { username: "user", password: "x", authzid: "other\0user" },
])("SCRAM rejects invalid credentials: %j", async (creds) => {
  await expect(mechanism().response(creds)).rejects.toThrow("SCRAM");
});

test("RFC 5802 §6: no fabricated PLUS support; independent per-exchange nonces", async () => {
  const entity = client({ domain: "example.test" });
  expect(entity.saslMechanisms.names).toEqual([
    "SCRAM-SHA-256",
    "SCRAM-SHA-1",
    "PLAIN",
    "ANONYMOUS",
  ]);
  const a = entity.saslMechanisms.create("SCRAM-SHA-1");
  const b = entity.saslMechanisms.create("SCRAM-SHA-1");
  const first = await a.response(credentials);
  expect(first).toMatch(/^n,,n=user,r=[A-Za-z0-9+/]{24}$/);
  expect(await b.response(credentials)).not.toBe(first);
});
