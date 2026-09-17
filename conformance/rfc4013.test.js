import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { createHash } from "node:crypto";
import saslprep from "../src/sasl-scram/saslprep.js";

test("RFC 5802 §5.1: authentication username is not a preauthenticated JID", () => {
  let entity;
  expect(() => {
    entity = client({
      domain: "example.test",
      username: "u\u00adser",
      password: "pencil",
    });
  }).not.toThrow();
  expect(entity.jid).toBeNull();
});

// RFC 4013 §3 examples, RFC 5802 §5.1 query-string usernames.
const initial = (username, password = "pencil") =>
  client({ domain: "example.test" })
    .saslMechanisms.create("SCRAM-SHA-1")
    .response({ username, password });

test.each([
  ["I\u00adX", "IX"],
  ["USER", "USER"],
  ["\u00aa", "a"],
  ["\u2168", "IX"],
  ["a\u00a0b", "a b"],
  ["a\u200bb", "ab"],
  ["e\u0301", "é"],
  ["\u0627\u0031\u0628", "\u0627\u0031\u0628"],
  ["\u0221", "\u0221"], // Unassigned in 3.2, permitted in queries.
  ["\u{1d2c}", "\u{1d2c}"], // Must not acquire a modern NFKC mapping.
  ["\u{2f868}", "\u{2136a}"], // Pre-Unicode-4 normalization correction.
  ["a\u0353\u0301", "a\u0353\u0301"], // Unassigned 3.2 marks have ccc=0.
])("RFC 4013 mapping/normalization: %j → %j", async (input, expected) => {
  expect(await initial(input)).toStartWith(`n,,n=${expected},r=`);
});

test.each([
  "",
  "\u00ad",
  "\u0007",
  "\ue000",
  "\uffff",
  "\ud800",
  "\ufff9",
  "\u2ff0",
  "\u202e",
  "\u{e0001}",
  "\u0627a\u0628",
  "\u0627\u0031",
])("RFC 4013 prohibited output / bidi / empty username: %j", async (input) => {
  await expect(initial(input)).rejects.toThrow();
});

test.each([
  "\u0221",
  "\u{1d2c}",
  "\u0007",
  "\ue000",
  "\ud800",
  "\u0627a\u0628",
])(
  "RFC 5802 §2.2 stored password rejects prohibited/unassigned: %j",
  async (password) => {
    await expect(initial("user", password)).rejects.toThrow();
  },
);

// Independent CPython stringprep + ucd_3_2_0 oracle, not production output.
// Reproduce with python3 tools/saslprep-data.py --oracle.
test.each([
  [
    "query",
    false,
    "0180346029bc9e8be53016e23b80a6aa7248daf60e9722786ec520564a003bcb",
  ],
  [
    "query",
    true,
    "29f6a4123e150f2d0587565c4830dc7d6061a87f7838bf6176ff9ceadd9c5903",
  ],
  [
    "stored",
    false,
    "43e9d05c53332cae63d472f2a7a4c001dfdcb6ff682d4288669643903639c33f",
  ],
  [
    "stored",
    true,
    "cadbaa681ed6f6ec32e21c90b5b53b347bbed55fb347a2049cbfa8a85a413f1c",
  ],
])(
  "Unicode 3.2 exhaustive oracle: %s contextual=%s",
  (profile, contextual, expected) => {
    const digest = createHash("sha256");
    for (let point = 0; point < 0x110000; point++) {
      const char = String.fromCodePoint(point);
      let result;
      try {
        result = saslprep(contextual ? `a${char}\u0301` : char, profile);
      } catch {
        result = "!";
      }
      digest.update(`${point}:${result}\n`);
    }
    expect(digest.digest("hex")).toBe(expected);
  },
  20_000,
);
