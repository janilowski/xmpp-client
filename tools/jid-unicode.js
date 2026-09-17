// Regenerate with: bun tools/jid-unicode.js /path/to/unpacked/Unicode-16.0.0-UCD
// Source: https://www.unicode.org/Public/16.0.0/ucd/UCD.zip
// Archive SHA-256: c86dd81f2b14a43b0cc064aa5f89aa7241386801e35c59c7984e579832634eb2
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { format } from "prettier";
import { decodeRanges, RANGE_ALPHABET } from "../src/util/unicode-ranges.js";

const directory = process.argv[2];
const UNICODE_END = 0x110000;
const properties = new Map();
const hashes = {
  "CaseFolding.txt":
    "6f1f9c588eb4a5c718d9e8f93b782685e5c7fec872cf05e8e6878053599e09bb",
  "DerivedCoreProperties.txt":
    "39d35161f2954497f69e08bdb9e701493f476a3d30222de20028feda36c1dabd",
  "HangulSyllableType.txt":
    "329612f2aea8672379d93202ca6fcd948b4f08062d4fc43ee31c7061c66ed279",
  "Blocks.txt":
    "f3907b395d410f1b97342292ca6bc83dd12eb4b205f2a0c48efdef99e517d7b0",
  "PropList.txt":
    "53d614508e2a0b2305a8aa21cd60d993de9326cdf65993660dfcce4503548583",
  "Scripts.txt":
    "9e88f0a677df47311106340be8ede2ecdacd9c1c931831218d2be6d5508e0039",
  "extracted/DerivedGeneralCategory.txt":
    "7676ab755a41ef82108460238569e60ad65c191ddafe61b36c6765ec1353f293",
  "extracted/DerivedBidiClass.txt":
    "71ed943a49c58568d8d92e80ecc2ba2f06e62aee9c8ebb0e6e8bd2c3ed8b180e",
  "extracted/DerivedCombiningClass.txt":
    "52064d588c98c623b2373905e6a449eb520f900113954bcd212e94ef0810b471",
  "extracted/DerivedDecompositionType.txt":
    "29f8bff31296bab424e8d728e2a3c0a3240c5a67dadf47fa7092ec0585ad91b6",
  "extracted/DerivedJoiningType.txt":
    "6bd08b97da66b70ccfdab105a352de2984e02625239ec5695422c99b33d854f0",
};
if (String.fromCodePoint(0x1ccf0).normalize("NFKC") !== "0") {
  throw new Error(
    "Generation requires a runtime with Unicode 16 normalization.",
  );
}

function records(file) {
  const source = readFileSync(join(directory, file), "utf8");
  if (createHash("sha256").update(source).digest("hex") !== hashes[file]) {
    throw new Error(`Unicode source checksum mismatch: ${file}`);
  }
  return source
    .split(/\r?\n/)
    .map((line) => line.split("#")[0].trim())
    .filter(Boolean)
    .map((line) => line.split(";").map((field) => field.trim()));
}

function property(file, name) {
  const key = `${file}:${name}`;
  if (!properties.has(key)) {
    const values = new Uint8Array(UNICODE_END);
    for (const [range, value] of records(file)) {
      if (value !== name) {
        continue;
      }
      const [start, end = start] = range
        .split("..")
        .map((x) => Number.parseInt(x, 16));
      values.fill(1, start, end + 1);
    }
    properties.set(key, values);
  }
  return properties.get(key);
}

function union(file, names) {
  const result = new Uint8Array(UNICODE_END);
  for (const name of names) {
    const source = property(file, name);
    for (let cp = 0; cp < UNICODE_END; cp++) {
      result[cp] |= source[cp];
    }
  }
  return result;
}

