import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { client, xml } from "../src/client/index.js";
import parse from "../src/xml/lib/parse.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const TIMEOUT_MS = 300;
const FULL_JID = "user@example.test/server-resource";
const VALID_BIND = `<bind xmlns="${BIND}"><jid>${FULL_JID}</jid></bind>`;
const CLIENT = "jabber:client";
const CANONICAL_ACCOUNT = "canonical@example.test";
const CANONICAL_JID = `${CANONICAL_ACCOUNT}/device`;
const BINDING_ERROR = "not-allowed";

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

// RFC 6120 §§4.3.6/7.6.1/8.1.2.1(3), §10.3.3 item 1: the server assigns
// the account; a configured authcid/public JID is not its canonical identity.
for (const type of ["result", "error"] as const) {
  test.each([
    ["canonical account", CANONICAL_ACCOUNT, CANONICAL_JID],
    [
      "different assigned domain",
      "canonical@assigned.test",
      "canonical@assigned.test/device",
    ],
    ["normalized bare", "CANONICAL@ＥＸＡＭＰＬＥ。TEST", CANONICAL_JID],
    ["connected server", "example.test", CANONICAL_JID],
    ["absent sender", undefined, CANONICAL_JID],
  ] as const)(
    `RFC 6120 §§7.6.1/8.1.2.1: authenticated binding accepts ${type} from %s`,
    async (_shape, from, fullJID) => {
      const barrier = Promise.withResolvers<void>();
      let request: ReturnType<typeof readFrame> | undefined;
      const peer = bindingPeer((iq, remote) => {
        if (iq.attrs.id === "binding-barrier" && iq.attrs.type === "result") {
          barrier.resolve();
          return;
        }
        if (!iq.getChild("bind", BIND)) {
          return;
        }
        request = readFrame(remote.transcript.at(-1)!);
        remote.send(
          `<iq xmlns="${CLIENT}" type="${type}" id="${iq.attrs.id}"${from === undefined ? "" : ` from="${from}"`}>${type === "result" ? `<bind xmlns="${BIND}"><jid>${fullJID}</jid></bind>` : `<error type="cancel"><${BINDING_ERROR} xmlns="${STANZAS}"/></error>`}</iq>`,
        );
        remote.send(
          `<iq xmlns="${CLIENT}" type="get" id="binding-barrier" from="example.test"><ping xmlns="urn:xmpp:ping"/></iq>`,
        );
      });
      const xmpp = client({
        service: peer.url,
        domain: "example.test",
        username: "configured",
        password: "secret",
        timeout: TIMEOUT_MS,
      });
      xmpp.reconnect.stop();
      const errors: Error[] = [];
      const online: string[] = [];
      xmpp.on("error", (error: Error) => errors.push(error));
      xmpp.on("online", (address: { toString(): string }) =>
        online.push(address.toString()),
      );
      let settled = false;
      const outcome = xmpp.start().then(
        (address) => {
          settled = true;
          return address;
        },
        (error: Error) => {
          settled = true;
          return error;
        },
      );
      try {
        await Promise.race([barrier.promise, Bun.sleep(TIMEOUT_MS)]);
        await setImmediate();
        expect(request?.[0]).toEqual({
          open: `{${CLIENT}}iq`,
          attributes: { "{}id": expect.any(String), "{}type": "set" },
        });
        const pingReply = peer.transcript.find((frame) =>
          frame.includes('id="binding-barrier"'),
        );
        expect(pingReply).toBeDefined();
        expect(readFrame(pingReply!)[0]).toEqual({
          open: `{${CLIENT}}iq`,
          attributes: {
            "{}id": "binding-barrier",
            "{}type": "result",
            "{}to": "example.test",
          },
        });
        // A legitimate canonical reply must settle before a negotiation deadline.
        expect(settled).toBe(true);
        const result = await outcome;
        if (type === "result") {
          expect(result.toString()).toBe(fullJID);
          expect(xmpp.jid?.toString()).toBe(fullJID);
          expect(online).toEqual([fullJID]);
          expect(errors).toEqual([]);
        } else {
          expect(result).toMatchObject({
            name: "StanzaError",
            condition: BINDING_ERROR,
          });
          expect(xmpp.jid?.toString()).toBe("configured@example.test");
          expect(online).toEqual([]);
          expect(xmpp.streamManagement.enabled).toBe(false);
          const forbidden = await xmpp
            .send(
              xml("message", {
                id: "not-authorized",
                to: fullJID.slice(0, fullJID.indexOf("/")),
              }),
            )
            .catch((error: Error) => error);
          expect(forbidden).toMatchObject({
            message: "Stream negotiation is not complete",
          });
          expect(errors.map((error) => error.name)).toEqual(["StanzaError"]);
        }
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await outcome;
        await peer.stop();
      }
    },
  );
}

