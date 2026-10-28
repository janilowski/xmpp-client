import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const CONTENT = "jabber:client";
const SM = "urn:xmpp:sm:3";
const EXTENSION = "urn:test:address-lengths";
const DOMAIN = "example.test";
const TIMEOUT_MS = 1000;
const ACK_DEBOUNCE_MS = 60_000;
const MAX_PART_BYTES = 1023;
const MAX_JID_BYTES = 3071;
const MAX_LITERAL = `[v1.${"a".repeat(1018)}]`;
const encoder = new TextEncoder();
const SEND_METHODS = ["send", "sendMany"] as const;
const SLOTS = ["to", "from"] as const;
const KINDS = ["message", "presence", "iq"] as const;
const MATRIX = SEND_METHODS.flatMap((method) =>
  SLOTS.flatMap((slot) => KINDS.map((kind) => [method, slot, kind] as const)),
);

// RFC 7622 §§3.3–3.4 count prepared UTF-8 octets, not input bytes or code units.
// Expected mappings are literal NFC/lowercase vectors, independent of our JID API.
// Address limits apply to decoded attribute values, not escaped XML frame bytes.
const VALID_PARTS = [
  {
    name: "ASCII local",
    part: "local",
    raw: "A".repeat(1023),
    prepared: "a".repeat(1023),
  },
  {
    name: "multibyte local",
    part: "local",
    raw: `${"É".repeat(511)}a`,
    prepared: `${"é".repeat(511)}a`,
  },
  {
    name: "ASCII resource",
    part: "resource",
    raw: "R".repeat(1023),
    prepared: "R".repeat(1023),
  },
  {
    name: "supplementary resource",
    part: "resource",
    raw: `${"🙂".repeat(255)}abc`,
    prepared: `${"🙂".repeat(255)}abc`,
  },
  {
    name: "NFC-contracted local",
    part: "local",
    raw: `${"e\u0301".repeat(511)}a`,
    prepared: `${"é".repeat(511)}a`,
  },
  {
    name: "NFC-contracted resource",
    part: "resource",
    raw: `${"e\u0301".repeat(511)}a`,
    prepared: `${"é".repeat(511)}a`,
  },
  {
    name: "lowercase-expanded local",
    part: "local",
    raw: "İ".repeat(341),
    prepared: "i\u0307".repeat(341),
  },
  {
    name: "NFC-expanded resource",
    part: "resource",
    raw: `${"\u0344".repeat(255)}abc`,
    prepared: `${"\u0308\u0301".repeat(255)}abc`,
  },
] as const;
const VALID_ADDRESSES = [
  ...VALID_PARTS.map((boundary) => ({
    ...boundary,
    rawAddress:
      boundary.part === "local"
        ? `${boundary.raw}@${DOMAIN}/r`
        : `user@${DOMAIN}/${boundary.raw}`,
    preparedAddress:
      boundary.part === "local"
        ? `${boundary.prepared}@${DOMAIN}/r`
        : `user@${DOMAIN}/${boundary.prepared}`,
    domain: DOMAIN,
  })),
  {
    name: "IPvFuture domain and full 3071-octet JID",
    raw: MAX_LITERAL,
    prepared: MAX_LITERAL,
    rawAddress: `${"a".repeat(1023)}@${MAX_LITERAL}/${"r".repeat(1023)}`,
    preparedAddress: `${"a".repeat(1023)}@${MAX_LITERAL}/${"r".repeat(1023)}`,
    domain: MAX_LITERAL,
  },
  {
    name: "NFC-contracted full 3071-octet JID",
    raw: `${"e\u0301".repeat(511)}a`,
    prepared: `${"é".repeat(511)}a`,
    rawAddress: `${"e\u0301".repeat(511)}a@${MAX_LITERAL}/${"e\u0301".repeat(511)}a`,
    preparedAddress: `${"é".repeat(511)}a@${MAX_LITERAL}/${"é".repeat(511)}a`,
    domain: MAX_LITERAL,
  },
  {
    name: "width/space-mapped full 3071-octet JID",
    raw: "Ａ".repeat(1023),
    prepared: "a".repeat(1023),
    rawAddress: `${"Ａ".repeat(1023)}@${MAX_LITERAL}/${"\u2003".repeat(1023)}`,
    preparedAddress: `${"a".repeat(1023)}@${MAX_LITERAL}/${" ".repeat(1023)}`,
    domain: MAX_LITERAL,
  },
];
const INVALID_PARTS = [
  {
    name: "ASCII local",
    part: "local",
    raw: "a".repeat(1024),
    prepared: "a".repeat(1024),
  },
  {
    name: "multibyte local",
    part: "local",
    raw: "é".repeat(512),
    prepared: "é".repeat(512),
  },
  {
    name: "ASCII resource",
    part: "resource",
    raw: "r".repeat(1024),
    prepared: "r".repeat(1024),
  },
  {
    name: "supplementary resource",
    part: "resource",
    raw: "🙂".repeat(256),
    prepared: "🙂".repeat(256),
  },
  {
    name: "lowercase-expanded local",
    part: "local",
    raw: `${"İ".repeat(341)}a`,
    prepared: `${"i\u0307".repeat(341)}a`,
  },
  {
    name: "NFC-expanded resource",
    part: "resource",
    raw: "\u0344".repeat(256),
    prepared: "\u0308\u0301".repeat(256),
  },
  {
    name: "IPvFuture domain",
    part: "domain",
    raw: `[v1.${"a".repeat(1019)}]`,
    prepared: `[v1.${"a".repeat(1019)}]`,
  },
] as const;

