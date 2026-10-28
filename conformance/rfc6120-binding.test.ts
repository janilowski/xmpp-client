import { describe, expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import parse from "../src/xml/lib/parse.js";
import type { ClientOptions, Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const TIMEOUT_MS = 300;
const FULL_JID = "user@example.test/server-resource";
const VALID_BIND = `<bind xmlns="${BIND}"><jid>${FULL_JID}</jid></bind>`;

test.each([
  ["fixed", "conflict", "occupied", "occupied", null],
  ["normalized", "conflict", "Re\u0301s", "Rés", null],
  ["callback repeats", "conflict", "callback", "occupied", null],
  ["callback changes", "conflict", "changing", "occupied", "fresh-choice"],
  ["server selected", "conflict", undefined, "occupied", null],
  ["server overrode request", "conflict", "preferred", "occupied", "preferred"],
  [
    "other stream error",
    "policy-violation",
    "occupied",
    "occupied",
    "occupied",
  ],
  [
    "IQ conflict is recoverable",
    "iq-conflict",
    "occupied",
    "occupied",
    "occupied",
  ],
] as const)(
  "RFC 6120 §4.9.3.3: resource selection on reconnect / %s",
  async (_name, condition, configured, previous, expected) => {
    let calls = 0;
    const resource =
      configured === "callback" || configured === "changing"
        ? async () =>
            ++calls > 1 && configured === "changing"
              ? "fresh-choice"
              : "occupied"
        : configured;
    const first = bindingPeer((iq, peer) => {
      if (iq.getChild("bind", BIND)) {
        peer.send(
          `<iq xmlns="jabber:client" type="result" id="${iq.attrs.id}"><bind xmlns="${BIND}"><jid>user@example.test/${previous}</jid></bind></iq>`,
        );
      } else {
        peer.send(
          `<iq xmlns="jabber:client" type="error" id="${iq.attrs.id}"><ping xmlns="urn:xmpp:ping"/><error type="cancel"><conflict xmlns="${STANZAS}"/></error></iq>`,
        );
      }
    });
    let requested: string | null | undefined;
    const second = bindingPeer((iq, peer) => {
      requested = iq.getChild("bind", BIND)?.getChildText("resource", BIND);
      peer.send(
        `<iq xmlns="jabber:client" type="result" id="${iq.attrs.id}">${VALID_BIND}</iq>`,
      );
    });
    const xmpp = client({
      service: first.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      resource,
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect((await xmpp.start()).toString()).toBe(
        `user@example.test/${previous}`,
      );
      if (condition === "iq-conflict") {
        const result = await xmpp.iqCaller
          .get(xml("ping", { xmlns: "urn:xmpp:ping" }))
          .catch((error: { condition: string }) => error);
        expect(result.condition).toBe("conflict");
        expect(xmpp.status).toBe("online");
        first.send(`<close xmlns="${FRAMING}"/>`);
      } else {
        first.send(
          `<error xmlns="${STREAM}"><${condition} xmlns="${STREAM_ERRORS}"/></error>`,
        );
      }
      await first.waitForClose();
      xmpp.options = { ...xmpp.options, service: second.url };
      const online = new Promise<string>((resolve) => {
        xmpp.once("online", (jid: { toString(): string }) =>
          resolve(jid.toString()),
        );
        timer = setTimeout(
          () => resolve("test watchdog: reconnect stalled"),
          TIMEOUT_MS * 3,
        );
      });
      await xmpp.reconnect.reconnect();
      expect(await online).toBe(FULL_JID);
      if (expected === null) {
        expect(requested).toBeTruthy();
        expect(requested).not.toBe(previous);
      } else {
        expect(requested).toBe(expected);
      }
      expect(errors.map((error) => error.name)).toEqual(
        condition === "iq-conflict" ? [] : ["StreamError"],
      );
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    } finally {
      clearTimeout(timer);
      await xmpp.stop();
      await first.stop();
      await second.stop();
    }
  },
);

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

describe("RFC 6120 §7.7.1 — requested resource preparation", () => {
  const MAX_RESOURCE_BYTES = 1023;
  const CONTENT = "jabber:client";
  const PROBE = "urn:test:resource-preparation";
  const encoder = new TextEncoder();
  const SOURCES = ["option", "callback"] as const;
  const valid = [
    ["ASCII", "R".repeat(1023), "R".repeat(1023)],
    ["lowercase ASCII", "r".repeat(1023), "r".repeat(1023)],
    ["fullwidth preserved", "Ａ".repeat(341), "Ａ".repeat(341)],
    ["XML escaping", " &<".repeat(341), " &<".repeat(341)],
    ["supplementary", `${"🙂".repeat(255)}abc`, `${"🙂".repeat(255)}abc`],
    ["NFC contraction", `${"e\u0301".repeat(511)}a`, `${"é".repeat(511)}a`],
    ["non-ASCII spaces", "\u2003".repeat(1023), " ".repeat(1023)],
    [
      "NFC expansion",
      `${"\u0344".repeat(255)}abc`,
      `${"\u0308\u0301".repeat(255)}abc`,
    ],
  ] as const;
  const invalid = [
    ["ASCII", "R".repeat(1024), "R".repeat(1024)],
    ["fullwidth preserved", `${"Ａ".repeat(341)}a`, `${"Ａ".repeat(341)}a`],
    ["multibyte", "é".repeat(512), "é".repeat(512)],
    ["supplementary", "🙂".repeat(256), "🙂".repeat(256)],
    ["non-ASCII spaces", "\u2003".repeat(1024), " ".repeat(1024)],
    ["NFC expansion", "\u0344".repeat(256), "\u0308\u0301".repeat(256)],
  ] as const;

  // RFC 7622 §§3.4/4 (client SHOULD) and RFC 8265 §4.2. Our strict policy
  // prepares or rejects locally; a permissive peer never hides a leaked IQ.
  function resourceClient(resource: ClientOptions["resource"]) {
    const peer = bindingPeer((iq, remote) => {
      remote.send(
        `<iq xmlns="${CONTENT}" id="${iq.attrs.id}" type="result">${VALID_BIND}</iq>`,
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
    const initialIdentity = String(xmpp.jid);
    const errors: Error[] = [];
    const online: string[] = [];
    const sent: string[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    xmpp.on("online", (address: { toString(): string }) =>
      online.push(String(address)),
    );
    xmpp.on("send", (element: Element) => {
      if (element.is("iq", CONTENT) && element.getChild("bind", BIND)) {
        sent.push(element.attrs.id);
      }
    });
    async function start() {
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          xmpp.start().then(
            (address) => ({
              kind: "result" as const,
              address: String(address),
            }),
            (error: Error) => ({ kind: "error" as const, error }),
          ),
          new Promise<{ kind: "deadline" }>((resolve) => {
            watchdog = setTimeout(
              () => resolve({ kind: "deadline" }),
              TIMEOUT_MS * 3,
            );
          }),
        ]);
      } finally {
        clearTimeout(watchdog);
      }
    }
    return { xmpp, peer, initialIdentity, errors, online, sent, start };
  }

  for (const [name, raw, prepared] of valid) {
    test.each([...SOURCES])(
      `RFC 7622 §§3.4/4: submit exactly 1023 prepared octets / ${name} / %s`,
      async (source) => {
        let calls = 0;
        const fixture = resourceClient(
          source === "option"
            ? raw
            : async () => {
                calls++;
                return raw;
              },
        );
        const { xmpp, peer, errors, online, sent } = fixture;
        try {
          expect(encoder.encode(prepared).byteLength).toBe(MAX_RESOURCE_BYTES);
          if (name === "NFC contraction" || name === "non-ASCII spaces") {
            expect(encoder.encode(raw).byteLength).toBeGreaterThan(
              MAX_RESOURCE_BYTES,
            );
          }
          expect(await fixture.start()).toEqual({
            kind: "result",
            address: FULL_JID,
          });
          const frames = peer.transcript.filter((frame) =>
            frame.startsWith("<iq"),
          );
          expect(frames).toHaveLength(1);
          expect(readFrame(frames[0]).slice(1)).toEqual([
            { open: `{${BIND}}bind`, attributes: {} },
            { open: `{${BIND}}resource`, attributes: {} },
            { text: prepared },
            { close: `{${BIND}}resource` },
            { close: `{${BIND}}bind` },
            { close: `{${CONTENT}}iq` },
          ]);
          expect(readFrame(frames[0])[0]).toMatchObject({
            open: `{${CONTENT}}iq`,
            attributes: { "{}type": "set" },
          });
          expect(sent).toHaveLength(1);
          expect(calls).toBe(source === "callback" ? 1 : 0);
          // RFC 6120 §7.7.1 permits the server to override our preference.
          expect(String(xmpp.jid)).toBe(FULL_JID);
          expect(online).toEqual([FULL_JID]);
          expect(errors).toEqual([]);
          expect(peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await peer.stop();
        }
      },
    );
  }

  for (const [name, raw, prepared] of invalid) {
    test.each([...SOURCES])(
      `RFC 7622 §§3.4/4: reject 1024 prepared octets before binding / ${name} / %s`,
      async (source) => {
        let selected = raw;
        let calls = 0;
        const fixture = resourceClient(
          source === "option"
            ? selected
            : async () => {
                calls++;
                return selected;
              },
        );
        const { xmpp, peer, initialIdentity, errors, online, sent } = fixture;
        let recovery: ReturnType<typeof resourceClient> | undefined;
        let replacement: ScriptedPeer | undefined;
        try {
          expect(encoder.encode(prepared).byteLength).toBe(
            MAX_RESOURCE_BYTES + 1,
          );
          if (name === "NFC expansion") {
            expect(encoder.encode(raw).byteLength).toBeLessThanOrEqual(
              MAX_RESOURCE_BYTES,
            );
          }
          const outcome = await fixture.start();
          expect(outcome.kind).toBe("error");
          expect(outcome).toMatchObject({ error: expect.any(TypeError) });
          expect(String(xmpp.jid)).toBe(initialIdentity);
          expect(xmpp.jid?.getResource()).toBe("");
          expect(online).toEqual([]);
          expect(calls).toBe(source === "callback" ? 1 : 0);
          const routed = await xmpp
            .send(
              xml("message", { id: "unauthorized", to: "other@remote.test/r" }),
            )
            .catch((error: Error) => error);
          expect(routed).toBeInstanceOf(Error);
          // Closing settles pending real writes before inspecting the transcript.
          await xmpp.stop();
          await peer.waitForClose();
          expect(
            peer.transcript.some(
              (frame) =>
                frame.startsWith("<iq") || frame.includes('id="unauthorized"'),
            ),
          ).toBe(false);
          expect(sent).toEqual([]);
          expect(online).toEqual([]);
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBeInstanceOf(TypeError);
          expect(peer.errors).toEqual([]);

          if (source === "option") {
            // Fixed options are captured at construction, not hot-reconfigurable.
            recovery = resourceClient("Re\u0301s");
          } else {
            selected = "Re\u0301s";
            replacement = bindingPeer((iq, remote) =>
              remote.send(
                `<iq xmlns="${CONTENT}" id="${iq.attrs.id}" type="result">${VALID_BIND}</iq>`,
              ),
            );
            xmpp.options = { ...xmpp.options, service: replacement.url };
            recovery = fixture;
          }
          expect(await recovery.start()).toEqual({
            kind: "result",
            address: FULL_JID,
          });
          const recoveredPeer = replacement ?? recovery.peer;
          const requests = recoveredPeer.transcript.filter((frame) =>
            frame.startsWith("<iq"),
          );
          expect(requests).toHaveLength(1);
          expect(readFrame(requests[0])).toContainEqual({ text: "Rés" });
          expect(recovery.online).toEqual([FULL_JID]);
          expect(String(recovery.xmpp.jid)).toBe(FULL_JID);
          expect(calls).toBe(source === "callback" ? 2 : 0);
          expect(recoveredPeer.errors).toEqual([]);
        } finally {
          if (recovery && recovery !== fixture) {
            await recovery.xmpp.stop();
            await recovery.peer.stop();
          }
          await xmpp.stop();
          await replacement?.stop();
          await peer.stop();
        }
      },
    );
  }

  test("RFC 6120 §7.7.1: async resource selection gates binding until it resolves", async () => {
    const entered = Promise.withResolvers<void>();
    const selected = Promise.withResolvers<string>();
    let calls = 0;
    const fixture = resourceClient(async () => {
      calls++;
      entered.resolve();
      return selected.promise;
    });
    const { xmpp, peer, initialIdentity, online, sent, errors } = fixture;
    const starting = fixture.start();
    try {
      expect(
        await Promise.race([
          entered.promise.then(() => "callback"),
          starting.then((outcome) => outcome.kind),
        ]),
      ).toBe("callback");
      await xmpp.send(xml("probe", { xmlns: PROBE }));
      for (;;) {
        const root = readFrame(await peer.next())[0];
        if ("open" in root && root.open === `{${PROBE}}probe`) {
          break;
        }
      }
      expect(peer.transcript.some((value) => value.startsWith("<iq"))).toBe(
        false,
      );
      expect(sent).toEqual([]);
      expect(online).toEqual([]);
      expect(String(xmpp.jid)).toBe(initialIdentity);
      expect(calls).toBe(1);
      selected.resolve("Re\u0301s");
      expect(await starting).toEqual({ kind: "result", address: FULL_JID });
      const requests = peer.transcript.filter((value) =>
        value.startsWith("<iq"),
      );
      expect(requests).toHaveLength(1);
      expect(readFrame(requests[0])).toContainEqual({ text: "Rés" });
      expect(sent).toHaveLength(1);
      expect(online).toEqual([FULL_JID]);
      expect(calls).toBe(1);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      selected.resolve("recovery");
      await xmpp.stop();
      await starting;
      await peer.stop();
    }
  });

  test.each([
    ["omitted option", undefined],
    ["empty option", ""],
    ["empty async callback", async () => ""],
  ] as const)(
    "RFC 6120 §7.6.1: %s delegates resource allocation to the server",
    async (_name, resource) => {
      let calls = 0;
      const selected =
        typeof resource === "function"
          ? async () => {
              calls++;
              return resource();
            }
          : resource;
      const fixture = resourceClient(selected);
      const { xmpp, peer, online, sent, errors } = fixture;
      try {
        expect(await fixture.start()).toEqual({
          kind: "result",
          address: FULL_JID,
        });
        const requests = peer.transcript.filter((frame) =>
          frame.startsWith("<iq"),
        );
        expect(requests).toHaveLength(1);
        expect(readFrame(requests[0]).slice(1)).toEqual([
          { open: `{${BIND}}bind`, attributes: {} },
          { close: `{${BIND}}bind` },
          { close: `{${CONTENT}}iq` },
        ]);
        expect(sent).toHaveLength(1);
        expect(calls).toBe(typeof resource === "function" ? 1 : 0);
        expect(online).toEqual([FULL_JID]);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
});

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
