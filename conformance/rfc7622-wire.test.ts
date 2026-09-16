import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";

// RFC 7622 §4: preparation in protocol slots, not only standalone JID objects.
test("RFC 7622 prepares outgoing addresses and correlates Unicode wire identities", async () => {
  const peer = new ScriptedPeer((frame, remote) => {
    if (frame.startsWith("<open")) {
      remote.send(
        '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="bücher.example" version="1.0" id="unicode"/>',
      );
    } else if (frame.startsWith("<iq")) {
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
  const xmpp = client({ service: peer.url, domain: "XN--BCHER-KVA.example." });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    await xmpp.connect(peer.url);
    await xmpp.open(xmpp.options);
    expect(await peer.next()).toContain('to="bücher.example"');
    const result = await xmpp.iqCaller
      .request(
        xml("iq", {
          id: "unicode",
          type: "get",
          to: "E\u0301@xn--bcher-kva.example/Re\u0301s",
        }),
        500,
      )
      .catch((error: Error) => error);
    expect(result.getChild?.("verified")).toBeDefined();
    expect(await peer.next()).toContain('to="é@bücher.example/Rés"');
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});
