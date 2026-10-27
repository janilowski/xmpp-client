import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const CONTENT = "jabber:client";
const TIMEOUT_MS = 1000;
const SESSION_ID = "opaque-session";
const RESUME_CASES = [
  ["absent", "", "fresh", SESSION_ID],
  ["false", 'resume="false"', "fresh", SESSION_ID],
  ["zero", 'resume="0"', "fresh", SESSION_ID],
  ["empty boolean", 'resume=""', "fresh", SESSION_ID],
  ["invalid boolean", 'resume="2"', "fresh", SESSION_ID],
  ["wrong case", 'resume="TRUE"', "fresh", SESSION_ID],
  ["non-XML whitespace", 'resume="&#xA0;true"', "fresh", SESSION_ID],
  ["true", 'resume="true"', "resumed", SESSION_ID],
  ["one", 'resume="1"', "resumed", SESSION_ID],
  ["XML whitespace", 'resume="&#x9;1&#xA;"', "resumed", SESSION_ID],
  ["empty ID / true", 'resume="true"', "resumed", ""],
  ["empty ID / one", 'resume="1"', "resumed", ""],
  ["empty ID / replay", 'resume="true"', "resumed", ""],
  ["missing ID / true", 'resume="true"', "fresh", undefined],
  ["missing ID / one", 'resume="1"', "fresh", undefined],
] as const;

type Mode = "ordinary" | "inline";

