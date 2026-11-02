import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, firefox, type BrowserContext } from "playwright";

// Owned subprocess driver: only disposable NSS databases are modified.
const [engine, directory, port] = process.argv.slice(2);
assert.ok(engine === "chromium" || engine === "firefox");
assert.ok(directory && port);
const home = join(directory, "home");
const data = join(home, ".local", "share");
const profile = join(directory, "profile");
const database = `sql:${engine === "firefox" ? profile : join(data, "pki", "nssdb")}`;
await mkdir(database.slice(4), { recursive: true });
let imported = "";
for (const args of [
  ["-N", "--empty-password", "-d", database],
  [
    "-A",
    "-d",
    database,
    "-n",
    "Closure fixture CA",
    "-t",
    "C,,",
    "-i",
    join(directory, "ca.pem"),
  ],
  ["-L", "-d", database, "-n", "Closure fixture CA", "-a"],
]) {
  const result = spawnSync(process.env.XMPP_CERTUTIL ?? "certutil", args, {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  imported = result.stdout;
}
assert.equal(
  new X509Certificate(imported).fingerprint256,
  new X509Certificate(await readFile(join(directory, "ca.pem"))).fingerprint256,
);
const browserType = engine === "chromium" ? chromium : firefox;
let context: BrowserContext | undefined;
let origin: ReturnType<typeof Bun.serve> | undefined;
const release = new Promise<void>((resolve) =>
  process.stdin.once("data", () => resolve()),
);
const keepAlive = setInterval(() => {}, 1000);
const errors: string[] = [];
try {
  context = await browserType.launchPersistentContext(profile, {
    ...(engine === "chromium" ? { channel: "chromium" } : {}),
    ignoreHTTPSErrors: false,
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: join(home, ".config"),
    },
  });
  origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("<!doctype html><title>TLS closure</title>");
    },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.text() === "CLOSURE_STOPPING") {
      console.log(JSON.stringify({ phase: "stopping" }));
    }
  });
  console.log(
    JSON.stringify({ phase: "ready", version: context.browser()!.version() }),
  );
  await page.goto(`http://127.0.0.1:${origin.port}/`);
  await page.addScriptTag({ path: "dist/xmpp.min.js" });
  const result = await page.evaluate(async (port) => {
    const { client, xml } = (
      globalThis as typeof globalThis & {
        XMPP: typeof import("../../src/index.ts");
      }
    ).XMPP;
    const xmpp = client({
      service: `wss://localhost:${port}/xmpp`,
      domain: "example.test",
      username: "user",
      password: "password",
      resource: "r",
      timeout: 4000,
    });
    const errors: string[] = [];
    xmpp.reconnect.stop();
    xmpp.on("error", (error) => errors.push(String(error)));
    await xmpp.start();
    const address = xmpp.jid!.toString();
    const received = new Promise<string>((resolve) =>
      xmpp.on("stanza", (element) => {
        const stanza = element as {
          is(name: string): boolean;
          getChildText(name: string): string;
        };
        if (stanza.is("message")) {
          resolve(stanza.getChildText("body"));
        }
      }),
    );
    await xmpp.send(
      xml("message", { to: "friend@example.test" }, xml("body", {}, "probe")),
    );
    const reply = await received;
    const stopped = xmpp.stop();
    setTimeout(() => console.log("CLOSURE_STOPPING"), 0);
    await stopped;
    return { address, reply, errors };
  }, port);
  console.log(JSON.stringify({ phase: "result", result, pageErrors: errors }));
  await release;
  assert.deepEqual(errors, [], "Browser errors after stop completion");
} finally {
  try {
    await context?.close();
  } finally {
    try {
      await origin?.stop(true);
    } finally {
      clearInterval(keepAlive);
      process.stdin.destroy();
    }
  }
}
