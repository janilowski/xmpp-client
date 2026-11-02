import { afterAll, beforeAll, expect, test } from "bun:test";
import { firefox, type Browser, type Page } from "playwright";
import { rolldown } from "rolldown";
import {
  CONTEXT_VECTORS,
  MAPPING_VECTORS,
  VERSION_VECTORS,
} from "../conformance/rfc7622/vectors.js";
import { ScriptedPeer } from "../conformance/peer.ts";
import { readFrame } from "../conformance/xml.ts";
import type { Element } from "../types/index.js";

// Bounded Firefox protocol evidence, not TLS validation or a support declaration.
// Explicit loopback WS permits the fixture's PLAIN exchange without certificates.
// RFC 7395 §§3.4–3.7; RFC 6120 §§4.3.6/4.8/4.9; RFC 4616 §2.
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const CONTENT = "jabber:client";
const FOREIGN = "urn:test:browser-protocol";
const ACCOUNT = "assigned@example.test/server";
const CLOSE = `<close xmlns="${FRAMING}"/>`;
const DEADLINE_MS = 4000;
let browser: Browser;
let origin: ReturnType<typeof Bun.serve>;
type BrowserGlobals = typeof globalThis & {
  XMPP: typeof import("../src/index.ts");
  UnicodeTables: Record<string, { test(value: string): boolean }>;
  restoreUnicodeMethods?: () => void;
};

beforeAll(async () => {
  browser = await firefox.launch();
  expect(browser.version()).toBe("157.0");
  origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<!doctype html><title>Protocol smoke</title>"),
  });
});

afterAll(async () => {
  await browser?.close();
  origin?.stop(true);
});

// Internal table-decoder evidence, not a new public export. The frozen digest
// covers every property/code point; public bundle behavior is checked below.
test("Firefox decodes every Unicode property without changing its repertoire", async () => {
  const build = await rolldown({ input: "src/jid/lib/unicode.js" });
  let page: Page | undefined;
  try {
    page = await browser.newPage();
    const { output } = await build.generate({
      format: "iife",
      name: "UnicodeTables",
      minify: true,
    });
    await page.goto(`http://127.0.0.1:${origin.port}/`);
    await page.addScriptTag({ content: output[0]!.code });
    const hash = await page.evaluate(async () => {
      const properties = Object.entries(
        (globalThis as BrowserGlobals).UnicodeTables,
      )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, property]) => property);
      const end = 0x110000;
      const values = new Uint8Array(properties.length * end);
      for (let bit = 0; bit < properties.length; bit++) {
        for (let cp = 0; cp < end; cp++) {
          values[bit * end + cp] = Number(
            properties[bit]!.test(String.fromCodePoint(cp)),
          );
        }
      }
      // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Runs in Firefox, not Node.
      const digest = await globalThis.crypto.subtle.digest("SHA-256", values);
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    });
    expect(hash).toBe(
      "c445e88b892f68395bd6025dabb88abb11d9e53de2165bb77849a1ca1487ba83",
    );
  } finally {
    try {
      await page?.close();
    } finally {
      await build.close();
    }
  }
}, 20000);

