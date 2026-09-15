import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { createHash, X509Certificate } from "node:crypto";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import server from "./server/index.js";

let browser;
const origin = createServer((_request, response) =>
  response.end("<!doctype html><title>XMPP test</title>"),
);
beforeAll(async () => {
  await server.restart();
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const certificate = new X509Certificate(
    await readFile(path.join(process.env.XMPP_TEST_DIR, "certs/localhost.crt")),
  );
  const spki = createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  // Trust only this disposable fixture key, not arbitrary HTTPS certificates.
  browser = await chromium.launch({
    args: [`--ignore-certificate-errors-spki-list=${spki}`],
  });
});

test("Chromium rejects the fixture certificate without explicit trust", async () => {
  const untrusted = await chromium.launch();
  try {
    const page = await untrusted.newPage();
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    const result = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const socket = new WebSocket(
            "wss://localhost:5281/xmpp-websocket",
            "xmpp",
          );
          socket.onopen = () => {
            socket.close();
            resolve("accepted");
          };
          socket.onerror = () => resolve("rejected");
        }),
    );
    expect(result).toBe("rejected");
  } finally {
    await untrusted.close();
  }
});
afterAll(async () => {
  await browser?.close();
  origin.close();
});

test.each([
  ["xmpp.js", "ws://localhost:5280/xmpp-websocket"],
  ["xmpp.min.js", "ws://localhost:5280/xmpp-websocket"],
  ["xmpp.min.js", "wss://[::1]:5281/xmpp-websocket"],
])("Chromium authenticates with %s over %s", async (file, service) => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ path: `dist/${file}` });
    const address = await page.evaluate(async (service) => {
      const xmpp = globalThis.XMPP.client({
        credentials: { username: "client", password: "foobar" },
        service,
        domain: "localhost",
      });
      try {
        return (await xmpp.start()).bare().toString();
      } finally {
        await xmpp.stop();
      }
    }, service);
    expect(address).toBe("client@localhost");
  } finally {
    await page.close();
  }
});
