import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// Match Bun's test filenames; callers execute the discovered paths explicitly.
// https://bun.com/docs/test
const TEST_FILENAME = /[._](?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;

export function discoverSuites(directory: string) {
  const suites = readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && TEST_FILENAME.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
  if (!suites.length) {
    throw new Error("No conformance suites found");
  }
  return suites;
}

export function groupSuites(paths: readonly string[]) {
  if (new Set(paths).size !== paths.length) {
    throw new Error("Duplicate conformance suite");
  }

  const groups = new Map<string, string[]>();
  for (const path of [...paths].sort()) {
    const standard =
      basename(path).match(/^(rfc\d+|xep\d+)[._-]/)?.[1] ??
      basename(dirname(path)).match(/^(rfc\d+|xep\d+)$/)?.[1] ??
      "harness";
    const suites = groups.get(standard) ?? [];
    suites.push(path);
    groups.set(standard, suites);
  }
  return groups;
}
