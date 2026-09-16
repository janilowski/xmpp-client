import { afterEach, describe, expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";
import { once } from "node:events";

const OPEN =
  '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="example.test" version="1.0" id="peer-1"/>';
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
const CLIENT_OPEN =
  '<open version="1.0" xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="example.test" xml:lang="en"/>';
const CLIENT_OPTIONS = { domain: "example.test", lang: "en" };
const CLOSE_TIMEOUT_MS = 250;
const EVENT_TIMEOUT_MS = 2000;

let peer: ScriptedPeer;
let xmpp: ReturnType<typeof client>;
let errors: Error[] = [];
let expectedErrors: string[] = [];

// Exercise the public client, but stop before authentication unless a scenario needs it.
async function openStream({
  closeReply = "reply",
  serverOpen = OPEN,
  establishment = "open",
  onFrame = undefined as
    ((frame: string, remote: ScriptedPeer) => void) | undefined,
  credentials = undefined as { username: string; password: string } | undefined,
} = {}) {
  peer = new ScriptedPeer((frame, remote) => {
    const [root] = readFrame(frame);
    if (
      root &&
      "open" in root &&
      root.open === "{urn:ietf:params:xml:ns:xmpp-framing}open"
    ) {
      if (serverOpen) {
        remote.send(serverOpen);
      }
    }
    if (
      root &&
      "open" in root &&
      root.open === "{urn:ietf:params:xml:ns:xmpp-framing}close"
    ) {
      if (closeReply === "reply") {
        remote.send(CLOSE);
      }
    }
    onFrame?.(frame, remote);
  });
  errors = [];
  expectedErrors = [];
  xmpp = client({
    ...CLIENT_OPTIONS,
    service: peer.url,
    timeout: CLOSE_TIMEOUT_MS,
    credentials,
  });
  xmpp.reconnect.stop();
  xmpp.on("error", (error: Error) => errors.push(error));
  if (establishment === "online") {
    await xmpp.start();
  } else {
    await xmpp.connect(peer.url);
    await xmpp.open(CLIENT_OPTIONS);
  }
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
  expect(errors.map((error) => error.message)).toEqual(expectedErrors);
  if (peer) {
    expect(peer.errors).toEqual([]);
  }
});