const gc = "extracted/DerivedGeneralCategory.txt";
const letterDigits = union(gc, ["Ll", "Lu", "Lo", "Nd", "Lm", "Mn", "Mc"]);
const freeform = union(gc, [
  "Lt",
  "Nl",
  "No",
  "Me",
  "Zs",
  "Sm",
  "Sc",
  "Sk",
  "So",
  "Pc",
  "Pd",
  "Ps",
  "Pe",
  "Pi",
  "Pf",
  "Po",
]);
const unassigned = property(gc, "Cn");
const controls = property(gc, "Cc");
const ignorable = property(
  "DerivedCoreProperties.txt",
  "Default_Ignorable_Code_Point",
);
const noncharacter = property("PropList.txt", "Noncharacter_Code_Point");
const whitespace = property("PropList.txt", "White_Space");
const oldHangul = union("HangulSyllableType.txt", ["L", "V", "T"]);
const ignorableBlocks = union("Blocks.txt", [
  "Combining Diacritical Marks for Symbols",
  "Musical Symbols",
  "Ancient Greek Musical Notation",
]);
const casefold = new Map();
for (const [cp, status, mapping] of records("CaseFolding.txt")) {
  if (status === "C" || status === "F") {
    casefold.set(
      Number.parseInt(cp, 16),
      String.fromCodePoint(
        ...mapping.split(" ").map((x) => Number.parseInt(x, 16)),
      ),
    );
  }
}

// RFC 5892 §2.6 exceptions also apply to PRECIS (RFC 8264 §9.6).
const exceptions = new Map();
for (const cp of [0xdf, 0x3c2, 0x6fd, 0x6fe, 0xf0b, 0x3007]) {
  exceptions.set(cp, "valid");
}
for (const cp of [
  0xb7,
  0x375,
  0x5f3,
  0x5f4,
  0x30fb,
  ...Array.from({ length: 10 }, (_, i) => 0x660 + i),
  ...Array.from({ length: 10 }, (_, i) => 0x6f0 + i),
]) {
  exceptions.set(cp, "context");
}
for (const cp of [
  0x640, 0x7fa, 0x302e, 0x302f, 0x3031, 0x3032, 0x3033, 0x3034, 0x3035, 0x303b,
]) {
  exceptions.set(cp, "disallowed");
}

const identifier = new Uint8Array(UNICODE_END);
const opaque = new Uint8Array(UNICODE_END);
const idna = new Uint8Array(UNICODE_END);
for (let cp = 0; cp < UNICODE_END; cp++) {
  const exception = exceptions.get(cp);
  if (exception) {
    identifier[cp] = opaque[cp] = idna[cp] = exception === "valid" ? 1 : 0;
    continue;
  }
  if (unassigned[cp]) {
    continue;
  }
  const char = String.fromCodePoint(cp);
  const normalized = char.normalize("NFKC");
  // RFC 8264 §8: preserve the normative order, especially ASCII before controls.
  if (cp >= 0x21 && cp <= 0x7e) {
    identifier[cp] = opaque[cp] = 1;
  } else if (
    !oldHangul[cp] &&
    !ignorable[cp] &&
    !noncharacter[cp] &&
    !controls[cp]
  ) {
    identifier[cp] = normalized === char && letterDigits[cp] ? 1 : 0;
    opaque[cp] =
      normalized !== char || letterDigits[cp] || freeform[cp] ? 1 : 0;
  }
  // RFC 5892 §3: IDNA uses case folding only to derive validity, never to map JIDs.
  const folded = [...normalized]
    .map((c) => casefold.get(c.codePointAt(0)) ?? c)
    .join("")
    .normalize("NFKC");
  if (cp === 0x2d || (cp >= 0x30 && cp <= 0x39) || (cp >= 0x61 && cp <= 0x7a)) {
    idna[cp] = 1;
  } else if (
    folded === char &&
    !ignorable[cp] &&
    !whitespace[cp] &&
    !noncharacter[cp] &&
    !ignorableBlocks[cp] &&
    !oldHangul[cp] &&
    letterDigits[cp]
  ) {
    idna[cp] = 1;
  }
}

