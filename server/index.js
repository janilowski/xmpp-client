import { promisify } from "node:util";
import { createPrivateKey, X509Certificate } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import net from "node:net";

import { promise, delay, TimeoutError } from "../src/events/index.js";

import { makeSelfSignedCertificate } from "../test/helpers.js";

const __dirname = path.resolve("server");

const exec = promisify(child_process.exec);

const DATA_PATH = path.resolve(
  process.env.XMPP_TEST_DIR || "server/.runtime/manual",
);
const PID_PATH = path.join(DATA_PATH, "prosody.pid");
const PROSODY_PORT = 5347;
const FIXTURE_ENDPOINTS = [PROSODY_PORT, 5280, 5281].flatMap((port) =>
  ["127.0.0.1", "::1"].map((host) => ({ host, port })),
);
const PROBE_TIMEOUT_MS = 1000;
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_POLL_MS = 100;
const CFG_PATH = path.join(DATA_PATH, "prosody.cfg.lua");
const environment = {
  ...process.env,
  PROSODY_CONFIG: CFG_PATH,
  PROSODY_TEST_DIR: DATA_PATH,
  PROSODY_MODULES_DIR: path.join(__dirname, "modules"),
};

function clean() {
  return Promise.all(
    ["prosody.pid"].map((file) => fs.unlink(path.join(DATA_PATH, file))),
  ).catch(() => {});
}

async function isPortOpen(
  port = PROSODY_PORT,
  host = "127.0.0.1",
  timeout = PROBE_TIMEOUT_MS,
) {
  const sock = new net.Socket();
  sock.connect({ host, port });

  try {
    await promise(sock, "connect", "error", timeout);
    return true;
  } catch (error) {
    if (error.code === "ECONNREFUSED") {
      return false;
    }
    if (error instanceof TimeoutError) {
      error.message = `Timed out probing Prosody listener [${host}]:${port}.`;
      throw error;
    }
    throw new Error(
      `Cannot probe Prosody listener [${host}]:${port}: ${error.message}`,
      { cause: error },
    );
  } finally {
    sock.destroy();
  }
}

async function waitForPorts(state, timeout = READINESS_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let pending = FIXTURE_ENDPOINTS;

  // Host/module activation order varies; no one listener represents the fixture.
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const endpoints = pending
        .map(({ host, port }) => `[${host}]:${port}`)
        .join(", ");
      throw new Error(
        `Prosody listeners did not become ${state} in time: ${endpoints}.`,
      );
    }

    const statuses = await Promise.all(
      FIXTURE_ENDPOINTS.map(async ({ host, port }) => {
        try {
          return await isPortOpen(
            port,
            host,
            Math.min(PROBE_TIMEOUT_MS, remaining),
          );
        } catch (error) {
          if (
            !(error instanceof TimeoutError) &&
            error.cause?.code !== "ECONNRESET"
          ) {
            throw error;
          }
          // A reset or timeout proves neither an open nor a closed listener.
          return undefined;
        }
      }),
    );
    pending = FIXTURE_ENDPOINTS.filter(
      (_endpoint, index) => statuses[index] !== (state === "open"),
    );
    if (!pending.length) {
      return;
    }
    await delay(
      Math.min(READINESS_POLL_MS, Math.max(0, deadline - Date.now())),
    );
  }
}

function waitPortOpen() {
  return waitForPorts("open");
}

