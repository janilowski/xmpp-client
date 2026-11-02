import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";
import { chromium, firefox } from "playwright";
import { observeClosure, type Engine } from "./support/tls-closure-observer.ts";

// RFC 6120 §§4.4/4.9.1.1, RFC 7395 §3.6, RFC 9846 §6.1.
// Receiving the reciprocal alert is the stronger XMPP-over-WSS profile rule,
// not a universal TLS 1.3 requirement. Linux /proc proves receive ownership;
// stop() resolution, TCP FIN and WS clean-close events do not prove that rule.
// RFC 6455 §7.1.1 recommends clean TLS closure; it does not itself require
// the stronger reciprocal-alert wait retained by the XMPP profile.
const SETUP_TIMEOUT_MS = 30000;
const TOOL_TIMEOUT_MS = 5000;
const browserVersions = new Map<string, string>();
for (const engine of [chromium, firefox]) {
  const probe = Bun.spawnSync([engine.executablePath(), "--version"], {
    timeout: TOOL_TIMEOUT_MS,
  });
  expect(probe.exitCode).toBe(0);
  const version = probe.stdout.toString().match(/\d+\.\d+(?:\.\d+){0,2}/)?.[0];
  expect(version).toBeDefined();
  browserVersions.set(engine.name(), version!);
}
let authority: Awaited<ReturnType<typeof generate>>;
let certificate: Awaited<ReturnType<typeof generate>>;
beforeAll(async () => {
  authority = await generate(
    [{ name: "commonName", value: "Disposable browser closure CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyCertSign: true,
          cRLSign: true,
          critical: true,
        },
      ],
    },
  );
  certificate = await generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    ca: { key: authority.private, cert: authority.cert },
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
    ],
  });
  const root = new X509Certificate(authority.cert),
    leaf = new X509Certificate(certificate.cert);
  expect(root.ca).toBe(true);
  expect(root.verify(root.publicKey)).toBe(true);
  expect(leaf.ca).toBe(false);
  expect(leaf.verify(root.publicKey)).toBe(true);
  expect(leaf.checkHost("localhost", { subject: "never" })).toBe("localhost");
  expect(leaf.checkPrivateKey(createPrivateKey(certificate.private))).toBe(
    true,
  );
  for (const parsed of [root, leaf]) {
    expect(Date.parse(parsed.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(parsed.validTo)).toBeGreaterThan(Date.now());
  }
}, SETUP_TIMEOUT_MS);

for (const version of [3, 4] as const) {
  for (const engine of [
    "native-end",
    "native-premature",
    "chromium",
    "firefox",
  ] as const satisfies readonly Engine[]) {
    describe(`TLS1.${version - 1} authenticated closure / ${engine}`, () => {
      let directory: string;
      let observed: Awaited<ReturnType<typeof observeClosure>>;
      beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "xmpp-browser-closure-"));
        await Promise.all([
          writeFile(join(directory, "ca.pem"), authority.cert),
          writeFile(join(directory, "leaf.pem"), certificate.cert),
          writeFile(join(directory, "key.pem"), certificate.private),
        ]);
        // Fixture/protocol/process failures cannot become expected violations.
        observed = await observeClosure(engine, version, directory);
        if (!engine.startsWith("native-")) {
          expect(observed.version).toBe(browserVersions.get(engine)!);
        }
      }, SETUP_TIMEOUT_MS);
      afterAll(async () => {
        if (directory) {
          await rm(directory, { recursive: true, force: true });
        }
      });
      if (engine.startsWith("native-")) {
        test("same descriptor oracle accepts orderly and rejects premature closure", () => {
          expect(observed.alerts).toEqual([
            ["received", 1, 0],
            ["sent", 1, 0],
          ]);
          if (engine === "native-premature") {
            expect(() => assert.equal(observed.retained, true)).toThrow(
              assert.AssertionError,
            );
          } else {
            assert.equal(observed.retained, true);
          }
        });
        return;
      }
      // #99: exact versions only; setup/authentication failures stay unconditional.
      const missingAlert =
        engine === "chromium" && browserVersions.get(engine) === "156.0.8078.4";
      const prematureReadClose =
        missingAlert ||
        (engine === "firefox" && browserVersions.get(engine) === "157.0");
      test.failingIf(missingAlert)(
        `sends authenticated warning close_notify before TCP closure${missingAlert ? " [expected Chromium 156.0.8078.4 violation #99]" : ""}`,
        () => {
          expect(observed.alerts[0]).toEqual(["received", 1, 0]);
        },
      );
      test.failingIf(prematureReadClose)(
        `retains receive capability until reciprocal close_notify (XMPP profile)${prematureReadClose ? ` [expected ${engine} ${browserVersions.get(engine)} violation #99]` : ""}`,
        () => {
          expect(observed.retained).toBe(true);
        },
      );
    });
  }
}
