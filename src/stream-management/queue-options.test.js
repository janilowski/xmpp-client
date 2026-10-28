import { expect, test } from "bun:test";
import { client } from "../client/index.js";

// Queue budgets are local policy, not XEP-0198 protocol maxima.
for (const option of ["maxStanzas", "maxBytes"]) {
  test.each([
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
  ])(`reject invalid SM ${option} before connecting / %j`, (value) => {
    expect(() => client({ streamManagement: { [option]: value } })).toThrow(
      RangeError,
    );
  });
}

test("SM stanza capacity cannot hide a complete h counter cycle", () => {
  expect(() => client({ streamManagement: { maxStanzas: 2 ** 32 } })).toThrow(
    RangeError,
  );
});

test.each([null, false, 1, "queue", []].map((value) => [value]))(
  "reject invalid SM configuration / %j",
  (streamManagement) => {
    expect(() => client({ streamManagement })).toThrow(TypeError);
  },
);

test.each([undefined, {}, { maxStanzas: 1 }, { maxBytes: 1 }])(
  "accept omitted and positive SM budgets / %j",
  (streamManagement) => {
    expect(() => client({ streamManagement })).not.toThrow();
  },
);
