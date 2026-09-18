import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import parse from "../src/xml/lib/parse.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const TIMEOUT_MS = 300;
const FULL_JID = "user@example.test/server-resource";
const VALID_BIND = `<bind xmlns="${BIND}"><jid>${FULL_JID}</jid></bind>`;

// RFC 6120 §§7.1–7.7, reviewed with errata on 2026-09-18 (none amend §7).
// RFC 7622 replaces the address preparation reference. Resource uniqueness,
// allocation limits and §7.7.3 retry allowance are server obligations. Client
// retries are optional; errors must remain stanza errors, not bad credentials.
// Rejecting ambiguous/malformed server results is our fail-closed policy.
function bindingPeer(
  reply: (iq: Element, peer: ScriptedPeer) => void,
  features = `<bind xmlns="${BIND}"/>`,
) {
  let authenticated = false;
  return new ScriptedPeer((frame, peer) => {
    const el = parse(frame) as Element | undefined;
    if (!el) {
      throw new Error("Expected a client element");
    }
    if (el.is("open", FRAMING)) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="binding" version="1.0"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}">${authenticated ? features : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
      if (authenticated && !features) {
        peer.send(`<close xmlns="${FRAMING}"/>`);
      }
    } else if (el.is("auth", SASL)) {
      authenticated = true;
      peer.send(`<success xmlns="${SASL}"/>`);
    } else if (el.is("iq")) {
      reply(el, peer);
    } else if (el.is("close", FRAMING)) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

test.each([
  [undefined, undefined],
  ["balcony", "balcony"],
  ["Re\u0301s", "Rés"],
  [async () => "balcony", "balcony"],
] as const)(
  "RFC 6120 §§7.3/7.6/7.7: bind %j and accept server-selected resource",
  async (resource, expected) => {
    let request: Element | undefined;
    const peer = bindingPeer((iq, remote) => {
      request = iq;
      remote.send(
        `<iq xmlns="jabber:client" type="result" id="${iq.attrs.id}">${VALID_BIND}</iq>`,
      );
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      resource,
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    const online: string[] = [];
    xmpp.on("online", (address: { toString(): string }) =>
      online.push(address.toString()),
    );
    try {
      expect((await xmpp.start()).toString()).toBe(FULL_JID);
      expect(online).toEqual([FULL_JID]);
      expect(request?.attrs.type).toBe("set");
      expect(request?.attrs.id).toBeTruthy();
      expect(
        request?.getChild("bind", BIND)?.getChildText("resource", BIND),
      ).toBe(expected ?? null);
      expect(
        peer.transcript.map(
          (frame) => (parse(frame) as Element | undefined)?.name,
        ),
      ).toEqual(["open", "auth", "open", "iq"]);
      expect(peer.requests).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §§7.1/7.4: premature binding cannot bypass authentication", async () => {
  const peer = new ScriptedPeer((frame, remote) => {
    const el = parse(frame) as Element | undefined;
    if (!el) {
      throw new Error("Expected a client element");
    }
    if (el.is("open", FRAMING)) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="premature" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/></features>`,
      );
    } else if (el.is("iq")) {
      remote.send(
        `<iq xmlns="jabber:client" type="result" id="${el.attrs.id}">${VALID_BIND}</iq>`,
      );
    } else if (el.is("close", FRAMING)) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  let online = 0;
  xmpp.on("online", () => online++);
  try {
    const result = await xmpp.start().then(
      () => null,
      (error: Error) => error,
    );
    expect(online).toBe(0);
    expect(result).toBeInstanceOf(Error);
    expect(peer.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
      false,
    );
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each([
  ["missing bind", ""],
  [
    "wrong bind namespace",
    '<bind xmlns="urn:wrong"><jid>user@example.test/r</jid></bind>',
  ],
  ["missing jid", `<bind xmlns="${BIND}"/>`],
  ["bare jid", `<bind xmlns="${BIND}"><jid>user@example.test</jid></bind>`],
  ["domain jid", `<bind xmlns="${BIND}"><jid>example.test/r</jid></bind>`],
  ["invalid jid", `<bind xmlns="${BIND}"><jid>@example.test/r</jid></bind>`],
  [
    "wrong jid namespace",
    `<bind xmlns="${BIND}"><jid xmlns="urn:wrong">${FULL_JID}</jid></bind>`,
  ],
  [
    "duplicate jid",
    `<bind xmlns="${BIND}"><jid>${FULL_JID}</jid><jid>other@example.test/r</jid></bind>`,
  ],
  ["nested jid", `<bind xmlns="${BIND}"><jid>${FULL_JID}<extra/></jid></bind>`],
  ["duplicate bind", VALID_BIND + VALID_BIND],
])(
  "RFC 6120 §7: invalid binding result cannot authorize online / %s",
  async (_name, payload) => {
    const peer = bindingPeer((iq, remote) => {
      remote.send(
        `<iq xmlns="jabber:client" type="result" id="${iq.attrs.id}">${payload}</iq>`,
      );
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    let online = 0;
    xmpp.on("online", () => online++);
    try {
      const result = await xmpp.start().then(
        () => null,
        (error: Error) => error,
      );
      expect(online).toBe(0);
      expect(result).toBeInstanceOf(Error);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each(["resource-constraint", "not-allowed", "bad-request", "conflict"])(
  "RFC 6120 §§7.6.2/7.7.2: binding %s remains a stanza error",
  async (condition) => {
    const peer = bindingPeer((iq, remote) => {
      remote.send(
        `<iq xmlns="jabber:client" type="error" id="${iq.attrs.id}"><error type="cancel"><${condition} xmlns="${STANZAS}"/></error></iq>`,
      );
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      resource: "balcony",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    let online = 0;
    xmpp.on("online", () => online++);
    try {
      const result = await xmpp.start().catch((error: Error) => error);
      expect(result).toMatchObject({ name: "StanzaError", condition });
      expect(online).toBe(0);
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<auth")),
      ).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §7: forged and unrelated IQs cannot replace the bound identity", async () => {
  const peer = bindingPeer((iq, remote) => {
    const badBind = `<bind xmlns="${BIND}"><jid>attacker@example.test/r</jid></bind>`;
    remote.send(
      `<iq xmlns="jabber:client" type="result" id="${iq.attrs.id}" from="attacker.example">${badBind}</iq>`,
    );
    remote.send(
      `<iq xmlns="jabber:client" type="result" id="unrelated">${badBind}</iq>`,
    );
    remote.send(
      `<iq xmlns="jabber:client" type="result" id="${iq.attrs.id}" from="example.test">${VALID_BIND}</iq>`,
    );
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  try {
    expect((await xmpp.start()).toString()).toBe(FULL_JID);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each(["deadline", "disconnect"])(
  "RFC 6120 §7: interrupted binding / %s",
  async (mode) => {
    const peer = bindingPeer((_iq, remote) => {
      if (mode === "disconnect") {
        remote.terminate();
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    let online = 0;
    xmpp.on("online", () => online++);
    try {
      const result = await xmpp.start().then(
        () => null,
        (error: Error) => error,
      );
      expect(result).toBeInstanceOf(Error);
      if (mode === "deadline") {
        expect(result?.name).toBe("TimeoutError");
      }
      expect(online).toBe(0);
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<iq")),
      ).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §7.3.1: missing binding feature is not completed negotiation", async () => {
  const peer = bindingPeer(() => {}, "");
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  let online = 0;
  xmpp.on("online", () => online++);
  try {
    expect(await xmpp.start().catch((error: Error) => error)).toBeInstanceOf(
      Error,
    );
    expect(online).toBe(0);
    expect(peer.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
      false,
    );
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("RFC 6120 §7: late binding reply cannot authorize a replacement session", async () => {
  let oldID = "";
  const pending = Promise.withResolvers<void>();
  const first = bindingPeer((iq) => {
    oldID = iq.attrs.id;
    pending.resolve();
  });
  const second = bindingPeer((iq, remote) => {
    remote.send(
      `<iq xmlns="jabber:client" type="result" id="${oldID}"><bind xmlns="${BIND}"><jid>old@example.test/r</jid></bind></iq>`,
    );
    remote.send(
      `<iq xmlns="jabber:client" type="result" id="${iq.attrs.id}">${VALID_BIND}</iq>`,
    );
  });
  const xmpp = client({
    service: first.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  const online: string[] = [];
  xmpp.on("online", (address: { toString(): string }) =>
    online.push(address.toString()),
  );
  try {
    const start = xmpp.start().catch((error: Error) => error);
    await pending.promise;
    await xmpp.stop();
    expect(await start).toBeInstanceOf(Error);
    expect(online).toEqual([]);
    const ready = Promise.withResolvers<string>();
    xmpp.once("online", (address: { toString(): string }) =>
      ready.resolve(address.toString()),
    );
    await xmpp.connect(second.url);
    await xmpp.open({ domain: "example.test" });
    expect(await ready.promise).toBe(FULL_JID);
    expect(online).toEqual([FULL_JID]);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await first.stop();
    await second.stop();
  }
});
