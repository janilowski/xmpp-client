import {
  UNASSIGNED,
  NOTHING,
  SPACE,
  PROHIBITED,
  RANDAL,
  LCAT,
} from "./unicode.js";

// Unicode NormalizationCorrections.txt: retain the five pre-4.0 mappings.
const CORRECTIONS = new Map([
  ["\u{2f868}", "\u{2136a}"],
  ["\u{2f874}", "\u5f33"],
  ["\u{2f91f}", "\u43ab"],
  ["\u{2f95f}", "\u7aae"],
  ["\u{2f9bf}", "\u4d57"],
]);

// RFC 4013 §§2.1–2.5; RFC 5802 uses query usernames and stored passwords.
export default function saslprep(input, profile) {
  if (typeof input !== "string" || !["query", "stored"].includes(profile)) {
    throw new Error("SCRAM: invalid credential or preparation profile");
  }
  let normalized = "";
  let assigned = "";
  for (const char of input) {
    if (NOTHING.test(char)) {
      continue;
    }
    // Unassigned 3.2 characters are normalization barriers, not modern letters.
    if (UNASSIGNED.test(char)) {
      if (profile === "stored") {
        throw new Error("SCRAM: unassigned password character");
      }
      normalized += assigned.normalize("NFKC") + char;
      assigned = "";
      continue;
    }
    assigned += SPACE.test(char) ? " " : (CORRECTIONS.get(char) ?? char);
  }
  normalized += assigned.normalize("NFKC");
  if (PROHIBITED.test(normalized)) {
    throw new Error("SCRAM: prohibited credential character");
  }
  if (RANDAL.test(normalized)) {
    const chars = [...normalized];
    if (
      LCAT.test(normalized) ||
      !RANDAL.test(chars[0]) ||
      !RANDAL.test(chars.at(-1))
    ) {
      throw new Error("SCRAM: invalid bidirectional credential");
    }
  }
  return normalized;
}
