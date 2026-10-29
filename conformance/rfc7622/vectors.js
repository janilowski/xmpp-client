// RFC 7622 §§3.2–3.4; RFC 8264 §§4.2.2/4.3.2/8.
// Literal contextual oracles: https://www.rfc-editor.org/rfc/rfc5892.html#appendix-A
// Shared by Bun and the actual browser bundle; no production tables generate expectations.
const contexts = [
  ["A.1 virama permits ZWNJ", "क्\u200cष", true],
  ["A.1 joining transparents permit ZWNJ", "بَ\u200cَب", true],
  ["A.1 absent joining context", "a\u200cb", false],
  ["A.1 right-joining letter cannot supply left context", "ا\u200cب", false],
  ["A.2 virama permits ZWJ", "क्\u200dष", true],
  ["A.2 missing virama", "क\u200dष", false],
  [
    "A.2 transparent mark cannot separate virama and ZWJ",
    "क्\u0301\u200dष",
    false,
  ],
  ["A.3 middle dot between l", "l·l", true],
  ["A.3 middle dot lacks l context", "a·b", false],
  ["A.4 keraia before Greek", "͵α", true],
  ["A.4 keraia before Latin", "͵a", false],
  ["A.4 distant Greek cannot supply immediate context", "͵aα", false],
  ["A.5 geresh after Hebrew", "א׳", true],
  ["A.5 geresh before Hebrew", "׳א", false],
  ["A.5 distant Hebrew cannot supply immediate context", "אa׳", false],
  ["A.6 gershayim after Hebrew", "א״", true],
  ["A.6 gershayim before Hebrew", "״א", false],
  ["A.7 Japanese script supplies middle-dot context", "カ・a", true],
  ["A.7 Japanese script need not be adjacent", "カab・cd", true],
  ["A.7 middle dot alone supplies no Japanese script", "a・b", false],
  ["A.8 Arabic-Indic digit", "ب١", true],
  ["A.9 extended Arabic-Indic digit", "ب۱", true],
  ["A.8–A.9 mixed digit sets", "ب١۱", false],
];

export const CONTEXT_VECTORS = contexts.flatMap(([section, value, valid]) =>
  [
    ["localpart", `${value}@example.test`],
    ["resourcepart", `example.test/${value}`],
    ["domainpart", `${value}.example`],
  ].map(([slot, input]) => ({
    section,
    slot,
    input,
    expected: valid ? input : null,
  })),
);

// Mapping precedes contextual checks; OpaqueString deliberately preserves case.
export const MAPPING_VECTORS = [
  {
    section: "RFC 8265 §3.3",
    slot: "localpart",
    input: "L·L@example.test",
    expected: "l·l@example.test",
  },
  {
    section: "RFC 5895 §2",
    slot: "domainpart",
    input: "L·L.example",
    expected: "l·l.example",
  },
  {
    section: "RFC 8265 §4.2",
    slot: "resourcepart",
    input: "example.test/L·L",
    expected: null,
  },
];

// Version-pinned primary oracles, reviewed against UnicodeData.txt:
// https://www.unicode.org/Public/16.0.0/ucd/UnicodeData.txt
// https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt
// U+1C89 lowercases to U+1C8A in Unicode 16. U+A7D2/U+A7D4 first exist in 17.
// Repertoire pinning is project policy, not an RFC mandate to select Unicode 16.
export const VERSION_VECTORS = [
  {
    section: "Unicode 16 case mapping",
    slot: "localpart",
    input: "\u1c89@example.test",
    expected: "\u1c8a@example.test",
  },
  {
    section: "Unicode 16 case mapping",
    slot: "domainpart",
    input: "\u1c89.example",
    expected: "\u1c8a.example",
  },
  {
    section: "Unicode 16 OpaqueString case preservation",
    slot: "resourcepart",
    input: "example.test/\u1c89",
    expected: "example.test/\u1c89",
  },
  ...["\uA7D2", "\uA7D4"].flatMap((value) => [
    {
      section: "Unicode 17 outside selected repertoire",
      slot: "localpart",
      input: `${value}@example.test`,
      expected: null,
    },
    {
      section: "Unicode 17 outside selected repertoire",
      slot: "domainpart",
      input: `${value}.example`,
      expected: null,
    },
    {
      section: "Unicode 17 outside selected repertoire",
      slot: "resourcepart",
      input: `example.test/${value}`,
      expected: null,
    },
  ]),
];
