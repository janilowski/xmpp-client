import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { validateReport } from "./report.ts";

// Match Bun's test filenames; callers execute the discovered paths explicitly.
// https://bun.com/docs/test
const TEST_FILENAME = /[._](?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const BATCH_TIMEOUT_MS = 90_000;

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

export function runBatch(command: string[], report: string) {
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    timeout: BATCH_TIMEOUT_MS,
  });
  let reportError: string | undefined;
  try {
    validateReport(
      new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(report)),
    );
  } catch (error) {
    reportError = error instanceof Error ? error.message : String(error);
  }
  return {
    command,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    reportError,
    passed: result.status === 0 && reportError === undefined,
  };
}
