import { expect, test } from "bun:test";
import jid from "../src/jid/index.js";

// RFC 8265 §3.3.1(3) prefers Unicode toLowerCase; RFC 5895 §2(1), selected
// by verified RFC 7622 erratum 4534, describes Unicode domain case mapping.
// These test the project's selected whole-string mapping, not a claim that
// RFC 8265 universally mandates this particular lowercasing operation.
// Unicode 16 SpecialCasing.txt: 03A3 maps to 03C2 in Final_Sigma context.
// Literal outputs were checked independently with Python Unicode 16.0.0.
// https://www.unicode.org/Public/16.0.0/ucd/SpecialCasing.txt
// https://www.rfc-editor.org/rfc/rfc8265.html#section-3.3.1
// https://www.rfc-editor.org/rfc/rfc5895.html#section-2
const vectors = [
  ["no preceding cased character", "Σ", "σ", "Σ"],
  ["final Sigma", "ΟΣ", "ος", "ΟΣ"],
  ["non-final Sigma", "ΟΣΑ", "οσα", "ΟΣΑ"],
  [
    "final through following case-ignorable mark",
    "ΟΣ\u0301",
    "ος\u0301",
    "ΟΣ\u0301",
  ],
  [
    "non-final through case-ignorable mark",
    "ΟΣ\u0301Α",
    "οσ\u0301α",
    "ΟΣ\u0301Α",
  ],
  [
    "final through preceding case-ignorable mark and NFC",
    "Ο\u0301Σ",
    "ός",
    "ΌΣ",
  ],
] as const;

for (const [name, input, mapped, resource] of vectors) {
  test(`RFC 8265 §3.3.1 selected case mapping: ${name} / localpart`, () => {
    expect(jid(`${input}@example.test`).toString()).toBe(
      `${mapped}@example.test`,
    );
  });

  test(`RFC 5895 §2 selected case mapping: ${name} / domainpart`, () => {
    expect(jid(input).toString()).toBe(mapped);
  });

  test(`RFC 8265 §4.2.2: preserve resource case / ${name}`, () => {
    expect(jid(`example.test/${input}`).toString()).toBe(
      `example.test/${resource}`,
    );
  });
}

// Unicode Final_Sigma ignores case-ignorable FULL STOP. Domain mapping acts
// on the entire domain before splitting labels, not on each label separately.
for (const [input, expected] of [
  ["ΟΣ.Α", "οσ.α"],
  ["ΟΣ.example", "οσ.example"],
  ["ΟΣ.1", "ος.1"],
  // RFC 7622 §3.2 removes the final DNS dot before other canonicalization.
  ["ΟΣ.", "ος"],
]) {
  test(`RFC 5895 §2 ordered whole-domain case mapping / ${input}`, () => {
    expect(jid(input).toString()).toBe(expected);
  });
}

for (const [slot, input, equivalent, distinct] of [
  ["localpart", "ΟΣ@example.test", "ος@example.test", "οσ@example.test"],
  ["domainpart", "ΟΣ", "ος", "οσ"],
  [
    "NFC localpart",
    "Ο\u0301Σ@example.test",
    "ός@example.test",
    "όσ@example.test",
  ],
]) {
  test(`RFC 7622 §§3.2.3/3.3 / RFC 8265 §3.3.4: prepared comparison / ${slot}`, () => {
    expect(jid(input).equals(jid(equivalent))).toBe(true);
    expect(jid(input).equals(jid(distinct))).toBe(false);
  });
}

test("RFC 8265 §4.2.3: resource comparison normalizes without case folding", () => {
  expect(jid("example.test/Ο\u0301Σ").equals(jid("example.test/ΌΣ"))).toBe(
    true,
  );
  expect(jid("example.test/ΟΣ").equals(jid("example.test/ος"))).toBe(false);
});