// RFC 7622 §§3.2–3.4 / RFC 5892 contexts and the selected Unicode-16 profile.
// Expectations come from the shared literal vectors, never production tables.
test("Firefox minified JIDs preserve shared contexts, mappings and Unicode 16 repertoire", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.port}/`);
    await page.addScriptTag({ path: "dist/xmpp.min.js" });
    const vectors = [
      ...CONTEXT_VECTORS,
      ...MAPPING_VECTORS,
      ...VERSION_VECTORS,
    ];
    const actual = await page.evaluate(
      (vectors) => ({
        caseMapping: "\u1c89".toLowerCase(),
        normalization: "\u{1ccf0}".normalize("NFKC"),
        results: vectors.map(({ input }) => {
          try {
            return (globalThis as BrowserGlobals).XMPP.jid(input).toString();
          } catch (error) {
            return error instanceof TypeError
              ? null
              : { error: error instanceof Error ? error.name : String(error) };
          }
        }),
      }),
      vectors,
    );
    expect(actual.caseMapping).toBe("\u1c8a");
    expect(actual.normalization).toBe("0");
    for (let index = 0; index < vectors.length; index++) {
      const { section, slot, input, expected } = vectors[index]!;
      expect({ section, slot, input, actual: actual.results[index] }).toEqual({
        section,
        slot,
        input,
        actual: expected,
      });
    }
  } finally {
    await page.close();
  }
});

test.each(["case mapping", "normalization"])(
  "Firefox minified JIDs fail closed with inadequate Unicode 16 %s",
  async (probe) => {
    // Each fresh realm loads the bundle only after simulating missing support.
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${origin.port}/`);
      await page.evaluate((probe) => {
        const lower = String.prototype.toLowerCase;
        const normalize = String.prototype.normalize;
        (globalThis as BrowserGlobals).restoreUnicodeMethods = () => {
          String.prototype.toLowerCase = lower;
          String.prototype.normalize = normalize;
        };
        if (probe === "case mapping") {
          String.prototype.toLowerCase = function () {
            return String(this) === "\u1c89" ? "\u1c89" : lower.call(this);
          };
        } else {
          String.prototype.normalize = function (form) {
            return String(this) === "\u{1ccf0}" && form === "NFKC"
              ? "\u{1ccf0}"
              : normalize.call(this, form);
          };
        }
      }, probe);
      await page.addScriptTag({ path: "dist/xmpp.min.js" });
      const actual = await page.evaluate(() => {
        const globals = globalThis as BrowserGlobals;
        globals.restoreUnicodeMethods!();
        const { jid } = globals.XMPP;
        return {
          rejected: [
            "\u1c89@example.com",
            "bücher.example",
            "xn--bcher-kva.example",
            "example.com/é",
          ].map((input) => {
            try {
              jid(input);
              return false;
            } catch (error) {
              return error instanceof TypeError;
            }
          }),
          ascii: jid("A@example.com/ASCII").toString(),
        };
      });
      expect(actual).toEqual({
        rejected: [true, true, true, true],
        ascii: "a@example.com/ASCII",
      });
    } finally {
      try {
        await page.evaluate(() =>
          (globalThis as BrowserGlobals).restoreUnicodeMethods?.(),
        );
      } finally {
        await page.close();
      }
    }
  },
);