async function bindingBarrier(peer: ScriptedPeer, id: string) {
  peer.send(
    `<iq xmlns="${CLIENT}" type="get" id="${id}" from="example.test"><ping xmlns="urn:xmpp:ping"/></iq>`,
  );
  while (true) {
    const root = readFrame(await peer.next())[0];
    if (!root || !("open" in root) || root.attributes["{}id"] !== id) {
      continue;
    }
    expect(root).toEqual({
      open: `{${CLIENT}}iq`,
      attributes: { "{}id": id, "{}type": "result", "{}to": "example.test" },
    });
    await setImmediate();
    return;
  }
}

const CANONICAL_BIND = `<bind xmlns="${BIND}"><jid>${CANONICAL_JID}</jid></bind>`;

test.each([
  ["mismatched bare account", "wrong@example.test", CANONICAL_BIND],
  ["unknown domain", "other.example", CANONICAL_BIND],
  ["full resource sender", CANONICAL_JID, CANONICAL_BIND],
  ["empty sender", "", CANONICAL_BIND],
  ["malformed sender", "@example.test", CANONICAL_BIND],
  ["missing bind", CANONICAL_ACCOUNT, ""],
  [
    "wrong bind namespace",
    CANONICAL_ACCOUNT,
    '<bind xmlns="urn:wrong"><jid>canonical@example.test/device</jid></bind>',
  ],
  ["missing jid", CANONICAL_ACCOUNT, `<bind xmlns="${BIND}"/>`],
  [
    "bare jid",
    CANONICAL_ACCOUNT,
    `<bind xmlns="${BIND}"><jid>${CANONICAL_ACCOUNT}</jid></bind>`,
  ],
  [
    "invalid jid",
    CANONICAL_ACCOUNT,
    `<bind xmlns="${BIND}"><jid>@example.test/device</jid></bind>`,
  ],
  [
    "wrong jid namespace",
    CANONICAL_ACCOUNT,
    `<bind xmlns="${BIND}"><jid xmlns="urn:wrong">${CANONICAL_JID}</jid></bind>`,
  ],
  ["duplicate bind", CANONICAL_ACCOUNT, CANONICAL_BIND + CANONICAL_BIND],
  [
    "duplicate jid",
    CANONICAL_ACCOUNT,
    `<bind xmlns="${BIND}"><jid>${CANONICAL_JID}</jid><jid>${CANONICAL_JID}</jid></bind>`,
  ],
  [
    "nested jid",
    CANONICAL_ACCOUNT,
    `<bind xmlns="${BIND}"><jid>${CANONICAL_JID}<extra/></jid></bind>`,
  ],
] as const)(
  "RFC 6120 §§7/8.1.2.1: reject invalid canonical binding sender/result before authority / %s",
  async (_case, from, payload) => {
    const requested = Promise.withResolvers<string>();
    const peer = bindingPeer((iq) => {
      if (iq.getChild("bind", BIND)) {
        requested.resolve(iq.attrs.id);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    const online: string[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    xmpp.on("online", (address: { toString(): string }) =>
      online.push(address.toString()),
    );
    let settled = false;
    const outcome = xmpp.start().then(
      (address) => {
        settled = true;
        return address;
      },
      (error: Error) => {
        settled = true;
        return error;
      },
    );
    try {
      const id = await requested.promise;
      peer.send(
        `<iq xmlns="${CLIENT}" type="result" id="${id}" from="${from}">${payload}</iq>`,
      );
      await bindingBarrier(peer, "hostile-barrier");
      expect(settled).toBe(false);
      expect(online).toEqual([]);
      expect(errors).toEqual([]);
      expect(xmpp.jid?.toString()).toBe("configured@example.test");
      expect(xmpp.streamManagement.enabled).toBe(false);
      const forbidden = await xmpp
        .send(xml("message", { id: "not-authorized", to: CANONICAL_ACCOUNT }))
        .catch((error: Error) => error);
      expect(forbidden).toMatchObject({
        message: "Stream negotiation is not complete",
      });
      peer.send(
        `<iq xmlns="${CLIENT}" type="result" id="${id}" from="${CANONICAL_ACCOUNT}">${CANONICAL_BIND}</iq>`,
      );
      await bindingBarrier(peer, "valid-barrier");
      expect(settled).toBe(true);
      expect((await outcome).toString()).toBe(CANONICAL_JID);
      expect(online).toEqual([CANONICAL_JID]);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await outcome;
      await peer.stop();
    }
  },
);

test.each([
  ["full resource sender", CANONICAL_JID],
  ["unknown domain", "other.example"],
  ["malformed sender", "@example.test"],
] as const)(
  "RFC 6120 §§7/8.1.2.1: reject invalid canonical binding error sender before authority / %s",
  async (_case, from) => {
    const requested = Promise.withResolvers<string>();
    const peer = bindingPeer((iq) => {
      if (iq.getChild("bind", BIND)) {
        requested.resolve(iq.attrs.id);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    const online: string[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    xmpp.on("online", (address: { toString(): string }) =>
      online.push(address.toString()),
    );
    let settled = false;
    const outcome = xmpp.start().then(
      (address) => {
        settled = true;
        return address;
      },
      (error: Error) => {
        settled = true;
        return error;
      },
    );
    try {
      const id = await requested.promise;
      peer.send(
        `<iq xmlns="${CLIENT}" type="error" id="${id}" from="${from}"><error type="cancel"><${BINDING_ERROR} xmlns="${STANZAS}"/></error></iq>`,
      );
      await bindingBarrier(peer, "hostile-error-barrier");
      expect(settled).toBe(false);
      expect(errors).toEqual([]);
      expect(online).toEqual([]);
      expect(xmpp.jid?.toString()).toBe("configured@example.test");
      expect(xmpp.streamManagement.enabled).toBe(false);

      peer.send(
        `<iq xmlns="${CLIENT}" type="error" id="${id}" from="${CANONICAL_ACCOUNT}"><error type="cancel"><${BINDING_ERROR} xmlns="${STANZAS}"/></error></iq>`,
      );
      await bindingBarrier(peer, "valid-error-barrier");
      expect(settled).toBe(true);
      expect(await outcome).toMatchObject({
        name: "StanzaError",
        condition: BINDING_ERROR,
      });
      expect(errors.map((error) => error.name)).toEqual(["StanzaError"]);
      expect(online).toEqual([]);
      expect(xmpp.jid?.toString()).toBe("configured@example.test");
      expect(xmpp.streamManagement.enabled).toBe(false);
      const forbidden = await xmpp
        .send(xml("message", { id: "not-authorized", to: CANONICAL_ACCOUNT }))
        .catch((error: Error) => error);
      expect(forbidden).toMatchObject({
        message: "Stream negotiation is not complete",
      });
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await outcome;
      await peer.stop();
    }
  },
);

for (const type of ["result", "error"] as const) {
  test.each(["pre-auth", "binding", "bound"] as const)(
    `RFC 6120 §§7/8.1.2.1: generic bind-shaped IQ cannot claim the internal binding ${type} exception / %s`,
    async (phase) => {
      const bindingPending = Promise.withResolvers<void>();
      const processIQ = (iq: Element, peer: ScriptedPeer) => {
        if (iq.attrs.id === "generic-binding" || !iq.getChild("bind", BIND)) {
          return;
        }
        if (phase === "binding") {
          bindingPending.resolve();
          return;
        }
        peer.send(
          `<iq xmlns="${CLIENT}" type="result" id="${iq.attrs.id}" from="example.test">${VALID_BIND}</iq>`,
        );
      };
      const peer =
        phase === "pre-auth"
          ? new ScriptedPeer((frame, remote) => {
              const root = readFrame(frame)[0];
              if (!root || !("open" in root)) {
                throw new Error("Expected a client element");
              }
              if (root.open === `{${FRAMING}}open`) {
                remote.send(
                  `<open xmlns="${FRAMING}" from="example.test" id="generic-binding" version="1.0"/>`,
                );
              } else if (root.open === `{${FRAMING}}close`) {
                remote.send(`<close xmlns="${FRAMING}"/>`);
              }
            })
          : bindingPeer(processIQ);
      const xmpp = client({
        service: peer.url,
        domain: "example.test",
        username: "configured",
        password: "secret",
        timeout: TIMEOUT_MS,
      });
      xmpp.reconnect.stop();
      const errors: Error[] = [];
      const implicit: (string | null)[] = [];
      xmpp.on("error", (error: Error) => errors.push(error));
      xmpp.middleware.use(
        (
          context: { id: string; from: { toString(): string } | null },
          next: () => Promise<unknown>,
        ) => {
          if (context.id === "implicit-authority") {
            implicit.push(context.from?.toString() ?? null);
          }
          return next();
        },
      );
      let started: Promise<unknown> | undefined;
      let outcome: Promise<unknown> | undefined;
      try {
        if (phase === "pre-auth") {
          await xmpp.connect(peer.url);
          await xmpp.open({ domain: "example.test" });
        } else if (phase === "bound") {
          expect((await xmpp.start()).toString()).toBe(FULL_JID);
        } else {
          started = xmpp.start().catch((error: Error) => error);
          await bindingPending.promise;
        }
        let settled = false;
        const pending = xmpp.iqCaller.request(
          xml("iq", { type: "set", id: "generic-binding" }, xml("bind", BIND)),
          TIMEOUT_MS,
        );
        outcome = pending.then(
          (result) => {
            settled = true;
            return result;
          },
          (error: Error) => {
            settled = true;
            return error;
          },
        );
        while (
          !peer.transcript.some((frame) =>
            frame.includes('id="generic-binding"'),
          )
        ) {
          await peer.next();
        }
        const request = peer.transcript.find((frame) =>
          frame.includes('id="generic-binding"'),
        );
        expect(readFrame(request!)[0]).toEqual({
          open: `{${CLIENT}}iq`,
          attributes: { "{}id": "generic-binding", "{}type": "set" },
        });
        peer.send(
          `<iq xmlns="${CLIENT}" type="${type}" id="generic-binding" from="${CANONICAL_ACCOUNT}">${type === "result" ? CANONICAL_BIND : `<error type="cancel"><${BINDING_ERROR} xmlns="${STANZAS}"/></error>`}</iq>`,
        );
        await bindingBarrier(peer, "generic-hostile-barrier");
        expect(settled).toBe(false);
        peer.send(
          `<iq xmlns="${CLIENT}" type="${type}" id="generic-binding" from="example.test">${type === "result" ? CANONICAL_BIND : `<error type="cancel"><${BINDING_ERROR} xmlns="${STANZAS}"/></error>`}</iq>`,
        );
        await bindingBarrier(peer, "generic-valid-barrier");
        expect(settled).toBe(true);
        const result = await outcome;
        if (type === "result") {
          expect((result as Element).attrs.from).toBe("example.test");
        } else {
          expect(result).toMatchObject({
            name: "StanzaError",
            condition: BINDING_ERROR,
          });
        }
        expect(xmpp.status).toBe(phase === "bound" ? "online" : "open");
        expect(xmpp.jid?.toString()).toBe(
          phase === "bound" ? FULL_JID : "configured@example.test",
        );
        peer.send(
          `<message xmlns="${CLIENT}" id="implicit-authority"><body>probe</body></message>`,
        );
        await bindingBarrier(peer, "authority-barrier");
        expect(implicit).toEqual([
          phase === "bound" ? "user@example.test" : null,
        ]);
        if (phase !== "bound") {
          const forbidden = await xmpp
            .send(
              xml("message", { id: "not-authorized", to: CANONICAL_ACCOUNT }),
            )
            .catch((error: Error) => error);
          expect(forbidden).toMatchObject({
            message: "Stream negotiation is not complete",
          });
        }
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await started;
        await outcome;
        await peer.stop();
      }
    },
  );
}

test("RFC 6120 §§4.4/7: cancelled binding Element reuse cannot retain the bootstrap exception on a replacement", async () => {
  const firstPending = Promise.withResolvers<void>();
  const secondPending = Promise.withResolvers<string>();
  let formerRequest: Element | undefined;
  const first = bindingPeer(() => firstPending.resolve());
  const second = bindingPeer((iq) => {
    if (iq.getChild("bind", BIND) && iq.attrs.id !== formerRequest?.attrs.id) {
      secondPending.resolve(iq.attrs.id);
    }
  });
  const xmpp = client({
    service: first.url,
    domain: "example.test",
    username: "configured",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.on("send", (element: Element) => {
    if (!formerRequest && element.is("iq") && element.getChild("bind", BIND)) {
      formerRequest = element;
    }
  });
  const errors: Error[] = [];
  const online: string[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("online", (address: { toString(): string }) =>
    online.push(address.toString()),
  );
  const initial = xmpp.start().catch((error: Error) => error);
  let replacement: Promise<unknown> | undefined;
  let reused: Promise<unknown> | undefined;
  try {
    await firstPending.promise;
    expect(formerRequest).toBeDefined();
    await xmpp.stop();
    expect(await initial).toMatchObject({
      name: "Error",
      message: "Stream closed before online",
    });
    expect(online).toEqual([]);
    Object.assign(xmpp.options, { service: second.url });
    let ready = false;
    replacement = xmpp.start().then(
      (address) => {
        ready = true;
        return address;
      },
      (error: Error) => error,
    );
    const currentID = await secondPending.promise;
    let settled = false;
    reused = xmpp.iqCaller.request(formerRequest!, TIMEOUT_MS).then(
      (result) => {
        settled = true;
        return result;
      },
      (error: Error) => {
        settled = true;
        return error;
      },
    );
    while (
      !second.transcript.some((frame) =>
        frame.includes(`id="${formerRequest!.attrs.id}"`),
      )
    ) {
      await second.next();
    }
    second.send(
      `<iq xmlns="${CLIENT}" type="result" id="${formerRequest!.attrs.id}" from="${CANONICAL_ACCOUNT}">${CANONICAL_BIND}</iq>`,
    );
    await bindingBarrier(second, "reuse-hostile-barrier");
    expect(settled).toBe(false);
    expect(ready).toBe(false);
    expect(online).toEqual([]);
    expect(xmpp.jid?.toString()).toBe("configured@example.test");
    second.send(
      `<iq xmlns="${CLIENT}" type="result" id="${formerRequest!.attrs.id}" from="example.test">${CANONICAL_BIND}</iq>`,
    );
    await bindingBarrier(second, "reuse-valid-barrier");
    expect(settled).toBe(true);
    expect(((await reused) as Element).attrs.from).toBe("example.test");
    expect(ready).toBe(false);
    expect(online).toEqual([]);
    second.send(
      `<iq xmlns="${CLIENT}" type="result" id="${currentID}" from="${CANONICAL_ACCOUNT}">${CANONICAL_BIND}</iq>`,
    );
    await bindingBarrier(second, "replacement-ready-barrier");
    expect(ready).toBe(true);
    expect(String(await replacement)).toBe(CANONICAL_JID);
    expect(online).toEqual([CANONICAL_JID]);
    expect(errors).toEqual([]);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await initial;
    await replacement;
    await reused;
    await first.stop();
    await second.stop();
  }
});