async function ensureCertificate() {
  const certificatePath = path.join(DATA_PATH, "certs/localhost.crt");
  const keyPath = path.join(DATA_PATH, "certs/localhost.key");
  const caPath = path.join(DATA_PATH, "certs/ca.crt");

  try {
    const [certificatePem, keyPem] = await Promise.all([
      fs.readFile(certificatePath),
      fs.readFile(keyPath),
    ]);
    await fs.access(caPath);
    const certificate = new X509Certificate(certificatePem);
    const now = Date.now();
    const valid =
      Date.parse(certificate.validFrom) <= now &&
      Date.parse(certificate.validTo) > now &&
      certificate.checkHost("localhost") &&
      certificate.checkIP("127.0.0.1") &&
      certificate.checkIP("::1") &&
      certificate.checkPrivateKey(createPrivateKey(keyPem));
    if (valid) {
      return;
    }
  } catch {
    // Generate the test certificate below.
  }

  const ca = await makeSelfSignedCertificate({
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  const pem = await makeSelfSignedCertificate({
    ca: { key: ca.private, cert: ca.cert },
  });
  await Promise.all([
    fs.writeFile(caPath, ca.cert),
    fs.writeFile(certificatePath, pem.cert),
    fs.writeFile(keyPath, pem.private, { mode: 0o600 }),
  ]);
}

function waitPortClose() {
  return waitForPorts("closed");
}

async function kill(signal = "SIGTERM") {
  const pid = Number(await getPid());
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error("Invalid fixture PID");
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function getPid() {
  try {
    return (await fs.readFile(PID_PATH, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

async function _start() {
  await prepare();
  for (const { host, port } of FIXTURE_ENDPOINTS) {
    if (await isPortOpen(port, host)) {
      throw new Error(
        `Port [${host}]:${port} is occupied by another server; refusing to reuse it.`,
      );
    }
  }

  await exec("prosody -D", {
    cwd: DATA_PATH,
    env: environment,
  });

  return waitPortOpen();
}

async function start() {
  if (await getPid()) {
    return waitPortOpen();
  }
  await clean();
  return _start();
}

async function stop(signal) {
  if (!(await getPid())) {
    return clean();
  }

  await kill(signal);
  await waitPortClose();
  return clean();
}

async function restart(signal) {
  await stop(signal);
  return _start();
}

async function enableModules(mods) {
  try {
    await fs.access(CFG_PATH);
  } catch {
    await reset();
  }
  if (!Array.isArray(mods)) {
    mods = [mods];
  }

  let prosody_cfg = await fs.readFile(CFG_PATH, "utf8");
  for (const mod of mods) {
    prosody_cfg = prosody_cfg.replace(`\n  -- "${mod}";`, `\n  "${mod}";`);
  }
  await fs.writeFile(CFG_PATH, prosody_cfg);
}

async function disableModules(mods) {
  try {
    await fs.access(CFG_PATH);
  } catch {
    await reset();
  }
  if (!Array.isArray(mods)) {
    mods = [mods];
  }

  let prosody_cfg = await fs.readFile(CFG_PATH, "utf8");
  for (const mod of mods) {
    prosody_cfg = prosody_cfg.replace(`\n  "${mod}";`, `\n  -- "${mod}";`);
  }
  await fs.writeFile(CFG_PATH, prosody_cfg);
}

async function reset() {
  await fs.mkdir(DATA_PATH, { recursive: true });
  await fs.copyFile(path.join(__dirname, "prosody.cfg.lua"), CFG_PATH);
}

async function prepare() {
  await fs.mkdir(path.join(DATA_PATH, "certs"), { recursive: true });
  try {
    await fs.access(CFG_PATH);
  } catch {
    await reset();
  }
  await ensureCertificate();
  try {
    await fs.access(path.join(DATA_PATH, ".provisioned"));
  } catch {
    await promisify(child_process.execFile)(
      "prosodyctl",
      ["--config", CFG_PATH, "register", "client", "localhost", "foobar"],
      { cwd: DATA_PATH, env: environment },
    );
    await fs.writeFile(path.join(DATA_PATH, ".provisioned"), "");
  }
}

export default {
  configPath: CFG_PATH,
  prepare,
  isPortOpen,
  waitPortClose,
  waitPortOpen,
  getPid,
  start,
  stop,
  restart,
  kill,
  enableModules,
  disableModules,
  reset,
};