for (const mode of [
  "ordinary",
  "prefixed extensions",
  "malformed XML",
] as const) {
  test(`Firefox minified public-wire protocol / ${mode}`, async () => {
    let authenticated = false;
    let bindingId: string | undefined;
    const prefixed = mode === "prefixed extensions";
    const hostile = mode === "malformed XML";
    const peer = new ScriptedPeer((frame, remote) => {
      const root = readFrame(frame)[0];
      if (!("open" in root)) {
        throw new Error("Expected a client element");
      }
      if (root.open === `{${FRAMING}}open`) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" id="${authenticated ? "second" : "first"}" version="1.0"/>`,
        );
        const feature = authenticated
          ? prefixed
            ? `<b:bind xmlns:b="${BIND}"/>`
            : `<bind xmlns="${BIND}"/>`
          : prefixed
            ? `<s:mechanisms xmlns:s="${SASL}"><s:mechanism>PLAIN</s:mechanism></s:mechanisms>`
            : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`;
        remote.send(
          prefixed
            ? `<s:features xmlns:s="${STREAM}">${feature}</s:features>`
            : `<features xmlns="${STREAM}">${feature}</features>`,
        );
      } else if (root.open === `{${SASL}}auth`) {
        authenticated = true;
        remote.send(
          prefixed
            ? `<s:success xmlns:s="${SASL}"/>`
            : `<success xmlns="${SASL}"/>`,
        );
      } else if (root.open === `{${CONTENT}}iq`) {
        bindingId = root.attributes["{}id"];
        remote.send(
          prefixed
            ? `<iq xmlns="${CONTENT}" type="result" id="${bindingId}"><b:bind xmlns:b="${BIND}"><b:jid>${ACCOUNT}</b:jid></b:bind></iq>`
            : `<iq xmlns="${CONTENT}" type="result" id="${bindingId}"><bind xmlns="${BIND}"><jid>${ACCOUNT}</jid></bind></iq>`,
        );
      } else if (root.open === `{${CONTENT}}message`) {
        if (hostile) {
          remote.send(`<message xmlns="${CONTENT}"><body></message>`);
          remote.send(
            `<message xmlns="${CONTENT}" id="late"><body>forbidden</body></message>`,
          );
        } else {
          if (prefixed) {
            remote.send(`<f:notice xmlns:f="${FOREIGN}" id="opaque"/>`);
          }
          remote.send(
            `<message xmlns="${CONTENT}" from="friend@example.test" to="${ACCOUNT}" id="inbound"><body>reply</body></message>`,
          );
        }
      } else if (root.open === `{${FRAMING}}close`) {
        remote.send(CLOSE);
      }
    });
    let page: Page | undefined;
    const pageErrors: string[] = [];
    try {
      page = await browser.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${origin.port}/`);
      await page.addScriptTag({ path: "dist/xmpp.min.js" });
      const result = await page.evaluate(
        async ({ service, hostile, deadline }) => {
          const { client, xml } = (
            globalThis as typeof globalThis & {
              XMPP: typeof import("../src/index.ts");
            }
          ).XMPP;
          const xmpp = client({
            service,
            domain: "example.test",
            username: "user",
            password: "password",
            resource: "requested",
            timeout: 1000,
          });
          xmpp.reconnect.stop();
          const errors: string[] = [];
          const stanzas: string[] = [];
          const notices: string[] = [];
          const online: string[] = [];
          let timer: ReturnType<typeof setTimeout> | undefined;
          let failure!: () => void;
          let received!: () => void;
          const failed = new Promise<void>((resolve) => {
            failure = resolve;
          });
          const incoming = new Promise<void>((resolve) => {
            received = resolve;
          });
          const disconnected = new Promise<void>((resolve) =>
            xmpp.once("disconnect", resolve),
          );
          xmpp.on("error", (error: Error & { condition?: string }) => {
            errors.push(error.condition ?? error.name);
            failure();
          });
          xmpp.on("online", (address: unknown) => online.push(String(address)));
          xmpp.on("nonza", (element: Element) => {
            if (element.is("notice", "urn:test:browser-protocol")) {
              notices.push(element.attrs.id as string);
            }
          });
          const exchange = async () => {
            const address = String(await xmpp.start());
            // Binding IQs precede online; observe application input after that barrier.
            xmpp.on("stanza", (element: Element) => {
              stanzas.push(element.toString());
              received();
            });
            await xmpp.send(
              xml(
                "message",
                { id: "outbound", to: "friend@example.test" },
                xml("body", {}, "probe"),
              ),
            );
            let blocked = false;
            if (hostile) {
              await failed;
              blocked = await xmpp
                .send(
                  xml("message", {
                    id: "forbidden",
                    to: "friend@example.test",
                  }),
                )
                .then(
                  () => false,
                  () => true,
                );
              await disconnected;
            } else {
              await incoming;
              await xmpp.stop();
              await disconnected;
            }
            return { address, errors, stanzas, notices, online, blocked };
          };
          try {
            return await Promise.race([
              exchange(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Browser exchange deadline")),
                  deadline,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
            await xmpp.stop();
          }
        },
        { service: peer.url, hostile, deadline: DEADLINE_MS },
      );
      await peer.waitForClose();
      expect(result.address).toBe(ACCOUNT);
      expect(result.online).toEqual([ACCOUNT]);
      // Preferred diagnostics are project policy; RFC 6120 also permits bad-format.
      expect(result.errors).toEqual(hostile ? ["not-well-formed"] : []);
      expect(result.blocked).toBe(hostile);
      expect(result.notices).toEqual(prefixed ? ["opaque"] : []);
      expect(result.stanzas.map(readFrame)).toEqual(
        hostile
          ? []
          : [
              readFrame(
                `<message xmlns="${CONTENT}" from="friend@example.test" to="${ACCOUNT}" id="inbound"><body>reply</body></message>`,
              ),
            ],
      );
      expect(bindingId).toEqual(expect.any(String));
      expect(peer.transcript.map(readFrame)).toEqual([
        readFrame(
          `<open xmlns="${FRAMING}" to="example.test" version="1.0" from="user@example.test"/>`,
        ),
        readFrame(
          `<auth xmlns="${SASL}" mechanism="PLAIN">AHVzZXIAcGFzc3dvcmQ=</auth>`,
        ),
        readFrame(
          `<open xmlns="${FRAMING}" to="example.test" version="1.0" from="user@example.test"/>`,
        ),
        readFrame(
          `<iq xmlns="${CONTENT}" type="set" id="${bindingId}"><bind xmlns="${BIND}"><resource>requested</resource></bind></iq>`,
        ),
        readFrame(
          `<message xmlns="${CONTENT}" id="outbound" to="friend@example.test"><body>probe</body></message>`,
        ),
        ...(hostile
          ? [
              readFrame(
                `<error xmlns="${STREAM}"><not-well-formed xmlns="${ERRORS}"/></error>`,
              ),
            ]
          : []),
        readFrame(CLOSE),
      ]);
      expect(peer.errors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      try {
        await page?.close();
      } finally {
        await peer.stop();
      }
    }
  });
}