// One authenticated and bound stream with explicit SM ACKs. The peer records
// literal frames and never interprets an application address or resolves DNS.
async function addressStream({
  boundJid = `user@${DOMAIN}/r`,
  domain = DOMAIN,
  maxStanzas = 1,
}: { boundJid?: string; domain?: string; maxStanzas?: number } = {}) {
  let authenticated = false;
  const frames: string[] = [];
  const barriers = new Map<string, () => void>();
  let sequence = 0;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an outgoing element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="${domain}" version="1.0" id="lengths"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      frame.includes(`<bind xmlns="${BIND}"`)
    ) {
      remote.send(
        `<iq xmlns="${CONTENT}" id="${root.attributes["{}id"]}" type="result"><bind xmlns="${BIND}"><jid>${boundJid}</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}"/>`);
    } else if (root.open === `{${EXTENSION}}barrier`) {
      remote.send(frame);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    } else if (root.open !== `{${SM}}a` && root.open !== `{${SM}}r`) {
      frames.push(frame);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain,
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
    streamManagement: { maxStanzas },
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  xmpp.streamManagement.requestAckDebounce = ACK_DEBOUNCE_MS;
  const errors: Error[] = [];
  const sent: string[] = [];
  const acks: string[] = [];
  const failures: string[] = [];
  const enabled = Promise.withResolvers<void>();
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.streamManagement.on("ack", (element: Element) =>
    acks.push(element.attrs.id),
  );
  xmpp.streamManagement.on("fail", (element: Element) =>
    failures.push(element.attrs.id),
  );
  xmpp.on("nonza", (element: Element) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    } else if (element.is("barrier", EXTENSION)) {
      barriers.get(element.attrs.id)?.();
    }
  });

  // A real round trip observes prior writes and finishes processing earlier ACKs.
  async function barrier() {
    const id = String(sequence++);
    const observed = Promise.withResolvers<void>();
    barriers.set(id, observed.resolve);
    const watchdog = setTimeout(
      () => observed.reject(new Error("Missing address barrier")),
      TIMEOUT_MS,
    );
    try {
      await xmpp.send(xml("barrier", { xmlns: EXTENSION, id }));
      await observed.promise;
    } finally {
      clearTimeout(watchdog);
      barriers.delete(id);
    }
  }

  try {
    expect(String(await xmpp.start())).toBe(boundJid);
    await enabled.promise;
    await barrier();
    expect(xmpp.streamManagement.enabled).toBe(true);
    xmpp.on("send", (element: Element) => {
      if (KINDS.some((kind) => element.is(kind, CONTENT))) {
        sent.push(element.attrs.id);
      }
    });
    return { xmpp, peer, frames, sent, acks, failures, errors, barrier };
  } catch (error) {
    await xmpp.stop();
    await peer.stop();
    throw error;
  }
}

