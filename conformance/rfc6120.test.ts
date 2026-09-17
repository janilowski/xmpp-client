import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import xml from "../src/xml/index.js";
import { ScriptedPeer } from "./peer.ts";

const OPEN =
  '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="example.test" version="1.0" id="session"/>';
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
const FEATURES =
  '<features xmlns="http://etherx.jabber.org/streams"><mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms></features>';
const NEGOTIATION_TIMEOUT_MS = 100;

// RFC 6120 §§8.1.2.1, 8.2.3, 8.3.1: sender correlation is our security policy
// derived from addressing/reply rules, not a verbatim RFC matching algorithm.
test.each(["result", "error"])(
  "IQ ignores a forged %s before the authentic wire reply",
  async (type) => {
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open")) {
        remote.send(OPEN);
      } else if (frame.startsWith("<iq")) {
        remote.send(
          `<iq xmlns="jabber:client" id="sender-check" type="${type}" from="attacker.example"><error type="cancel"><service-unavailable xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>`,
        );
        remote.send(
          '<iq xmlns="jabber:client" id="sender-check" type="result" from="expected.example"><verified xmlns="urn:test:reply"/></iq>',
        );
      } else if (frame.startsWith("<close")) {
        remote.send(CLOSE);
      }
    });
    const xmpp = client({ service: peer.url, domain: "example.test" });
    xmpp.reconnect.stop();
    try {
      await xmpp.connect(peer.url);
      await xmpp.open({ domain: "example.test" });
      const reply = await xmpp.iqCaller
        .request(
          xml(
            "iq",
            {
              type: "get",
              id: "sender-check",
              to: "expected.example",
            },
            xml("query", { xmlns: "urn:test:reply" }),
          ),
        )
        .catch((error: Error) => error);
      expect(reply.attrs?.from).toBe("expected.example");
      expect(reply.getChild("verified", "urn:test:reply")).toBeDefined();
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

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
