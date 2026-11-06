import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { platform, release, arch } from "node:os";
import process from "node:process";
import { discoverSuites, groupSuites, runBatch } from "./test-batches.ts";

// A fresh directory prevents stale reports from masquerading as evidence.
mkdirSync("conformance/reports", { recursive: true });
const directory = mkdtempSync("conformance/reports/run-");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim() !== "";
const suites = [
  ...discoverSuites("conformance"),
  ...[
    "src/websocket/test/subprotocol.test.js",
    "src/websocket/test/frames.test.js",
    "src/resolve/test/resolve.test.js",
    "src/resolve/test/connect.test.js",
    "src/xml/test/limits.test.js",
    "src/reconnect/test.js",
  ].map((path) => resolve(path)),
];
const results = [...groupSuites(suites)].map(([standard, paths]) => {
  const report = join(directory, `${standard}.xml`);
  const command = [
    process.execPath,
    "test",
    ...paths,
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ];
  const result = runBatch(command, report);
  if (result.reportError !== undefined) {
    console.error(`Invalid JUnit report (${standard}): ${result.reportError}`);
  }
  return {
    standard,
    ...result,
  };
});
const exitCode = results.every((result) => result.passed) ? 0 : 1;
writeFileSync(
  join(directory, "environment.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      revision,
      dirty,
      runtime: execFileSync(process.execPath, ["--version"], {
        encoding: "utf8",
      }).trim(),
      platform: `${platform()} ${release()} ${arch()}`,
      batches: results,
      exitCode,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Conformance report: ${directory}`);
process.exitCode = exitCode;
