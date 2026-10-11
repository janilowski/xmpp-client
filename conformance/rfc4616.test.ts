import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const TIMEOUT_MS = 500;

const INVALID_CREDENTIALS = [
  ["empty authentication identity", { username: "", password: "secret" }],
  ["empty password", { username: "user", password: "" }],
  ["NUL in authentication identity", {
    username: "user\0admin",
    password: "secret",
  }],
  ["NUL in password", { username: "user", password: "sec\0ret" }],
  ["invalid authentication identity Unicode", {
    username: "user\uD800",
    password: "secret",
  }],
  ["invalid password Unicode", {
    username: "user",
    password: "sec\uD800ret",
  }],
] as const;

test.each([SASL, SASL2])(
  "RFC 4616 §2: %s rejects malformed PLAIN credentials before sending",
  async (namespace) => {
    for (const [name, credentials] of INVALID_CREDENTIALS) {
      const peer = new ScriptedPeer((frame, remote) => {
        if (frame.startsWith("<open")) {
          remote.send(
            `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="session"/>`,
          );
          remote.send(
            namespace === SASL
              ? `<features xmlns="${STREAM}"><mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms></features>`
              : `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism></authentication></features>`,
          );
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
          await authenticate(credentials, "PLAIN");
        },
      });
      xmpp.reconnect.stop();
      xmpp.on("error", () => {});
      try {
        await expect(xmpp.start()).rejects.toThrow("PLAIN: invalid credentials");
        expect(
          peer.transcript.some(
            (frame) =>
              frame.startsWith("<auth") || frame.startsWith("<authenticate"),
          ),
          name,
        ).toBe(false);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    }
  },
);