// RFC 7622 §4 recommends preparation by clients; this library deliberately
// enforces invalid core JID slots locally, before XML or SM admission.
// RFC 7622 §§3.1–3.2 and RFC 9844 §3 retain RFC 3986 IPvFuture syntax.
// These literal domains test address grammar, not DNS or host reachability.
for (const boundary of VALID_ADDRESSES) {
  test.each(MATRIX)(
    `RFC 7622 §§3.1–3.4/4: accept 1023 prepared octets / ${boundary.name} / %s %s %s`,
    async (method, slot, kind) => {
      const prepared = boundary.preparedAddress;
      // Legitimate positive from slots identify the literal bound identity.
      const { xmpp, peer, frames, sent, acks, failures, errors, barrier } =
        await addressStream({
          boundJid: slot === "from" ? prepared : `user@${boundary.domain}/r`,
          domain: boundary.domain,
        });
      const stanza = xml(kind, {
        id: "boundary",
        ...(kind === "iq" ? { type: "result" } : {}),
        [slot]: boundary.rawAddress,
      });
      try {
        expect(encoder.encode(boundary.prepared).byteLength).toBe(
          MAX_PART_BYTES,
        );
        if (boundary.name.startsWith("NFC-contracted")) {
          expect(encoder.encode(boundary.raw).byteLength).toBeGreaterThan(
            MAX_PART_BYTES,
          );
        }
        if (boundary.name.includes("expanded")) {
          expect(encoder.encode(boundary.raw).byteLength).toBeLessThanOrEqual(
            MAX_PART_BYTES,
          );
        }
        if (boundary.name.includes("full 3071")) {
          expect(encoder.encode(prepared).byteLength).toBe(MAX_JID_BYTES);
          if (!boundary.name.startsWith("IPvFuture")) {
            expect(
              encoder.encode(boundary.rawAddress).byteLength,
            ).toBeGreaterThan(MAX_JID_BYTES);
          }
        }
        const result = await (
          method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza])
        ).catch((error: Error) => error);
        expect(result).toBeUndefined();
        await barrier();
        expect(frames).toHaveLength(1);
        expect(readFrame(frames[0])[0]).toEqual({
          open: `{${CONTENT}}${kind}`,
          attributes: {
            "{}id": "boundary",
            ...(kind === "iq" ? { "{}type": "result" } : {}),
            [`{}${slot}`]: prepared,
          },
        });
        expect(stanza.attrs[slot]).toBe(prepared);
        expect(sent).toEqual(["boundary"]);
        expect(acks).toEqual([]);
        expect(failures).toEqual([]);
        peer.send(`<a xmlns="${SM}" h="1"/>`);
        await barrier();
        expect(acks).toEqual(["boundary"]);
        const recovery = await xmpp
          .send(xml("presence", { id: "recovery", to: `other@${DOMAIN}/r` }))
          .catch((error: Error) => error);
        expect(recovery).toBeUndefined();
        await barrier();
        peer.send(`<a xmlns="${SM}" h="2"/>`);
        await barrier();
        expect(acks).toEqual(["boundary", "recovery"]);
        expect(sent).toEqual(["boundary", "recovery"]);
        expect(frames).toHaveLength(2);
        expect(failures).toEqual([]);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

for (const boundary of INVALID_PARTS) {
  test.each(MATRIX)(
    `RFC 7622 §§3.1–3.4/4: reject 1024 prepared octets before admission / ${boundary.name} / %s %s %s`,
    async (method, slot, kind) => {
      const { xmpp, peer, frames, sent, acks, failures, errors, barrier } =
        await addressStream({ maxStanzas: 2 });
      const raw =
        boundary.part === "local"
          ? `${boundary.raw}@${DOMAIN}/r`
          : boundary.part === "resource"
            ? `user@${DOMAIN}/${boundary.raw}`
            : `user@${boundary.raw}/r`;
      const prefix = xml("presence", { id: "prefix" });
      const invalid = xml(kind, {
        id: "invalid",
        ...(kind === "iq" ? { type: "result" } : {}),
        [slot]: raw,
      });
      try {
        expect(encoder.encode(boundary.prepared).byteLength).toBe(
          MAX_PART_BYTES + 1,
        );
        if (boundary.name.includes("expanded")) {
          expect(encoder.encode(boundary.raw).byteLength).toBeLessThanOrEqual(
            MAX_PART_BYTES,
          );
        }
        if (method === "send") {
          await xmpp.send(prefix);
        }
        const result = await (
          method === "send"
            ? xmpp.send(invalid)
            : xmpp.sendMany([prefix, invalid, xml("message", { id: "never" })])
        ).catch((error: Error) => error);
        expect(result).toBeInstanceOf(TypeError);
        await barrier();
        expect(frames.map((frame) => readFrame(frame)[0])).toEqual([
          { open: `{${CONTENT}}presence`, attributes: { "{}id": "prefix" } },
        ]);
        expect(sent).toEqual(["prefix"]);
        expect(acks).toEqual([]);
        expect(failures).toEqual([]);
        peer.send(`<a xmlns="${SM}" h="1"/>`);
        await barrier();
        expect(acks).toEqual(["prefix"]);
        const recovery = await xmpp
          .send(xml("message", { id: "recovery", from: `user@${DOMAIN}/r` }))
          .catch((error: Error) => error);
        expect(recovery).toBeUndefined();
        await barrier();
        peer.send(`<a xmlns="${SM}" h="2"/>`);
        await barrier();
        expect(acks).toEqual(["prefix", "recovery"]);
        expect(sent).toEqual(["prefix", "recovery"]);
        expect(frames.map((frame) => readFrame(frame)[0])).toEqual([
          { open: `{${CONTENT}}presence`, attributes: { "{}id": "prefix" } },
          {
            open: `{${CONTENT}}message`,
            attributes: { "{}id": "recovery", "{}from": `user@${DOMAIN}/r` },
          },
        ]);
        expect(failures).toEqual([]);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

// Names alone do not designate JID slots: unrelated extension nonzas retain
// their own attribute semantics and do not consume XEP-0198 stanza counters.
test.each([...SEND_METHODS])(
  "RFC 7622 §4: foreign stanza-named nonzas preserve overlength raw addresses / %s",
  async (method) => {
    const { xmpp, peer, frames, sent, acks, failures, errors, barrier } =
      await addressStream();
    const raw = `${"İ".repeat(512)}@EXAMPLE.TEST/${"e\u0301".repeat(512)}`;
    try {
      await xmpp.send(xml("presence", { id: "held" }));
      for (const kind of KINDS) {
        const value = xml(kind, {
          xmlns: EXTENSION,
          id: kind,
          to: raw,
          from: raw,
        });
        const result = await (
          method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
        ).catch((error: Error) => error);
        expect(result).toBeUndefined();
        expect(value.attrs.to).toBe(raw);
        expect(value.attrs.from).toBe(raw);
      }
      await barrier();
      expect(frames.slice(1).map((frame) => readFrame(frame)[0])).toEqual(
        KINDS.map((kind) => ({
          open: `{${EXTENSION}}${kind}`,
          attributes: { "{}id": kind, "{}to": raw, "{}from": raw },
        })),
      );
      expect(sent).toEqual(["held"]);
      expect(acks).toEqual([]);
      expect(failures).toEqual([]);
      peer.send(`<a xmlns="${SM}" h="1"/>`);
      await barrier();
      expect(acks).toEqual(["held"]);
      const recovery = await xmpp
        .send(xml("message", { id: "recovery" }))
        .catch((error: Error) => error);
      expect(recovery).toBeUndefined();
      await barrier();
      peer.send(`<a xmlns="${SM}" h="2"/>`);
      await barrier();
      expect(acks).toEqual(["held", "recovery"]);
      expect(sent).toEqual(["held", "recovery"]);
      expect(frames).toHaveLength(5);
      expect(failures).toEqual([]);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
