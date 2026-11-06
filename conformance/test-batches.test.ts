import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSuites, groupSuites, runBatch } from "./test-batches.ts";

test("runner treats an invalid report as failure without changing child status or bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmpp-report-status-"));
  try {
    const report = join(directory, "tests.xml");
    const invalid = '<testsuite><testcase name="\uFFFF"/></testsuite>';
    await writeFile(report, invalid);
    const command = [process.execPath, "--eval", "process.exitCode = 0"];
    const result = runBatch(command, report);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.reportError).toBeString();
    expect(await readFile(report, "utf8")).toBe(invalid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner rejects malformed UTF-8 without replacing report bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmpp-report-encoding-"));
  try {
    const report = join(directory, "tests.xml");
    const invalid = Buffer.concat([
      Buffer.from('<testsuite><testcase name="'),
      Buffer.from([0xff]),
      Buffer.from('"/></testsuite>'),
    ]);
    await writeFile(report, invalid);
    const result = runBatch(
      [process.execPath, "--eval", "process.exitCode = 0"],
      report,
    );
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.reportError).toBeString();
    expect(await readFile(report)).toEqual(invalid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner retains failure status with a valid report and refuses missing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmpp-report-failure-"));
  try {
    const report = join(directory, "tests.xml");
    await writeFile(
      report,
      '<testsuite tests="1" failures="1"><testcase name="case"><failure>failed</failure></testcase></testsuite>',
    );
    const failed = runBatch(
      [process.execPath, "--eval", "process.exitCode = 1"],
      report,
    );
    expect(failed.passed).toBe(false);
    expect(failed.exitCode).toBe(1);
    expect(failed.reportError).toBeUndefined();
    const missing = runBatch(
      [process.execPath, "--eval", "process.exitCode = 0"],
      join(directory, "missing.xml"),
    );
    expect(missing.passed).toBe(false);
    expect(missing.exitCode).toBe(0);
    expect(missing.reportError).toBeString();
    await writeFile(
      report,
      '<testsuite tests="1" failures="0"><testcase name="case"/></testsuite>',
    );
    const passed = runBatch(
      [process.execPath, "--eval", "process.exitCode = 0"],
      report,
    );
    expect(passed.passed).toBe(true);
    expect(passed.exitCode).toBe(0);
    expect(passed.reportError).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner discovers all Bun filename forms but not drafts or directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmpp-suite-discovery-"));
  try {
    const nested = join(directory, "nested");
    await mkdir(nested);
    const names = [];
    for (const suffix of [".test", "_test", ".spec", "_spec"]) {
      for (const extension of [
        "js",
        "jsx",
        "ts",
        "tsx",
        "mjs",
        "cjs",
        "mts",
        "cts",
      ]) {
        names.push(join(nested, `case${suffix}.${extension}`));
      }
    }
    await Promise.all([
      ...names.map((path) => writeFile(path, "")),
      writeFile(join(directory, "draft.test.ts.work"), ""),
      writeFile(join(directory, "helper.ts"), ""),
      mkdir(join(directory, "not-a-file.test.ts")),
    ]);
    expect(discoverSuites(directory)).toEqual(names.sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner refuses an empty conformance tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmpp-empty-suites-"));
  try {
    expect(() => discoverSuites(directory)).toThrow(
      "No conformance suites found",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner groups standards without losing transport and harness suites", () => {
  expect([
    ...groupSuites([
      "./conformance/xep0198-queue.test.ts",
      "./src/websocket/test/frames.test.js",
      "./conformance/rfc6120-streams.test.ts",
      "./conformance/rfc7622/contexts.test.ts",
      "./conformance/harness.test.ts",
      "./conformance/rfc6120.test.ts",
    ]),
  ]).toEqual([
    [
      "harness",
      ["./conformance/harness.test.ts", "./src/websocket/test/frames.test.js"],
    ],
    [
      "rfc6120",
      [
        "./conformance/rfc6120-streams.test.ts",
        "./conformance/rfc6120.test.ts",
      ],
    ],
    ["rfc7622", ["./conformance/rfc7622/contexts.test.ts"]],
    ["xep0198", ["./conformance/xep0198-queue.test.ts"]],
  ]);
});

test("runner retains every suite exactly once", () => {
  const paths = [
    "./conformance/rfc6120.test.ts",
    "./conformance/rfc7395.test.ts",
    "./conformance/xep0156.test.js",
    "./src/reconnect/test.js",
  ];
  expect([...groupSuites(paths).values()].flat().sort()).toEqual(paths.sort());
});

test("runner refuses duplicate suite admission", () => {
  expect(() => groupSuites(["same.test.ts", "same.test.ts"])).toThrow(
    "Duplicate conformance suite",
  );
});

test("runner retains unknown suites rather than excluding them", () => {
  expect([...groupSuites(["./conformance/new-standard.test.ts"])]).toEqual([
    ["harness", ["./conformance/new-standard.test.ts"]],
  ]);
});