const tables = {
  identifier,
  unassigned,
  freeform: opaque.map((value, cp) => (value && !identifier[cp] ? 1 : 0)),
  idnaDisallowed: identifier.map((value, cp) => (value && !idna[cp] ? 1 : 0)),
};
// All IDNA PVALID code points are IdentifierClass PVALID; store only the difference.
if (idna.some((value, cp) => value && !identifier[cp])) {
  throw new Error("IDNA repertoire is no longer a subset of IdentifierClass.");
}
for (const [name, file, values] of [
  ["width", "extracted/DerivedDecompositionType.txt", ["Wide", "Narrow"]],
  ["space", gc, ["Zs"]],
  ["mark", gc, ["Mn", "Mc", "Me"]],
  ["virama", "extracted/DerivedCombiningClass.txt", ["9"]],
  ["greek", "Scripts.txt", ["Greek"]],
  ["hebrew", "Scripts.txt", ["Hebrew"]],
  ["japanese", "Scripts.txt", ["Hiragana", "Katakana", "Han"]],
  ["joinLeft", "extracted/DerivedJoiningType.txt", ["L", "D"]],
  ["joinRight", "extracted/DerivedJoiningType.txt", ["R", "D"]],
  ["joinTransparent", "extracted/DerivedJoiningType.txt", ["T"]],
  ["rtl", "extracted/DerivedBidiClass.txt", ["R", "AL", "AN"]],
  ["rtlStart", "extracted/DerivedBidiClass.txt", ["R", "AL"]],
  ["ltrStart", "extracted/DerivedBidiClass.txt", ["L"]],
  ["nsm", "extracted/DerivedBidiClass.txt", ["NSM"]],
  ["en", "extracted/DerivedBidiClass.txt", ["EN"]],
  ["an", "extracted/DerivedBidiClass.txt", ["AN"]],
]) {
  tables[name] = union(file, values);
}
const bidi = union("extracted/DerivedBidiClass.txt", [
  "L",
  "R",
  "AL",
  "AN",
  "EN",
  "ES",
  "CS",
  "ET",
  "ON",
  "BN",
  "NSM",
]);
if (
  identifier.some(
    (value, cp) =>
      (value ||
        exceptions.get(cp) === "context" ||
        cp === 0x200c ||
        cp === 0x200d) &&
      !bidi[cp],
  )
) {
  throw new Error("Identifier repertoire contains an unsupported bidi class.");
}
// Store each property independently as (gap, length) pairs.
const PAYLOAD_BITS = 5;
const CONTINUATION = 1 << PAYLOAD_BITS;
let exports = "";
for (const [name, values] of Object.entries(tables).sort(([a], [b]) =>
  a < b ? -1 : a > b ? 1 : 0,
)) {
  let packed = "";
  let previousEnd = 0;
  for (let cp = 0; cp < UNICODE_END; cp++) {
    if (!values[cp]) {
      continue;
    }
    const start = cp;
    while (cp + 1 < UNICODE_END && values[cp + 1]) {
      cp++;
    }
    for (let value of [start - previousEnd, cp - start + 1]) {
      while (value >= CONTINUATION) {
        packed += RANGE_ALPHABET[(value & (CONTINUATION - 1)) | CONTINUATION];
        value >>>= PAYLOAD_BITS;
      }
      packed += RANGE_ALPHABET[value];
    }
    previousEnd = cp + 1;
  }
  // Refuse to write unless decoding preserves every UCD-derived property.
  const decoded = decodeRanges(packed);
  for (let cp = 0; cp < UNICODE_END; cp++) {
    if (Number(decoded.test(String.fromCodePoint(cp))) !== values[cp]) {
      throw new Error(
        `Unicode table round-trip failed: ${name} U+${cp.toString(16)}`,
      );
    }
  }
  exports += `export const ${name} = decodeRanges(${JSON.stringify(packed)});\n`;
}
const output = await format(
  "// Generated by tools/jid-unicode.js from Unicode 16.0.0; do not edit.\n" +
    "// Unicode data license: https://www.unicode.org/license.txt\n" +
    'import { decodeRanges } from "../../util/unicode-ranges.js";\n' +
    exports,
  { parser: "babel" },
);
const target = "src/jid/lib/unicode.js";
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) {
    throw new Error("Generated JID Unicode tables are stale.");
  }
} else {
  writeFileSync(target, output);
}
