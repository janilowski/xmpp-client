import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Keep the independent peer outside Python's system packages and our bundles.
execFileSync(
  process.env.XMPP_TEST_PYTHON ?? "python3",
  [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--require-hashes",
    "--only-binary=:all:",
    "--upgrade",
    "--target",
    resolve("server/.cache/tls-peer"),
    "-r",
    "conformance/fixtures/tls-requirements.txt",
  ],
  { stdio: "inherit" },
);
