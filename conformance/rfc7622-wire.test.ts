import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const QUERY = "urn:test:iq";

// RFC 7622 §4: preparation in protocol slots, not only standalone JID objects.
test("RFC 7622 prepares outgoing addresses and correlates Unicode wire identities", async () => {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    if (frame.startsWith("<open")) {
      remote.send(
        `<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="bücher.example" version="1.0" id="unicode-${authenticated ? "bound" : "initial"}"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (frame.startsWith("<auth ")) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (frame.startsWith("<iq")) {
      const root = readFrame(frame)[0];
      if (!root || !("open" in root)) {
        throw new Error("Expected an IQ");
      }
      if (root.attributes["{}id"] !== "unicode") {
        remote.send(
          `<iq xmlns="jabber:client" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@bücher.example/r</jid></bind></iq>`,
        );
        return;
      }
      remote.send(
        '<iq xmlns="jabber:client" id="unicode" type="result" from="@remote"><bad/></iq>',
      );
      remote.send(
        '<iq xmlns="jabber:client" id="unicode" type="result" from="attacker@example.test"><bad/></iq>',
      );
      remote.send(
        '<iq xmlns="jabber:client" id="unicode" type="result" from="e&#x301;@xn--bcher-kva.example/Re&#x301;s"><verified/></iq>',
      );
    } else if (frame.startsWith("<close")) {
      remote.send('<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>');
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "XN--BCHER-KVA.example.",
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    expect((await xmpp.start()).toString()).toBe("user@bücher.example/r");
    expect(peer.transcript[0]).toContain('to="bücher.example"');
    const result = await xmpp.iqCaller
      .request(
        xml(
          "iq",
          {
            id: "unicode",
            type: "get",
            to: "E\u0301@xn--bcher-kva.example/Re\u0301s",
          },
          xml("query", QUERY),
        ),
        500,
      )
      .catch((error: Error) => error);
    expect(result.getChild?.("verified")).toBeDefined();
    expect(
      peer.transcript.find((frame) => frame.includes('id="unicode"')),
    ).toContain('to="é@bücher.example/Rés"');
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});
