import { expect, test } from "bun:test";
import jid from "../src/jid/index.js";

// RFC 8753 §6 incorporates verified RFC 5892 erratum 3312: each occurrence
// must satisfy its own context, not merely one occurrence somewhere in a label.
// RFC 8264 §§4.2.2/4.3.2 applies these contextual rules to both PRECIS classes.
// https://www.rfc-editor.org/rfc/rfc8753.html#section-6
// Literal A-labels were encoded independently with Python's Punycode codec;
// validity follows RFC 5892 A.1–A.3, not that codec or production preparation.
const contexts = [
  {
    rule: "A.1 ZWNJ joining context",
    cases: [
      ["both valid", "ب\u200cبب\u200cب", "xn--ngbaaa1524aca", true],
      ["first invalid", "ا\u200cبب\u200cب", "xn--mgbcaa1524aca", false],
      ["last invalid", "ب\u200cبا\u200cب", "xn--mgbbab1524aca", false],
    ],
  },
  {
    rule: "A.2 ZWJ virama context",
    cases: [
      ["both valid", "क्\u200dषक्\u200dष", "xn--11ba5hb1ic9781bda", true],
      ["first invalid", "क\u200dषक्\u200dष", "xn--11ba5hb3i110nda", false],
      ["last invalid", "क्\u200dषक\u200dष", "xn--11ba5hb1i410nca", false],
    ],
  },
  {
    rule: "A.3 middle-dot l context",
    cases: [
      ["both valid", "l·ll·l", "xn--llll-5hac", true],
      ["first invalid", "a·bl·l", "xn--abll-5hac", false],
      ["last invalid", "l·la·b", "xn--llab-5hac", false],
    ],
  },
] as const;

for (const { rule, cases } of contexts) {
  for (const [position, value, alabel, valid] of cases) {
    for (const [slot, input, expected] of [
      ["localpart", `${value}@example.test`, `${value}@example.test`],
      ["resourcepart", `example.test/${value}`, `example.test/${value}`],
      ["U-label domainpart", `${value}.example`, `${value}.example`],
      ["A-label domainpart", `${alabel}.example`, `${value}.example`],
    ]) {
      test(`RFC 8753 §6: every occurrence / ${rule} / ${position} / ${slot}`, () => {
        if (!valid) {
          expect(() => jid(input)).toThrow(TypeError);
          return;
        }
        expect(jid(input).toString()).toBe(expected);
      });
    }
  }
}
