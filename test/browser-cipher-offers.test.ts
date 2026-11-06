import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, firefox, type BrowserContext } from "playwright";
import {
  OFFER_MODES,
  OFFER_TIMEOUT_MS,
  STATIC_RSA,
  observeOffers,
  validateOfferControls,
  validateOfferExtensions,
  type Hello,
} from "../conformance/tls-offers.ts";

// RFC 10015 §4 / Table 4: default native browser offers, not certificate checks.
// https://www.rfc-editor.org/rfc/rfc10015.html#section-4
const VERSION_TIMEOUT_MS = 5000;
const probe = Bun.spawnSync([chromium.executablePath(), "--version"], {
  timeout: VERSION_TIMEOUT_MS,
});
expect(probe.exitCode).toBe(0);
const version = probe.stdout.toString().match(/\d+\.\d+\.\d+\.\d+/)?.[0];
expect(version).toBeDefined();
const firefoxProbe = Bun.spawnSync([firefox.executablePath(), "--version"], {
  timeout: VERSION_TIMEOUT_MS,
});
expect(firefoxProbe.exitCode).toBe(0);
const firefoxVersion = firefoxProbe.stdout
  .toString()
  .match(/\d+\.\d+(?:\.\d+)*/)?.[0];
expect(firefoxVersion).toBeDefined();
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

    test("RFC 9325 §§4.2.1/4.5/4.6: safe point-format, SHA-256 and HMAC offers", () => {
      expect(() => validateOfferExtensions(hellos)).not.toThrow();
    });

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

// RFC 9325 §3.3 (TLS 1.2 SHOULD NOT) / RFC 9846 §4.2.2 (TLS 1.3 MUST).
// Only initial TLS record-compression offers: not certificate compression,
// WebSocket permessage-deflate, negotiated refusal or full Firefox TLS coverage.
for (const mode of OFFER_MODES) {
  describe(`RFC 10015 §4: Firefox minified bundle ${mode}`, () => {
    let hellos: Hello[];
    beforeAll(async () => {
      const browser = await firefox.launch();
      try {
        expect(browser.version()).toBe(firefoxVersion!);
        hellos = await observeOffers(async (port) => {
          const page = await browser.newPage();
          try {
            await page.goto(`http://127.0.0.1:${origin.port}/`);
            await page.addScriptTag({ path: "dist/xmpp.min.js" });
            const result = await page.evaluate(
              async (service) => {
                const bundle = globalThis as typeof globalThis & {
                  XMPP: typeof import("../src/index.ts");
                };
                const xmpp = bundle.XMPP.client({
                  service,
                  domain: "different-xmpp-domain.test",
                  timeout: 2000,
                }) as ReturnType<typeof bundle.XMPP.client> & {
                  connect(service: string): Promise<void>;
                };
                xmpp.reconnect.stop();
                xmpp.on("error", () => {});
                try {
                  await xmpp.connect(service);
                  return "accepted";
                } catch (error) {
                  return {
                    outcome: "rejected",
                    name: error instanceof Error ? error.name : "unknown",
                  };
                } finally {
                  await xmpp.stop();
                }
              },
              mode === "direct WSS"
                ? `wss://localhost:${port}/xmpp`
                : `localhost:${port}`,
            );
            expect(result).toMatchObject({ outcome: "rejected" });
            expect(result).not.toMatchObject({ name: "TimeoutError" });
          } finally {
            await page.close();
          }
        });
        validateOfferControls(hellos);
      } finally {
        await browser.close();
      }
    }, OFFER_TIMEOUT_MS);

    test("offers only null TLS compression", () => {
      expect(hellos.map((hello) => hello.compression)).toEqual(
        hellos.map(() => "00"),
      );
    });

    test("RFC 9325 §§4.2.1/4.5/4.6: safe point-format, SHA-256 and HMAC offers", () => {
      expect(() => validateOfferExtensions(hellos)).not.toThrow();
    });

    const knownFailure = firefoxVersion === "157.0";
    test.failingIf(knownFailure)(
      `offers no static-RSA suites${knownFailure ? " [expected Firefox 157.0 violation #86]" : ""}`,
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
