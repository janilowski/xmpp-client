import { afterEach, describe, expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const OPEN =
  '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="example.test" version="1.0" id="peer-1"/>';
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
const CLIENT_OPEN =
  '<open version="1.0" xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="example.test" xml:lang="en"/>';
const CLIENT_OPTIONS = { domain: "example.test", lang: "en" };

let peer: ScriptedPeer;
let xmpp: ReturnType<typeof client>;
let errors: Error[] = [];

// Exercise the public client, but stop before authentication unless a scenario needs it.
async function openStream() {
  peer = new ScriptedPeer((frame, remote) => {
    const [root] = readFrame(frame);
    if (
      root &&
      "open" in root &&
      root.open === "{urn:ietf:params:xml:ns:xmpp-framing}open"
    ) {
      remote.send(OPEN);
    }
    if (
      root &&
      "open" in root &&
      root.open === "{urn:ietf:params:xml:ns:xmpp-framing}close"
    ) {
      remote.send(CLOSE);
    }
  });
  errors = [];
  xmpp = client({ ...CLIENT_OPTIONS, service: peer.url });
  xmpp.reconnect.stop();
  xmpp.on("error", (error: Error) => errors.push(error));
  await xmpp.connect(peer.url);
  await xmpp.open(CLIENT_OPTIONS);
}

afterEach(async () => {
  try {
    if (xmpp && xmpp.status !== "offline") {
      await xmpp.stop();
    }
  } finally {
    if (peer) {
      await peer.stop();
    }
  }
  expect(errors).toEqual([]);
  if (peer) {
    expect(peer.errors).toEqual([]);
  }
});

describe("RFC 7395 — client wire behavior", () => {
  test("§3.1 offers xmpp in the HTTP upgrade", async () => {
    await openStream();
    expect(peer.requests).toHaveLength(1);
    expect(
      peer.requests[0].get("sec-websocket-protocol")?.split(/\s*,\s*/),
    ).toContain("xmpp");
  });

  test("§3.3.2/3.4 first message is a standalone framing open", async () => {
    await openStream();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLIENT_OPEN));
    expect(peer.transcript).toHaveLength(1);
  });

  test("§3.2/3.3.3 sends UTF-8 text with independent stanza namespaces", async () => {
    await openStream();
    await peer.next();
    await xmpp.send(xml("message", {}, xml("body", {}, "Zażółć 🐦 & < >")));
    expect(readFrame(await peer.next())).toEqual(
      readFrame(
        '<message xmlns="jabber:client"><body>Zażółć 🐦 &amp; &lt; &gt;</body></message>',
      ),
    );
  });

  test("§3.3.3 sendMany uses one message per stanza", async () => {
    await openStream();
    await peer.next();
    await xmpp.sendMany([xml("presence"), xml("message", { id: "second" })]);
    expect(readFrame(await peer.next())).toEqual(
      readFrame('<presence xmlns="jabber:client"/>'),
    );
    expect(readFrame(await peer.next())).toEqual(
      readFrame('<message id="second" xmlns="jabber:client"/>'),
    );
    expect(peer.transcript).toHaveLength(3);
  });

  test("§3.7 restart opens a new stream without a close frame", async () => {
    await openStream();
    await peer.next();
    await xmpp.restart();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLIENT_OPEN));
    expect(peer.transcript.map(readFrame)).toEqual([
      readFrame(CLIENT_OPEN),
      readFrame(CLIENT_OPEN),
    ]);
  });

  test("§3.6 closes the XMPP stream before the WebSocket", async () => {
    await openStream();
    await peer.next();
    const statuses: string[] = [];
    xmpp.on("status", (status: string) => statuses.push(status));
    await xmpp.stop();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    expect(statuses).toEqual([
      "closing",
      "close",
      "disconnecting",
      "disconnect",
      "offline",
    ]);
  });
});
