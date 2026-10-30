import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type BrowserContext } from "playwright";
import {
  OFFER_MODES,
  OFFER_TIMEOUT_MS,
  STATIC_RSA,
  observeOffers,
  validateOfferControls,
  type Hello,
} from "../conformance/tls-offers.ts";

// RFC 10015 §4 / Table 4: default native browser offers, not certificate checks.
// https://www.rfc-editor.org/rfc/rfc10015.html#section-4
const probe = Bun.spawnSync([chromium.executablePath(), "--version"]);
expect(probe.exitCode).toBe(0);
const version = probe.stdout.toString().match(/\d+\.\d+\.\d+\.\d+/)?.[0];
expect(version).toBeDefined();
let context: BrowserContext;
let directory: string;
let origin: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-browser-offers-"));
  origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") {
        return new Response(
          "<!doctype html><title>ClientHello offers</title>",
          { headers: { "Content-Type": "text/html" } },
        );
      }
      if (!/^\/[A-Za-z\d_.-]+\.js$/.test(path)) {
        return new Response(null, { status: 404 });
      }
      return new Response(Bun.file(`dist${path}`), {
        headers: { "Content-Type": "text/javascript" },
      });
    },
  });
  context = await chromium.launchPersistentContext(directory, {
    channel: "chromium",
    ignoreHTTPSErrors: false,
  });
  expect(context.browser()?.version()).toBe(version);
});
afterAll(async () => {
  await context?.close();
  origin?.stop(true);
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of OFFER_MODES) {
  describe(`RFC 10015 §4: Chromium bundle ${mode}`, () => {
    let hellos: Hello[];
    beforeAll(async () => {
      hellos = await observeOffers(async (port) => {
        const page = await context.newPage();
        try {
          await page.goto(`http://127.0.0.1:${origin.port}/`);
          const service =
            mode === "direct WSS"
              ? `wss://localhost:${port}/xmpp`
              : `localhost:${port}`;
          const result = (await page.evaluate(`(async()=>{
            const {client}=await import('/index.js');
            const xmpp=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:2000});
            xmpp.reconnect.stop();xmpp.on('error',()=>{});
            try{await xmpp.connect(xmpp.options.service);throw new Error('Raw observer cannot establish TLS');}
            catch(error){return {name:error.name,message:error.message};}
            finally{await xmpp.stop();}
          })()`)) as { name: string; message: string };
          expect(result.name).not.toBe("TimeoutError");
          expect(result.message).not.toBe("Raw observer cannot establish TLS");
        } finally {
          await page.close();
        }
      });
      validateOfferControls(hellos);
    }, OFFER_TIMEOUT_MS);

    const knownFailure = version === "156.0.8078.4";
    test.failingIf(knownFailure)(
      `offers no static-RSA suites${knownFailure ? " [expected Chromium 156.0.8078.4 violation #86]" : ""}`,
      () => {
        expect(
          hellos.map((hello) =>
            hello.ciphers.filter((id) => STATIC_RSA.has(id)),
          ),
        ).toEqual(hellos.map(() => []));
      },
    );
  });
}
