import { afterAll, beforeAll, expect, test } from "bun:test";
import { firefox, type Browser, type Page } from "playwright";
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
