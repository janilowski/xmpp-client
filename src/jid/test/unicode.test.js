import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";
import * as unicode from "../lib/unicode.js";
import { prepareLocal, prepareResource } from "../lib/precis.js";
import jid from "../index.js";

test("fails closed when the runtime lacks Unicode 16 case mapping", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const lower = String.prototype.toLowerCase;
    String.prototype.toLowerCase = function () {
      return String(this) === "\\u1c89" ? "\\u1c89" : lower.call(this);
    };
    const { default: jid } = await import("./src/jid/index.js");
    let rejected = false;
    try { jid("\\u1c89@example.com"); } catch { rejected = true; }
    let alabelRejected = false;
    try { jid("xn--bcher-kva.example"); } catch { alabelRejected = true; }
    console.log(JSON.stringify({ rejected, alabelRejected, ascii: jid("A@example.com").local }));
  `,
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    rejected: true,
    alabelRejected: true,
    ascii: "a",
  });
});

test("rejects Unicode 17 letters before runtime case mapping", () => {
  for (const char of ["\uA7D2", "\uA7D4"]) {
    expect(() => jid(`${char}@example.com`)).toThrow(TypeError);
    expect(() => jid(`${char}.example`)).toThrow(TypeError);
  }
});

for (const [prepare, count, hash] of [
  [
    prepareLocal,
    141273,
    "38c3ca2efac0093ad94b6c5b9763f6b64f4ecf92c28115832b0a5ded2ab8c159",
  ],
  [
    prepareResource,
    154188,
    "032e3e1ddba4e08c96cf400e03ebbd1155339fd1623114777fae6ab2deee985f",
  ],
]) {
  test(`${prepare.name} matches independent single-code-point enforcement`, () => {
    const digest = createHash("sha256");
    let accepted = 0;
    for (let cp = 0; cp < 0x110000; cp++) {
      let value;
      try {
        value = prepare(String.fromCodePoint(cp));
      } catch (error) {
        if (!(error instanceof TypeError)) {
          throw error;
        }
        continue;
      }
      accepted++;
      digest.update(`${cp.toString(16)}:${value}\n`);
    }
    expect(accepted).toBe(count);
    expect(digest.digest("hex")).toBe(hash);
  }, 20000);
}

// Independent oracle: precis-i18n 1.1.2 with unicodedata2 16.0.0.
// IDNA: idna 3.11 (Unicode 16), except U+1CCF0..9, which violate RFC 5892 §2.2.
// These outlined digits have <font> decompositions in UnicodeData.txt.
for (const [name, hash] of [
  [
    "identifier",
    "924f7e4411897a73851fe784639886248c82b66162728654245479f052a21231",
  ],
  [
    "opaque",
    "becddc65ab989728e91931ba6a4a6938057d29e6e1fc20f41a2dad7c4f97285b",
  ],
  ["idna", "cd672ff2f0cf0b04802babfe89711b4433ec13b319117439008ee282149ab270"],
]) {
  test(`${name} matches independent Unicode 16 classification exhaustively`, () => {
    const values = Uint8Array.from({ length: 0x110000 }, (_, cp) => {
      const char = String.fromCodePoint(cp);
      const identifier = unicode.identifier.test(char);
      const valid =
        name === "opaque"
          ? identifier || unicode.freeform.test(char)
          : name === "idna"
            ? identifier && !unicode.idnaDisallowed.test(char)
            : identifier;
      return valid ? 1 : 0;
    });
    expect(createHash("sha256").update(values).digest("hex")).toBe(hash);
  });
}
