import { expect } from "bun:test";
import { client } from "../../src/client/index.js";
import type { Disco, DiscoOptions } from "../../types/index.js";
import { ScriptedPeer } from "../peer.ts";
import { readFrame } from "../xml.ts";

// XEP-0030 v2.5.0 (2024-04-30). Wire requirements and approved local registry
// policy are distinguished below; this is a connected client, not an account server.
export const INFO = "http://jabber.org/protocol/disco#info";
export const ITEMS = "http://jabber.org/protocol/disco#items";
export const PING = "urn:xmpp:ping";
export const CONTENT = "jabber:client";
export const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
export const STREAM = "http://etherx.jabber.org/streams";
export const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
export const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
export const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
export const FULL_JID = "user@example.test/client";
export const TARGET = "peer@example.test/resource";
export const NODE = " opaque://Node/%2f #A ";
export const TIMEOUT_MS = 300;
export const IDENTITY = { category: "client", type: "web", name: "Example" };
export const IDENTITY_XML =
  '<identity category="client" type="web" name="Example"/>';
export const FEATURE_XML = `<feature var="${INFO}"/>`;
export const DEFAULT_INFO = `<query xmlns="${INFO}">${IDENTITY_XML}${FEATURE_XML}</query>`;

export function discovery(xmpp: ReturnType<typeof client>): Disco {
  // Missing implementation must fail an assertion, not a property-access crash.
  expect(xmpp).toHaveProperty("disco");
  return xmpp.disco;
}

export async function nextIq(peer: ScriptedPeer, id?: string) {
  for (;;) {
    const frame = await peer.next();
    const root = readFrame(frame)[0];
    if (
      "open" in root &&
      root.open === `{${CONTENT}}iq` &&
      (id === undefined || root.attributes["{}id"] === id)
    ) {
      return frame;
    }
  }
}

export async function session(
  exercise: (
    xmpp: ReturnType<typeof client>,
    peer: ScriptedPeer,
  ) => Promise<void>,
  options?: DiscoOptions,
  reply?: (frame: string, peer: ScriptedPeer) => void,
) {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const events = readFrame(frame);
    const root = events[0];
    if (!("open" in root)) {
      throw new Error("Expected client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="${authenticated ? "bound" : "initial"}"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      events.some((event) => "open" in event && event.open === `{${BIND}}bind`)
    ) {
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${FULL_JID}</jid></bind></iq>`,
      );
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    } else {
      reply?.(frame, remote);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
    ...(options ? { disco: options } : {}),
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    expect(String(await xmpp.start())).toBe(FULL_JID);
    expect(readFrame(await nextIq(peer))).toContainEqual({
      open: `{${BIND}}bind`,
      attributes: {},
    });
    await exercise(xmpp, peer);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
}

export function resultReply(payload: string) {
  return (frame: string, peer: ScriptedPeer) => {
    const root = readFrame(frame)[0];
    if (
      "open" in root &&
      root.open === `{${CONTENT}}iq` &&
      root.attributes["{}type"] === "get"
    ) {
      const from = root.attributes["{}to"];
      peer.send(
        `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"${from ? ` from="${from}"` : ""}>${payload}</iq>`,
      );
    }
  };
}

export async function incoming(
  peer: ScriptedPeer,
  namespace: string,
  node?: string,
  type = "get",
) {
  peer.send(
    `<iq xmlns="${CONTENT}" type="${type}" id="discovery" from="${TARGET}" to="${FULL_JID}"><query xmlns="${namespace}"${node === undefined ? "" : ` node="${node}"`}/></iq>`,
  );
  return readFrame(await nextIq(peer, "discovery"));
}
