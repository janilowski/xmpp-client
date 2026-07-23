import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import child_process from "node:child_process";
import net from "node:net";

import { promise, delay } from "../src/events/index.js";

import { makeSelfSignedCertificate } from "../test/helpers.js";

const __dirname = path.resolve("server");

const exec = promisify(child_process.exec);

const DATA_PATH = path.join(__dirname);
const PID_PATH = path.join(DATA_PATH, "prosody.pid");
const PROSODY_PORT = 5347;
const CFG_PATH = path.join(__dirname, "prosody.cfg.lua");

function clean() {
  return Promise.all(
    ["prosody.err", "prosody.log", "prosody.pid"].map((file) =>
      fs.unlink(path.join(__dirname, file)),
    ),
  ).catch(() => {});
}

async function isPortOpen() {
  const sock = new net.Socket();
  sock.connect({ host: "127.0.0.1", port: PROSODY_PORT });

  try {
    await promise(sock, "connect", "error", 1000);
    return true;
  } catch {
    return false;
  } finally {
    sock.destroy();
  }
}

async function waitForPort(open, timeout = 10_000) {
  const deadline = Date.now() + timeout;

  while ((await isPortOpen()) !== open) {
    if (Date.now() >= deadline) {
      const state = open ? "open" : "close";
      throw new Error(`Prosody port ${PROSODY_PORT} did not ${state} in time.`);
    }

    await delay(100);
  }
}

function waitPortOpen() {
  return waitForPort(true);
}

async function ensureCertificate() {
  const certificatePath = path.join(__dirname, "certs/localhost.crt");
  const keyPath = path.join(__dirname, "certs/localhost.key");

  try {
    await Promise.all([fs.access(certificatePath), fs.access(keyPath)]);
    return;
  } catch {
    // Generate the test certificate below.
  }

  const pem = await makeSelfSignedCertificate();
  await Promise.all([
    fs.writeFile(certificatePath, pem.cert),
    fs.writeFile(keyPath, pem.private),
  ]);
}

function waitPortClose() {
  return waitForPort(false);
}

async function kill(signal = "SIGTERM") {
  const pid = Number(await getPid());
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
  await ensureCertificate();

  await exec("prosody -D", {
    cwd: DATA_PATH,
    env: {
      ...process.env,
      PROSODY_CONFIG: CFG_PATH,
      PROSODY_TEST_DIR: DATA_PATH,
    },
  });

  return waitPortOpen();
}

async function start() {
  if (await isPortOpen()) return;
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
  await exec("git checkout server/prosody.cfg.lua");
}

export default {
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
