import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSuites, groupSuites } from "./test-batches.ts";

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
