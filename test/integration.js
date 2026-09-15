import { mkdtemp, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

// Each invocation owns its data and logs; an occupied port is never reused.
await mkdir("server/.runtime", { recursive: true });
const lockPath = "server/.runtime/integration.lock";
try {
  await mkdir(lockPath);
} catch (error) {
  if (error.code !== "EEXIST") {
    throw error;
  }
  throw new Error(
    "Another integration run owns the fixed ports. If it crashed, check for remaining Prosody processes before removing server/.runtime/integration.lock.",
    { cause: error },
  );
}
process.env.XMPP_TEST_DIR = await mkdtemp(path.resolve("server/.runtime/run-"));
const { default: server } = await import("../server/index.js");
console.log(`Prosody fixture: ${process.env.XMPP_TEST_DIR}`);
try {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error(
      "Unset NODE_TLS_REJECT_UNAUTHORIZED: this suite verifies TLS.",
    );
  }
  await server.prepare();
  const files =
    process.argv[2] === "browser"
      ? ["./browser.test.js"]
      : [
          "./test/client.test.js",
          "./test/sasl.test.js",
          "./test/stream-management.test.js",
        ];
  const child = spawn(
    process.execPath,
    ["test", "--timeout", "20000", "--max-concurrency", "1", ...files],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: path.join(
          process.env.XMPP_TEST_DIR,
          "certs/ca.crt",
        ),
      },
    },
  );
  const forwardSignal = (signal) => child.kill(signal);
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  const SUITE_TIMEOUT_MS = 120_000;
  const deadline = setTimeout(() => child.kill("SIGKILL"), SUITE_TIMEOUT_MS);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
  }
} finally {
  try {
    await server.stop();
  } finally {
    await rmdir(lockPath);
  }
}