describe("RFC 7395 — client wire behavior", () => {
  test("§3.4 peer close during initiation rejects start without a timeout", async () => {
    const result = await openStream({
      serverOpen: CLOSE,
      establishment: "online",
    }).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message: expect.stringMatching(/closed before (open|online)/),
    });
    await peer.waitForClose();
  });

  test("§3.6 transport loss during initiation rejects start", async () => {
    const result = await openStream({
      serverOpen: "",
      establishment: "online",
      onFrame(_frame, remote) {
        remote.terminate();
      },
    }).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message: expect.stringMatching(/closed before (open|online)/),
    });
  });
  test("§3.7/3.9 ignores STARTTLS, authenticates and restarts after SASL success", async () => {
    let opens = 0;
    const online = Promise.withResolvers<unknown>();
    await openStream({
      credentials: { username: "user", password: "secret" },
      onFrame(frame, remote) {
        const [root] = readFrame(frame);
        if (!root || !("open" in root)) {
          return;
        }
        if (root.open === "{urn:ietf:params:xml:ns:xmpp-framing}open") {
          opens += 1;
          if (opens === 1) {
            xmpp.once("online", online.resolve);
            remote.send(
              '<features xmlns="http://etherx.jabber.org/streams"><starttls xmlns="urn:ietf:params:xml:ns:xmpp-tls"><required/></starttls><mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms></features>',
            );
          } else {
            remote.send(
              '<features xmlns="http://etherx.jabber.org/streams"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/></features>',
            );
          }
        } else if (root.open === "{urn:ietf:params:xml:ns:xmpp-sasl}auth") {
          remote.send('<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>');
        } else if (root.open === "{jabber:client}iq") {
          remote.send(
            `<iq xmlns="jabber:client" type="result" id="${root.attributes["{}id"]}"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>user@example.test/test</jid></bind></iq>`,
          );
        }
      },
    });
    // Four peer frames are an explicit progress barrier; silence fails in next().
    const sent = [];
    for (let index = 0; index < 4; index += 1) {
      sent.push(readFrame(await peer.next())[0]);
    }
    const address = await online.promise;
    expect(String(address)).toBe("user@example.test/test");
    expect(opens).toBe(2);
    expect(
      sent.map((frame) => (frame && "open" in frame ? frame.open : null)),
    ).toEqual([
      "{urn:ietf:params:xml:ns:xmpp-framing}open",
      "{urn:ietf:params:xml:ns:xmpp-sasl}auth",
      "{urn:ietf:params:xml:ns:xmpp-framing}open",
      "{jabber:client}iq",
    ]);
  });

  test("§3.6 abrupt transport loss disconnects the stream", async () => {
    await openStream();
    const disconnected = once(xmpp, "disconnect", {
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    peer.terminate();
    await disconnected;
    expect(xmpp.status).toBe("disconnect");
  });
  test("§3.3.2 invalid framing namespace produces a standalone stream error and close", async () => {
    await openStream();
    await peer.next();
    expectedErrors = ["Invalid framing namespace"];
    peer.send('<close xmlns="urn:wrong"/>');
    expect(readFrame(await peer.next())).toEqual(
      readFrame(
        '<stream:error xmlns:stream="http://etherx.jabber.org/streams"><invalid-namespace xmlns="urn:ietf:params:xml:ns:xmpp-streams"/></stream:error>',
      ),
    );
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
  });

  test("§3.2 binary frames close the transport without delivering a stanza", async () => {
    await openStream();
    const stanzas: unknown[] = [];
    xmpp.on("stanza", (stanza: unknown) => stanzas.push(stanza));
    expectedErrors = ["XMPP requires WebSocket text messages"];
    peer.send(new TextEncoder().encode('<message xmlns="jabber:client"/>'));
    await peer.waitForClose();
    expect(stanzas).toEqual([]);
  });

  test("§3.6 responds to peer close and completes the transport handshake", async () => {
    await openStream();
    await peer.next();
    peer.send(CLOSE);
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
    expect(xmpp.status).toBe("disconnect");
  });

  test("§3.6 missing close reply has a bounded transport shutdown", async () => {
    await openStream({ closeReply: "omit" });
    await peer.next();
    await xmpp.stop();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
    expect(xmpp.status).toBe("offline");
  });

  test("§3.6 sendMany cannot bypass the closing stream", async () => {
    await openStream({ closeReply: "omit" });
    await peer.next();
    const stopped = xmpp.stop();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    const result = await xmpp
      .sendMany([xml("message")])
      .catch((error: Error) => error);
    await stopped;
    expect(result).toBeInstanceOf(Error);
    expect(peer.transcript).toHaveLength(2);
  });

  test("§3.4 a second open cannot multiplex an existing stream", async () => {
    await openStream();
    const result = await xmpp
      .open(CLIENT_OPTIONS)
      .catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(peer.transcript).toHaveLength(1);
  });

  test("§3.6.1 a peer redirect is not followed implicitly", async () => {
    await openStream();
    await peer.next();
    peer.send(
      '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing" see-other-uri="ws://attacker.invalid/xmpp"/>',
    );
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
    expect(peer.requests).toHaveLength(1);
  });

  test("§3.5 fatal stream errors are delivered and followed by stream closure", async () => {
    await openStream();
    await peer.next();
    expectedErrors = ["policy-violation"];
    peer.send(
      '<stream:error xmlns:stream="http://etherx.jabber.org/streams"><policy-violation xmlns="urn:ietf:params:xml:ns:xmpp-streams"/></stream:error>',
    );
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
    expect(errors).toHaveLength(1);
  });
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
