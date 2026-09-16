import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";

const OPEN =
  '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="example.test" version="1.0" id="session"/>';
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
const FEATURES =
  '<features xmlns="http://etherx.jabber.org/streams"><mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms></features>';
const NEGOTIATION_TIMEOUT_MS = 100;

// RFC 6120 §§4.4, 4.6 and 6. The deadline is local policy, not an RFC duration.
test.each(["silent", "disconnect"])(
  "SASL %s peer rejects start without leaving negotiation listeners",
  async (mode) => {
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open")) {
        remote.send(OPEN);
        remote.send(FEATURES);
      } else if (frame.startsWith("<auth") && mode === "disconnect") {
        remote.terminate();
      } else if (frame.startsWith("<close")) {
        remote.send(CLOSE);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      timeout: NEGOTIATION_TIMEOUT_MS,
      credentials: async (
        authenticate: (credentials: object, mechanism: string) => Promise<void>,
      ) => {
        await authenticate({ username: "user", password: "secret" }, "PLAIN");
      },
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    const baseline = xmpp.listenerCount("nonza");
    try {
      const result = await xmpp.start().then(
        () => ({ name: "unexpected success" }),
        (error: Error) => error,
      );
      expect(result.name).toBe(mode === "silent" ? "TimeoutError" : "Error");
      expect(peer.transcript.some((frame) => frame.startsWith("<auth"))).toBe(
        true,
      );
      expect(xmpp.listenerCount("nonza")).toBe(baseline);
      expect(errors.map((error) => error.name)).toEqual(
        mode === "silent" ? ["TimeoutError"] : [],
      );
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
