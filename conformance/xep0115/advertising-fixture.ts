import { expect } from "bun:test";
import { client } from "../../src/client/index.js";
import { ScriptedPeer } from "../peer.ts";
import { readFrame } from "../xml.ts";

export const CAPS = "http://jabber.org/protocol/caps";
export const INFO = "http://jabber.org/protocol/disco#info";
export const ITEMS = "http://jabber.org/protocol/disco#items";
export const PING = "urn:xmpp:ping";
export const CONTENT = "jabber:client";
export const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
export const NODE = "https://example.test/app";
export const FULL_JID = "user@example.test/client";
export const TARGET = "contact@example.test/device";
export const IDENTITY = { category: "client", type: "web", name: "Example" };
export const FEATURES = [CAPS, INFO, ITEMS, PING];
// Independent node:crypto SHA-1 over literal §5.1 canonical strings; not our verifier.
export const INITIAL_SHA1 = "tjB+cZ9oy2RdUNdIjVGv8mClG6Y=";
export const EXTRA_SHA1 = "LWgoB96IFB1lkIr5uunevzQzdGg=";
export const CHANGED_SHA1 = "4iJGXmlIAfVn1AGskisQ7TUjek0=";
export const LANGUAGES_SHA1 = "cA1ZZPR0t91jSxlLq+wjUGdeOt0=";

export async function nextFrame(peer: ScriptedPeer, name: string, id?: string) {
  for (;;) {
    const frame = await peer.next();
    const root = readFrame(frame)[0];
    if (
      "open" in root &&
      root.open === `{${CONTENT}}${name}` &&
      (id === undefined || root.attributes["{}id"] === id)
    ) {
      return frame;
    }
  }
}

export function annotation(source: string) {
  const found = readFrame(source).filter(
    (event) => "open" in event && event.open === `{${CAPS}}c`,
  );
  expect(found).toHaveLength(1);
  const event = found[0];
  expect("open" in event).toBe(true);
  if (!("open" in event)) {
    throw new Error("Expected caps element");
  }
  return event.attributes;
}

export async function query(
  peer: ScriptedPeer,
  namespace: string,
  node?: string,
  lang?: string,
) {
  const id = "advertiser-query";
  peer.send(
    `<iq xmlns="${CONTENT}" from="${TARGET}" to="${FULL_JID}" type="get" id="${id}"${lang ? ` xml:lang="${lang}"` : ""}><query xmlns="${namespace}"${node === undefined ? "" : ` node="${node}"`}/></iq>`,
  );
  return readFrame(await nextFrame(peer, "iq", id));
}

export async function session(
  exercise: (
    xmpp: ReturnType<typeof client>,
    peer: ScriptedPeer,
  ) => Promise<void>,
  options: Record<string, unknown> = {},
  sm = false,
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
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="advertising"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>${sm ? `<sm xmlns="${SM}"/>` : ""}` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
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
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: 500,
    disco: { identities: [IDENTITY] },
    caps: { node: NODE },
    ...options,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  const enabled = Promise.withResolvers<void>();
  xmpp.on(
    "nonza",
    (element: { is(name: string, namespace: string): boolean }) => {
      if (element.is("enabled", SM)) {
        enabled.resolve();
      }
    },
  );
  try {
    if (options.caps !== undefined || !("caps" in options)) {
      expect(xmpp).toHaveProperty("caps");
      expect(xmpp).toHaveProperty("caps.get", expect.any(Function));
    }
    expect(String(await xmpp.start())).toBe(FULL_JID);
    await nextFrame(peer, "iq");
    if (sm) {
      await enabled.promise;
      // The nonza event precedes async middleware. A reciprocal SM exchange
      // proves the negotiated state was installed before exercising admission.
      peer.send(`<r xmlns="${SM}"/>`);
      for (;;) {
        const root = readFrame(await peer.next())[0];
        if ("open" in root && root.open === `{${SM}}a`) {
          expect(root.attributes["{}h"]).toBe("0");
          break;
        }
      }
      expect(xmpp.streamManagement.enabled).toBe(true);
    }
    await exercise(xmpp, peer);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
}
