import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
const OBSERVATION_TIMEOUT_MS = 1000;

// XEP-0198 §§4–6: real enable/ack exchange, including the stream error wire shape.
test.each([
  ['h="2"', "undefined-condition"],
  ['h="-1"', "bad-format"],
  ["", "bad-format"],
])(
  "invalid SM acknowledgement %s produces %s before closing",
  async (attribute, condition) => {
    let answered = false;
    const observed = Promise.withResolvers<void>();
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open")) {
        remote.send(
          '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="example.test" version="1.0" id="stream"/>',
        );
        remote.send(
          '<features xmlns="http://etherx.jabber.org/streams"><sm xmlns="urn:xmpp:sm:3"/></features>',
        );
      } else if (frame.startsWith("<enable")) {
        remote.send(
          '<enabled xmlns="urn:xmpp:sm:3" id="session" resume="true"/>',
        );
      } else if (frame.startsWith("<r ") && !answered) {
        answered = true;
        remote.send(`<a xmlns="urn:xmpp:sm:3" ${attribute}/>`);
      } else if (frame.startsWith("<stream:error")) {
        observed.resolve();
      } else if (frame.startsWith("<close")) {
        remote.send('<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>');
      }
    });
    const xmpp = client({ service: peer.url, domain: "example.test" });
    xmpp.reconnect.stop();
    xmpp.streamManagement.requestAckInterval = 1;
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => {
      errors.push(error);
      observed.resolve();
    });
    try {
      await xmpp.connect(peer.url);
      await xmpp.open({ domain: "example.test" });
      // A bounded observation also lets silently ignored malformed h fail an assertion.
      await Promise.race([observed.promise, Bun.sleep(OBSERVATION_TIMEOUT_MS)]);
      const error = peer.transcript.find((frame) =>
        frame.startsWith("<stream:error"),
      );
      expect(error).toBeDefined();
      expect(error).toContain(
        `<${condition} xmlns="urn:ietf:params:xml:ns:xmpp-streams"/>`,
      );
      if (condition === "undefined-condition") {
        expect(error).toContain(
          '<handled-count-too-high xmlns="urn:xmpp:sm:3" h="2" send-count="0"/>',
        );
      }
      expect(errors).toEqual([]);
      await peer.waitForClose();
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
