import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { platform, release, arch } from "node:os";
import process from "node:process";

const RUN_TIMEOUT_MS = 60_000;

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
const args = [
  "test",
  "conformance",
  "src/websocket/test/subprotocol.test.js",
  "--reporter=junit",
  `--reporter-outfile=${join(directory, "tests.xml")}`,
];
const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  timeout: RUN_TIMEOUT_MS,
});
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
      command: [process.execPath, ...args],
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Conformance report: ${directory}`);
process.exitCode = result.status ?? 1;
