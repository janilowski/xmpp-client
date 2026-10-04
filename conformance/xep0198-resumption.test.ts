import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { setImmediate } from "node:timers/promises";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const SESSION_ID = "sEssion & /π ";
const SESSION_ATTRIBUTE = 'previd="sEssion &amp; /π "';
const TIMEOUT_MS = 300;
const OBSERVATION_MS = TIMEOUT_MS * 3;

type Mode = "initial" | "ordinary" | "inline";
type Result = { resumed: string } | { failed: true };

// XEP-0198 v1.6.3 §§3,5,9.2: IDs are opaque; a response names the former stream.
// Closing malformed resumption with bad-format is local policy.
function resumptionPeer(mode: Mode, result: Result) {
  let authenticated = false;
  return new ScriptedPeer((frame, peer) => {
    const el = readFrame(frame)[0];
    if (!el || !("open" in el)) {
      throw new Error("Expected a client element");
    }
    if (el.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="resumption" version="1.0"/>`,
      );
      if (authenticated) {
        peer.send(
          `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/><sm xmlns="${SM}"/></features>`,
        );
      } else if (mode === "ordinary") {
        peer.send(
          `<features xmlns="${STREAM}"><mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms></features>`,
        );
      } else {
        peer.send(
          `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism>${mode === "inline" ? `<inline><sm xmlns="${SM}"/><bind xmlns="${BIND2}"/></inline>` : ""}</authentication></features>`,
        );
      }
    } else if (el.open === `{${SASL}}auth`) {
      authenticated = true;
      peer.send(`<success xmlns="${SASL}"/>`);
    } else if (el.open === `{${SASL2}}authenticate`) {
      if (mode === "initial") {
        peer.send(
          `<success xmlns="${SASL2}"><authorization-identifier>user@example.test</authorization-identifier></success>`,
        );
        peer.send(
          `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/><sm xmlns="${SM}"/></features>`,
        );
      } else {
        const response =
          "resumed" in result
            ? `<resumed xmlns="${SM}" ${result.resumed} h="1"/>`
            : `<failed xmlns="${SM}" h="1"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></failed><bound xmlns="${BIND2}"/>`;
        peer.send(
          `<success xmlns="${SASL2}"><authorization-identifier>user@example.test/${"failed" in result ? "new" : "old"}</authorization-identifier>${response}</success>`,
        );
        if ("failed" in result) {
          peer.send(
            `<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`,
          );
        }
      }
    } else if (el.open === `{${SM}}resume`) {
      peer.send(
        "resumed" in result
          ? `<resumed xmlns="${SM}" ${result.resumed} h="1"/>`
          : `<failed xmlns="${SM}" h="1"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></failed>`,
      );
    } else if (el.open === "{jabber:client}iq") {
      peer.send(
        `<iq xmlns="jabber:client" type="result" id="${el.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/${mode === "initial" ? "old" : "new"}</jid></bind></iq>`,
      );
    } else if (el.open === `{${SM}}enable`) {
      peer.send(
        `<enabled xmlns="${SM}" id="${mode === "initial" ? "sEssion &amp; /π " : "new-session"}" resume="true"/>`,
      );
    } else if (el.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

for (const mode of ["ordinary", "inline"] as const) {
  test.each([
    ["mismatched", 'previd="other-session"'],
    ["missing", ""],
    ["empty", 'previd=""'],
    ["trimmed", 'previd="sEssion &amp; /π"'],
    ["case-changed", 'previd="session &amp; /π "'],
    ["valid", SESSION_ATTRIBUTE],
    ["failed", null],
  ] as const)(
    `XEP-0198 §§3,5,9.2: ${mode} resumption validates the former stream ID before queue changes / %s`,
    async (kind, attribute) => {
      const first = resumptionPeer("initial", { resumed: SESSION_ATTRIBUTE });
      const second = resumptionPeer(
        mode,
        attribute === null ? { failed: true } : { resumed: attribute },
      );
      const xmpp = client({
        service: first.url,
        domain: "example.test",
        username: "user",
        password: "secret",
        timeout: TIMEOUT_MS,
      });
      xmpp.reconnect.stop();
      const sm = xmpp.streamManagement;
      sm.requestAckInterval = 0;
      const initialEnabled = Promise.withResolvers<void>();
      const replacementEnabled = Promise.withResolvers<void>();
      xmpp.on("nonza", (element) => {
        if (!element.is("enabled", SM)) {
          return;
        }
        if (element.attrs.id === SESSION_ID) {
          initialEnabled.resolve();
        } else if (element.attrs.id === "new-session") {
          replacementEnabled.resolve();
        }
      });
      const acks: string[] = [];
      const failures: string[] = [];
      const errors: Error[] = [];
      let resumed = 0;
      let online = 0;
      sm.on("ack", (stanza) => acks.push(stanza.attrs.id));
      sm.on("fail", (stanza) => failures.push(stanza.attrs.id));
      sm.on("resumed", () => {
        resumed++;
      });
      xmpp.on("status", (status) => {
        if (status === "online") {
          online++;
        }
      });
      xmpp.on("error", (error: Error) => {
        errors.push(error);
      });
      try {
        expect((await xmpp.start()).toString()).toBe("user@example.test/old");
        await initialEnabled.promise;
        // Let the exchange commit the observed enabled response.
        await setImmediate();
        expect(sm.enabled).toBe(true);
        expect(sm.id).toBe(SESSION_ID);
        await xmpp.send(xml("message", { id: "a" }));
        await xmpp.send(xml("message", { id: "b" }));
        while (!first.transcript.some((frame) => frame.includes('id="b"'))) {
          await first.next();
        }
        expect(
          sm.outbound_q.map(({ stanza }: { stanza: Element }) => stanza.attrs.id),
        ).toEqual(["a", "b"]);
        const disconnected = new Promise<void>((resolve) =>
          xmpp.once("disconnect", resolve),
        );
        first.terminate();
        await disconnected;
        online = 0;
        Object.assign(xmpp.options, { service: second.url });
        // The second session owns the observation; the first online event cannot satisfy it.
        const result = Promise.withResolvers<void>();
        sm.once("resumed", result.resolve);
        xmpp.once("close", result.resolve);
        xmpp.once("error", result.resolve);
        xmpp.on("status", (status) => {
          if (status === "online") {
            result.resolve();
          }
        });
        await xmpp.reconnect.reconnect();
        const watchdog = setTimeout(result.resolve, OBSERVATION_MS);
        await result.promise;
        clearTimeout(watchdog);
        if (kind === "failed") {
          await replacementEnabled.promise;
        } else if (kind === "valid") {
          while (!second.transcript.some((frame) => frame.includes('id="b"'))) {
            await second.next();
          }
        }
        await setImmediate();
        const invalid = kind !== "valid" && kind !== "failed";
        expect(acks).toEqual(invalid ? [] : ["a"]);
        expect(failures).toEqual(kind === "failed" ? ["b"] : []);
        expect(
          sm.outbound_q.map(({ stanza }: { stanza: Element }) => stanza.attrs.id),
        ).toEqual(invalid ? ["a", "b"] : kind === "valid" ? ["b"] : []);
        const request = second.transcript.find((frame) =>
          frame.startsWith(mode === "inline" ? "<authenticate" : "<resume"),
        );
        expect(request).toBeDefined();
        expect(readFrame(request!)).toContainEqual({
          open: `{${SM}}resume`,
          attributes: { "{}previd": SESSION_ID, "{}h": "0" },
        });
        const replay = second.transcript
          .filter((frame) => frame.startsWith("<message"))
          .map((frame) => readFrame(frame)[0]);
        expect(replay).toHaveLength(kind === "valid" ? 1 : 0);
        if (kind === "valid") {
          expect(replay[0]).toMatchObject({
            open: "{jabber:client}message",
            attributes: { "{}id": "b" },
          });
        }
        expect(resumed).toBe(kind === "valid" ? 1 : 0);
        expect(online).toBe(invalid ? 0 : 1);
        expect(sm.enabled).toBe(!invalid);
        expect(errors).toEqual([]);
        if (invalid) {
          // Client send completion alone does not establish peer receipt.
          await second.waitForClose();
          const streamError = second.transcript.find((frame) =>
            frame.startsWith("<stream:error"),
          );
          expect(streamError).toBeDefined();
          expect(readFrame(streamError!)).toContainEqual({
            open: `{${STREAM_ERRORS}}bad-format`,
            attributes: {},
          });
          expect(sm.outbound).toBe(0);
          expect(sm.id).toBe(SESSION_ID);
          expect(
            second.transcript.some((frame) => frame.startsWith("<iq")),
          ).toBe(false);
          expect(
            second.transcript.some((frame) => frame.startsWith("<enable")),
          ).toBe(false);
        } else {
          expect(xmpp.status).toBe("online");
          expect(sm.id).toBe(kind === "failed" ? "new-session" : SESSION_ID);
          expect(xmpp.jid?.toString()).toBe(
            `user@example.test/${kind === "failed" ? "new" : "old"}`,
          );
        }
        expect(first.errors).toEqual([]);
        expect(second.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await first.stop();
        await second.stop();
      }
    },
  );
}
