import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const MECHANISM = "TEST-BASE64";
const TIMEOUT_MS = 500;

// RFC 6120 §13.9.1, RFC 4648 §4; also exercise the shared SASL2 encoding.
// A mechanism with no final hook must not bypass transport-level validation.
for (const ns of [SASL, SASL2]) {
  for (const stage of ["challenge", "success", "success-without-hook"]) {
    test.each([" Zg==", "Zh=="])(
      `${ns} / ${stage}: rejects invalid Base64 %j`,
      async (data) => {
        let opens = 0;
        let delivered = 0;
        const peer = new ScriptedPeer((frame, remote) => {
          if (frame.startsWith("<open")) {
            if (++opens > 1) {
              remote.terminate();
              return;
            }
            remote.send(
              `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="session"/>`,
            );
            const feature = ns === SASL ? "mechanisms" : "authentication";
            remote.send(
              `<features xmlns="${STREAM}"><${feature} xmlns="${ns}"><mechanism>${MECHANISM}</mechanism></${feature}></features>`,
            );
          } else if (frame.startsWith("<auth")) {
            remote.send(
              stage === "challenge"
                ? `<challenge xmlns="${ns}">${data}</challenge>`
                : `<success xmlns="${ns}">${ns === SASL ? data : `<additional-data>${data}</additional-data>`}</success>`,
            );
            if (ns === SASL2 && stage !== "challenge") {
              // Bound an implementation that accepts success but has no binding.
              remote.send(`<close xmlns="${FRAMING}"/>`);
            }
          } else if (frame.startsWith("<response")) {
            remote.send(`<failure xmlns="${ns}"><not-authorized/></failure>`);
          } else if (frame.startsWith("<close")) {
            remote.send(`<close xmlns="${FRAMING}"/>`);
          }
        });
        const xmpp = client({
          service: peer.url,
          domain: "example.test",
          timeout: TIMEOUT_MS,
          credentials: async (
            authenticate: (
              credentials: object,
              mechanism: string,
            ) => Promise<void>,
          ) => {
            await authenticate({}, MECHANISM);
          },
        });
        xmpp.saslMechanisms.register(MECHANISM, () => ({
          name: MECHANISM,
          clientFirst: true,
          binary: true,
          response: () => "",
          challenge: () => {
            delivered++;
          },
          ...(stage === "success-without-hook"
            ? {}
            : {
                final: () => {
                  delivered++;
                },
              }),
        }));
        xmpp.reconnect.stop();
        xmpp.on("error", () => {});
        try {
          const result = await xmpp.start().then(
            () => null,
            (error: Error) => error,
          );
          expect(delivered).toBe(0);
          expect(result?.message).toContain("Base64");
          expect(opens).toBe(1);
          expect(
            peer.transcript.some(
              (frame) =>
                frame.startsWith("<response") || frame.startsWith("<iq"),
            ),
          ).toBe(false);
          expect(peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await peer.stop();
        }
      },
    );
  }
}