// XEP-0198 v1.6.3 §§3,5,9.1–9.2 and note 5: ID alone never grants
// resumption. Acknowledgements remain enabled when resumption is declined.
// Malformed permission/missing ID cases use local policy: never grant resumption.
for (const initial of ["ordinary", "inline"] as const) {
  for (const reconnect of ["ordinary", "inline"] as const) {
    test.each(RESUME_CASES)(
      `XEP-0198 §§3,5,9: ${initial} enable / ${reconnect} reconnect / %s`,
      async (label, permission, expected, id) => {
        const queued = id !== "" || label === "empty ID / replay";
        const firstEnabled = Promise.withResolvers<void>();
        const ready = Promise.withResolvers<"ready" | "closed" | "timeout">();
        const handled = Promise.withResolvers<void>();
        let received = false;
        let replacing = false;

        function makePeer(mode: Mode, stage: "initial" | "replacement") {
          let authenticated = false;
          const enabled =
            stage === "initial"
              ? `<enabled xmlns="${SM}" ${id === undefined ? "" : `id="${id}"`} ${permission}/>`
              : `<enabled xmlns="${SM}"/>`;
          return new ScriptedPeer((frame, peer) => {
            const element = readFrame(frame)[0];
            if (!element || !("open" in element)) {
              throw new Error("Expected a client element");
            }
            if (element.open === `{${FRAMING}}open`) {
              peer.send(
                `<open xmlns="${FRAMING}" from="example.test" id="stream" version="1.0"/>`,
              );
              const features =
                mode === "inline"
                  ? `<authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><inline><sm xmlns="${SM}"/><bind xmlns="${BIND2}"><inline><feature var="${SM}"/></inline></bind></inline></authentication>`
                  : authenticated
                    ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>`
                    : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`;
              peer.send(`<features xmlns="${STREAM}">${features}</features>`);
            } else if (element.open === `{${SASL}}auth`) {
              authenticated = true;
              peer.send(`<success xmlns="${SASL}"/>`);
            } else if (element.open === `{${SASL2}}authenticate`) {
              const resume = readFrame(frame).find(
                (item) => "open" in item && item.open === `{${SM}}resume`,
              );
              if (resume) {
                peer.send(
                  `<success xmlns="${SASL2}"><authorization-identifier>user@example.test/old</authorization-identifier><resumed xmlns="${SM}" previd="${id}" h="1"/></success>`,
                );
              } else {
                peer.send(
                  `<success xmlns="${SASL2}"><authorization-identifier>user@example.test/${stage === "initial" ? "old" : "new"}</authorization-identifier><bound xmlns="${BIND2}">${enabled}</bound></success>`,
                );
                peer.send(`<features xmlns="${STREAM}"/>`);
              }
            } else if (element.open === `{${SM}}resume`) {
              peer.send(`<resumed xmlns="${SM}" previd="${id}" h="1"/>`);
            } else if (element.open === `{${CONTENT}}iq`) {
              peer.send(
                `<iq xmlns="${CONTENT}" type="result" id="${element.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/${stage === "initial" ? "old" : "new"}</jid></bind></iq>`,
              );
            } else if (element.open === `{${SM}}enable`) {
              peer.send(enabled);
            } else if (
              element.open === `{${CONTENT}}message` &&
              element.attributes["{}id"] === "handled"
            ) {
              peer.send(`<a xmlns="${SM}" h="1"/>`);
            } else if (element.open === `{${SM}}a`) {
              received = element.attributes["{}h"] === "1";
            } else if (element.open === `{${FRAMING}}close`) {
              peer.send(`<close xmlns="${FRAMING}"/>`);
            }
          });
        }

        const first = makePeer(initial, "initial");
        const second = makePeer(reconnect, "replacement");
        const xmpp = client({
          service: first.url,
          domain: "example.test",
          username: "user",
          password: "secret",
          timeout: TIMEOUT_MS,
        });
        xmpp.reconnect.stop();
        xmpp.streamManagement.requestAckInterval = 0;
        const acks: string[] = [];
        const failures: string[] = [];
        const errors: Error[] = [];
        let resumed = 0;
        xmpp.streamManagement.on("ack", (stanza) => {
          acks.push(stanza.attrs.id);
          handled.resolve();
        });
        xmpp.streamManagement.on("fail", (stanza) =>
          failures.push(stanza.attrs.id),
        );
        xmpp.streamManagement.on("resumed", () => {
          resumed++;
          ready.resolve("ready");
        });
        xmpp.on("error", (error: Error) => {
          errors.push(error);
          ready.resolve("closed");
        });
        xmpp.on("close", () => ready.resolve("closed"));
        xmpp.on("nonza", (element) => {
          if (
            element.is("enabled", SM) ||
            (element.is("success", SASL2) && element.getChild("bound", BIND2))
          ) {
            if (!replacing) {
              firstEnabled.resolve();
            } else {
              ready.resolve("ready");
            }
          }
        });

        try {
          expect((await xmpp.start()).toString()).toBe("user@example.test/old");
          await firstEnabled.promise;
          await setImmediate();
          expect(xmpp.streamManagement.enabled).toBe(true);
          await xmpp.send(xml("message", { id: "handled" }));
          const ackDeadline = setTimeout(handled.resolve, TIMEOUT_MS);
          await handled.promise;
          clearTimeout(ackDeadline);
          expect(acks).toEqual(["handled"]);
          first.send(`<message xmlns="${CONTENT}" id="incoming"/>`);
          first.send(`<r xmlns="${SM}"/>`);
          while (!received) {
            await first.next();
          }
          expect(acks).toEqual(["handled"]);
          if (queued) {
            await xmpp.send(xml("message", { id: "unhandled" }));
            while (
              !first.transcript.some((frame) =>
                frame.includes('id="unhandled"'),
              )
            ) {
              await first.next();
            }
          }
          const disconnected = new Promise<void>((resolve) =>
            xmpp.once("disconnect", resolve),
          );
          first.terminate();
          await disconnected;
          replacing = true;
          Object.assign(xmpp.options, { service: second.url });
          await xmpp.reconnect.reconnect();
          const watchdog = setTimeout(
            () => ready.resolve("timeout"),
            TIMEOUT_MS,
          );
          const result = await ready.promise;
          clearTimeout(watchdog);
          await setImmediate();
          // FIFO delivery of this later frame proves replay reached the peer.
          await xmpp.send(xml("r", { xmlns: SM }));
          while (!second.transcript.some((frame) => frame.startsWith("<r "))) {
            await second.next();
          }

          const requests = second.transcript
            .flatMap(readFrame)
            .filter(
              (element) =>
                "open" in element && element.open === `{${SM}}resume`,
            );
          // A forbidden resume must fail here, even if a permissive peer accepts it.
          expect(requests.length).toBe(expected === "resumed" ? 1 : 0);
          expect(result).toBe("ready");
          expect(xmpp.jid?.toString()).toBe(
            `user@example.test/${expected === "resumed" ? "old" : "new"}`,
          );
          expect(resumed).toBe(expected === "resumed" ? 1 : 0);
          expect(failures).toEqual(
            expected === "fresh" && queued ? ["unhandled"] : [],
          );
          const messages = second.transcript
            .flatMap(readFrame)
            .filter(
              (element) =>
                "open" in element && element.open === `{${CONTENT}}message`,
            );
          expect(messages).toEqual(
            expected === "resumed" && queued
              ? [
                  {
                    open: `{${CONTENT}}message`,
                    attributes: { "{}id": "unhandled" },
                  },
                ]
              : [],
          );
          if (expected === "resumed") {
            expect(id).toBeDefined();
            expect(requests).toEqual([
              {
                open: `{${SM}}resume`,
                attributes: { "{}previd": id!, "{}h": "1" },
              },
            ]);
          }
          expect(acks).toEqual(["handled"]);
          await xmpp.stop();
          expect(failures).toEqual(queued ? ["unhandled"] : []);
          expect(errors).toEqual([]);
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
}
