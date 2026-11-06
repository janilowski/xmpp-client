import { expect, test } from "bun:test";
import { validateReport } from "./report.ts";

test.each([
  ["U+0000", "\u0000"],
  ["U+0007", "\u0007"],
  ["U+FFFE", "\uFFFE"],
  ["U+FFFF", "\uFFFF"],
])(
  "JUnit rejects XML 1.0-forbidden characters in names and failure text: %s",
  (_label, value) => {
    expect(() =>
      validateReport(`<testsuite><testcase name="${value}"/></testsuite>`),
    ).toThrow();
    expect(() =>
      validateReport(
        `<testsuite><testcase><failure>${value}</failure></testcase></testsuite>`,
      ),
    ).toThrow();
  },
);

test("JUnit accepts visible labels, failure details and legal Unicode", () => {
  expect(() =>
    validateReport(
      '<testsuite tests="1" failures="1"><testcase name="U+FFFF"><failure message="expected failure">&lt;input&gt; é 🐦 \uFDD0 \u{1FFFF}</failure></testcase></testsuite>',
    ),
  ).not.toThrow();
});

test("JUnit refuses truncated reports rather than counting them as valid", () => {
  expect(() =>
    validateReport('<testsuite><testcase name="incomplete"/>'),
  ).toThrow();
});
