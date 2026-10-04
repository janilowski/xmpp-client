import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CLIENT = "jabber:client";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const EXTENSION = "urn:example:routing-test";
const ACCOUNT = "élise@example.test";
const FULL_JID = `${ACCOUNT}/server-resource`;
const PROOF_MECHANISM = "TEST-ROUTING";
const TIMEOUT_MS = 500;

type Phase = "authentication" | "binding" | "ready" | "reopen";
type Protocol = "sasl" | "sasl2";

// Receipt of a later WebSocket frame proves all preceding writes reached the peer.
async function flushWire(xmpp: ReturnType<typeof client>, peer: ScriptedPeer) {
  await xmpp.send(xml("sync", { xmlns: EXTENSION }));
  while (true) {
    const el = readFrame(await peer.next())[0];
    if (el && "open" in el && el.open === `{${EXTENSION}}sync`) {
      return;
    }
  }
}

// RFC 6120 §§4.3.5–4.3.6: the configured username is a hint, not authority.
// A verified SASL2 authorization identifier confirms the account before binding.
function negotiationPeer(phase: Phase, protocol: Protocol, account = ACCOUNT) {
  const paused = Promise.withResolvers<void>();
  let authenticated = false;
  let bound = false;
  let bindingId: string | undefined;
  const peer = new ScriptedPeer((frame, remote) => {
    const el = readFrame(frame)[0];
    if (!el || !("open" in el)) {
      throw new Error("Expected a client element");
    }
    if (el.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="routing" version="1.0"/>`,
      );
      if (authenticated) {
        offerBinding();
      } else {
        remote.send(
          `<features xmlns="${STREAM}"><${protocol === "sasl" ? "mechanisms" : "authentication"} xmlns="${protocol === "sasl" ? SASL : SASL2}"><mechanism>PLAIN</mechanism><mechanism>${PROOF_MECHANISM}</mechanism></${protocol === "sasl" ? "mechanisms" : "authentication"}></features>`,
        );
      }
    } else if (
      el.open === `{${SASL}}auth` ||
      el.open === `{${SASL2}}authenticate`
    ) {
      if (phase === "authentication") {
        paused.resolve();
      } else {
        succeed();
      }
    } else if (
      el.open === `{${CLIENT}}iq` &&
      readFrame(frame).some(
        (event) => "open" in event && event.open === `{${BIND}}bind`,
      )
    ) {
      bindingId = el.attributes["{}id"];
      if (phase === "binding" || (phase === "reopen" && bound)) {
        paused.resolve();
      } else {
        finishBinding();
      }
    } else if (el.open === `{${SM}}enable`) {
      remote.send(
        `<enabled xmlns="${SM}" id="routing-session" resume="true"/>`,
      );
    } else if (el.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });

  function offerBinding() {
    peer.send(
      `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/>${phase === "ready" ? `<sm xmlns="${SM}"/>` : ""}</features>`,
    );
  }
  function succeed() {
    authenticated = true;
    peer.send(
      protocol === "sasl"
        ? `<success xmlns="${SASL}"/>`
        : `<success xmlns="${SASL2}"><authorization-identifier>${account}</authorization-identifier></success>`,
    );
    if (protocol === "sasl2") {
      offerBinding();
    }
  }
  function finishBinding() {
    if (!bindingId) {
      throw new Error("No binding request to complete");
    }
    peer.send(
      `<iq xmlns="${CLIENT}" type="result" id="${bindingId}"><bind xmlns="${BIND}"><jid>${account}/server-resource</jid></bind></iq>`,
    );
    bound = true;
  }
  return {
    peer,
    paused: paused.promise,
    complete: phase === "authentication" ? succeed : finishBinding,
  };
}

for (const entry of ["start", "reconnect"] as const) {
  for (const protocol of ["sasl", "sasl2"] as const) {
    test.each(["authentication", "binding"] as const)(
      `RFC 6120 §4.3.5: reject remote stanzas before wire or queue admission / ${entry} / ${protocol} / %s`,
      async (phase) => {
        const first = negotiationPeer("ready", protocol);
        const current = negotiationPeer(phase, protocol);
        const xmpp = client({
          service: entry === "start" ? current.peer.url : first.peer.url,
          domain: "EXAMPLE.TEST",
          username: "configured",
          password: "secret",
          timeout: TIMEOUT_MS,
        });
        xmpp.reconnect.stop();
        const errors: Error[] = [];
        const sent: string[] = [];
        xmpp.on("error", (error: Error) => errors.push(error));
        xmpp.on("send", (stanza: Element) => {
          if (stanza.attrs.id?.startsWith("forbidden-")) {
            sent.push(stanza.attrs.id);
          }
        });
        const enabled = Promise.withResolvers<void>();
        xmpp.on("nonza", (element: Element) => {
          if (element.is("enabled", SM)) {
            enabled.resolve();
          }
        });
        const queue = entry === "reconnect" ? ["old-pending"] : [];
        let started: Promise<unknown> | undefined;
        try {
          if (entry === "reconnect") {
            expect((await xmpp.start()).toString()).toBe(FULL_JID);
            await enabled.promise;
            await flushWire(xmpp, first.peer);
            expect(xmpp.streamManagement.enabled).toBe(true);
            await xmpp.send(
              xml("message", { id: "old-pending", to: "bob@remote.test/r" }),
            );
            const disconnected = new Promise<void>((resolve) =>
              xmpp.once("disconnect", resolve),
            );
            first.peer.terminate();
            await disconnected;
            Object.assign(xmpp.options, { service: current.peer.url });
            await xmpp.reconnect.reconnect();
          } else {
            started = xmpp.start().catch((error: Error) => error);
          }
          await current.paused;
          expect(xmpp.status).toBe("open");
          const destinations = [
            "bob@remote.test/r",
            "bob@remote.test",
            "remote.test",
          ];
          // A former binding cannot authenticate a replacement connection.
          if (
            entry === "reconnect" &&
            (phase === "authentication" || protocol === "sasl")
          ) {
            destinations.push(ACCOUNT, `${ACCOUNT}/old-resource`);
          }
          for (const name of ["message", "presence", "iq"]) {
            for (const to of destinations) {
              const id = `forbidden-${name}-${to}`;
              const result = await xmpp
                .send(
                  xml(
                    name,
                    { id, to, ...(name === "iq" ? { type: "get" } : {}) },
                    name === "iq" ? xml("query", EXTENSION) : undefined,
                  ),
                )
                .then(
                  () => undefined,
                  (error: Error) => error,
                );
              expect(result).toBeInstanceOf(Error);
              expect(result?.message).toBe(
                "Stream negotiation is not complete",
              );
            }
          }
          await flushWire(xmpp, current.peer);
          expect(sent).toEqual([]);
          expect(
            current.peer.transcript.some((frame) =>
              frame.includes("forbidden-"),
            ),
          ).toBe(false);
          expect(
            xmpp.streamManagement.outbound_q.map(
              ({ stanza }: { stanza: Element }) => stanza.attrs.id,
            ),
          ).toEqual(queue);
          const online = new Promise<void>((resolve) =>
            xmpp.once("online", resolve),
          );
          current.complete();
          await online;
          expect(xmpp.jid?.toString()).toBe(FULL_JID);
          for (const name of ["message", "presence", "iq"]) {
            await xmpp.send(
              xml(
                name,
                {
                  id: `online-${name}`,
                  to: "bob@remote.test/r",
                  ...(name === "iq" ? { type: "get" } : {}),
                },
                name === "iq" ? xml("query", EXTENSION) : undefined,
              ),
            );
          }
          await flushWire(xmpp, current.peer);
          expect(
            current.peer.transcript.filter((frame) =>
              frame.includes('id="online-'),
            ),
          ).toHaveLength(3);
          expect(errors).toEqual([]);
          expect(first.peer.errors).toEqual([]);
          expect(current.peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await started;
          await first.peer.stop();
          await current.peer.stop();
        }
      },
    );
  }
}

test.each(["sasl", "sasl2"] as const)(
  "RFC 6120 §§4.3.5–4.3.6: server, confirmed self and extension boundaries during binding / %s",
  async (protocol) => {
    const { peer, paused, complete } = negotiationPeer("binding", protocol);
    const xmpp = client({
      service: peer.url,
      domain: "EXAMPLE.TEST",
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    const started = xmpp.start().catch((error: Error) => error);
    try {
      await paused;
      expect(xmpp.status).toBe("open");
      for (const name of ["message", "presence", "iq"]) {
        for (const to of [undefined, "example.test", "EXAMPLE.TEST"]) {
          await xmpp.send(
            xml(
              name,
              {
                id: `server-${name}-${to}`,
                to,
                ...(name === "iq" ? { type: "get" } : {}),
              },
              name === "iq" ? xml("query", EXTENSION) : undefined,
            ),
          );
        }
        await xmpp.send(
          xml(name, {
            xmlns: EXTENSION,
            id: `extension-${name}`,
            to: "remote.test",
          }),
        );
        for (const to of [
          ACCOUNT,
          `${ACCOUNT}/other-resource`,
          "E\u0301LISE@EXAMPLE.TEST/another-resource",
        ]) {
          const result = await xmpp
            .send(
              xml(
                name,
                {
                  id: `self-${name}-${to}`,
                  to,
                  ...(name === "iq" ? { type: "get" } : {}),
                },
                name === "iq" ? xml("query", EXTENSION) : undefined,
              ),
            )
            .then(
              () => undefined,
              (error: Error) => error,
            );
          if (protocol === "sasl2") {
            expect(result).toBeUndefined();
          } else {
            expect(result).toBeInstanceOf(Error);
            expect(result?.message).toBe("Stream negotiation is not complete");
          }
        }
        for (const to of [
          "configured@example.test/r",
          "other@example.test",
          "example.test/server-resource",
          "élise@remote.test/r",
        ]) {
          const result = await xmpp
            .send(
              xml(
                name,
                {
                  id: `forbidden-${name}-${to}`,
                  to,
                  ...(name === "iq" ? { type: "get" } : {}),
                },
                name === "iq" ? xml("query", EXTENSION) : undefined,
              ),
            )
            .then(
              () => undefined,
              (error: Error) => error,
            );
          expect(result).toBeInstanceOf(Error);
          expect(result?.message).toBe("Stream negotiation is not complete");
        }
      }
      await flushWire(xmpp, peer);
      expect(
        peer.transcript.filter((frame) => frame.includes('id="server-')),
      ).toHaveLength(9);
      expect(
        peer.transcript.filter((frame) => frame.includes('id="extension-')),
      ).toHaveLength(3);
      expect(
        peer.transcript.filter((frame) => frame.includes('id="self-')),
      ).toHaveLength(protocol === "sasl2" ? 9 : 0);
      expect(
        peer.transcript.some((frame) => frame.includes('id="forbidden-')),
      ).toBe(false);
      expect(xmpp.streamManagement.outbound_q).toEqual([]);
      complete();
      expect((await started).toString()).toBe(FULL_JID);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await started;
      await peer.stop();
    }
  },
);

test.each(["changed options", "open override"] as const)(
  "RFC 6120 §4.3.5: server authority follows the opened target, not configuration / %s",
  async (configuration) => {
    const { peer, paused, complete } = negotiationPeer("binding", "sasl2");
    const xmpp = client({
      service: peer.url,
      domain:
        configuration === "open override" ? "remote.test" : "example.test",
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    let started: Promise<unknown> | undefined;
    try {
      if (configuration === "open override") {
        await xmpp.connect(peer.url);
        await xmpp.open({ domain: "example.test" });
      } else {
        started = xmpp.start().catch((error: Error) => error);
      }
      await paused;
      Object.assign(xmpp.options, { domain: "remote.test" });
      expect(xmpp.status).toBe("open");
      const opening = readFrame(peer.transcript[0])[0];
      expect(opening && "open" in opening ? opening.open : undefined).toBe(
        `{${FRAMING}}open`,
      );
      expect(
        opening && "open" in opening ? opening.attributes["{}to"] : undefined,
      ).toBe("example.test");
      for (const to of [
        "remote.test",
        "remote.test/server-resource",
        "bob@remote.test/r",
        "example.test/server-resource",
      ]) {
        const result = await xmpp
          .send(xml("message", { to, id: `forbidden-${to}` }))
          .then(
            () => undefined,
            (error: Error) => error,
          );
        expect(result).toBeInstanceOf(Error);
        expect(result?.message).toBe("Stream negotiation is not complete");
      }
      for (const to of ["example.test", "EXAMPLE.TEST"]) {
        await xmpp.send(xml("message", { to, id: `server-${to}` }));
      }
      await flushWire(xmpp, peer);
      expect(
        peer.transcript.filter((frame) => frame.includes('id="server-')),
      ).toHaveLength(2);
      expect(
        peer.transcript.some((frame) => frame.includes('id="forbidden-')),
      ).toBe(false);
      expect(xmpp.streamManagement.outbound_q).toEqual([]);
      const online = new Promise<void>((resolve) =>
        xmpp.once("online", resolve),
      );
      complete();
      await online;
      expect(xmpp.jid?.toString()).toBe(FULL_JID);
      if (started) {
        expect((await started)?.toString()).toBe(FULL_JID);
      }
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await started;
      await peer.stop();
    }
  },
);

test("RFC 6120 §4.3.5 / XEP-0388 §2.6.1: a pending success proof grants no identity authority", async () => {
  const { peer } = negotiationPeer("binding", "sasl2");
  const proof = Promise.withResolvers<void>();
  const verifying = Promise.withResolvers<void>();
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "configured",
    timeout: TIMEOUT_MS,
    credentials: async (
      authenticate: (credentials: object, mechanism: string) => Promise<void>,
    ) => {
      await authenticate({}, PROOF_MECHANISM);
    },
  });
  xmpp.saslMechanisms.register(PROOF_MECHANISM, () => ({
    name: PROOF_MECHANISM,
    clientFirst: true,
    response: () => "",
    final: async () => {
      verifying.resolve();
      await proof.promise;
    },
  }));
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  const started = xmpp.start().catch((error: Error) => error);
  try {
    await verifying.promise;
    for (const to of [
      ACCOUNT,
      `${ACCOUNT}/other-resource`,
      "configured@example.test/r",
    ]) {
      const result = await xmpp
        .send(xml("message", { to, id: `forbidden-${to}` }))
        .then(
          () => undefined,
          (error: Error) => error,
        );
      expect(result).toBeInstanceOf(Error);
      expect(result?.message).toBe("Stream negotiation is not complete");
    }
    await flushWire(xmpp, peer);
    expect(
      peer.transcript.some((frame) => frame.includes('id="forbidden-')),
    ).toBe(false);
    expect(peer.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
      false,
    );
    expect(xmpp.streamManagement.outbound_q).toEqual([]);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    proof.resolve();
    await started;
    await peer.stop();
  }
});

test.each(["stop", "disconnect"] as const)(
  "RFC 6120 §§4.3.5–4.3.6: cancellation and a late proof cannot restore a former account / %s",
  async (action) => {
    const first = negotiationPeer("binding", "sasl2");
    const second = negotiationPeer("binding", "sasl2", "next@example.test");
    const proof = Promise.withResolvers<void>();
    const verifying = Promise.withResolvers<void>();
    const xmpp = client({
      service: first.peer.url,
      domain: "example.test",
      username: "configured",
      timeout: TIMEOUT_MS,
      credentials: async (
        authenticate: (credentials: object, mechanism: string) => Promise<void>,
      ) => {
        await authenticate({}, PROOF_MECHANISM);
      },
    });
    let attempts = 0;
    xmpp.saslMechanisms.register(PROOF_MECHANISM, () => ({
      name: PROOF_MECHANISM,
      clientFirst: true,
      response: () => "",
      final: async () => {
        if (++attempts === 1) {
          verifying.resolve();
          await proof.promise;
        }
      },
    }));
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    const started = xmpp.start().catch((error: Error) => error);
    let restarted: Promise<unknown> | undefined;
    try {
      await verifying.promise;
      if (action === "stop") {
        await xmpp.stop();
      } else {
        const disconnected = new Promise<void>((resolve) =>
          xmpp.once("disconnect", resolve),
        );
        first.peer.terminate();
        await disconnected;
      }
      expect(await started).toBeInstanceOf(Error);
      Object.assign(xmpp.options, { service: second.peer.url });
      if (action === "stop") {
        restarted = xmpp.start().catch((error: Error) => error);
      } else {
        await xmpp.reconnect.reconnect();
      }
      await second.paused;
      for (const timing of ["before", "after"] as const) {
        await xmpp.send(
          xml("message", {
            to: "NEXT@EXAMPLE.TEST/another",
            id: `confirmed-${timing}`,
          }),
        );
        for (const to of [
          ACCOUNT,
          `${ACCOUNT}/other-resource`,
          "configured@example.test/r",
        ]) {
          const result = await xmpp
            .send(xml("message", { to, id: `forbidden-${timing}-${to}` }))
            .then(
              () => undefined,
              (error: Error) => error,
            );
          expect(result).toBeInstanceOf(Error);
          expect(result?.message).toBe("Stream negotiation is not complete");
        }
        proof.resolve();
        await flushWire(xmpp, second.peer);
      }
      expect(
        second.peer.transcript.some((frame) =>
          frame.includes('id="forbidden-'),
        ),
      ).toBe(false);
      expect(
        second.peer.transcript.filter((frame) =>
          frame.includes('id="confirmed-'),
        ),
      ).toHaveLength(2);
      const online = new Promise<void>((resolve) =>
        xmpp.once("online", resolve),
      );
      second.complete();
      await online;
      expect(xmpp.jid?.toString()).toBe("next@example.test/server-resource");
      await xmpp.send(
        xml("message", { to: "remote.test", id: "online-recovered" }),
      );
      await flushWire(xmpp, second.peer);
      expect(
        second.peer.transcript.some((frame) =>
          frame.includes('id="online-recovered"'),
        ),
      ).toBe(true);
      expect(attempts).toBe(2);
      expect(errors).toEqual([]);
      expect(first.peer.errors).toEqual([]);
      expect(second.peer.errors).toEqual([]);
    } finally {
      proof.resolve();
      await xmpp.stop();
      await started;
      await restarted;
      await first.peer.stop();
      await second.peer.stop();
    }
  },
);

test.each(["sasl", "sasl2"] as const)(
  "RFC 6120 §§4.3.5–4.3.6: reopening retains only authenticated self authority / %s",
  async (protocol) => {
    const { peer, paused, complete } = negotiationPeer("reopen", protocol);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      expect((await xmpp.start()).toString()).toBe(FULL_JID);
      await xmpp.restart();
      await paused;
      const result = await xmpp
        .send(xml("message", { to: "remote.test", id: "forbidden-reopen" }))
        .catch((error: Error) => error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("Stream negotiation is not complete");
      await xmpp.send(
        xml("message", { to: `${ACCOUNT}/another`, id: "self-reopen" }),
      );
      await flushWire(xmpp, peer);
      expect(
        peer.transcript.some((frame) =>
          frame.includes('id="forbidden-reopen"'),
        ),
      ).toBe(false);
      expect(
        peer.transcript.some((frame) => frame.includes('id="self-reopen"')),
      ).toBe(true);
      const online = new Promise<void>((resolve) =>
        xmpp.once("online", resolve),
      );
      complete();
      await online;
      await xmpp.send(
        xml("message", { to: "remote.test", id: "online-reopen" }),
      );
      await flushWire(xmpp, peer);
      expect(
        peer.transcript.some((frame) => frame.includes('id="online-reopen"')),
      ).toBe(true);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

for (const mode of ["ordinary", "inline"] as const) {
  test.each([
    ["valid", "routing-session", "1"],
    ["wrong-id", "other-session", "1"],
    ["invalid-counter", "routing-session", "4"],
  ] as const)(
    `RFC 6120 §4.3.5 / XEP-0198 §§5,9.2: ${mode} remote replay requires validated resumption / %s`,
    async (kind, previd, h) => {
      const first = negotiationPeer("ready", "sasl2");
      const paused = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const response = `<resumed xmlns="${SM}" previd="${previd}" h="${h}"/>`;
      let authenticated = false;
      const second = new ScriptedPeer((frame, remote) => {
        const el = readFrame(frame)[0];
        if (!el || !("open" in el)) {
          throw new Error("Expected a client element");
        }
        if (el.open === `{${FRAMING}}open`) {
          remote.send(
            `<open xmlns="${FRAMING}" from="example.test" id="resumed-routing" version="1.0"/>`,
          );
          remote.send(
            authenticated
              ? `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/><sm xmlns="${SM}"/></features>`
              : mode === "ordinary"
                ? `<features xmlns="${STREAM}"><mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms></features>`
                : `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><inline><sm xmlns="${SM}"/><bind xmlns="${BIND2}"/></inline></authentication></features>`,
          );
        } else if (el.open === `{${SASL}}auth`) {
          authenticated = true;
          remote.send(`<success xmlns="${SASL}"/>`);
        } else if (el.open === `{${SASL2}}authenticate`) {
          remote.send(
            `<success xmlns="${SASL2}"><authorization-identifier>${FULL_JID}</authorization-identifier><hold xmlns="${EXTENSION}"/>${response}</success>`,
          );
        } else if (el.open === `{${SM}}resume`) {
          paused.resolve();
        } else if (el.open === `{${FRAMING}}close`) {
          remote.send(`<close xmlns="${FRAMING}"/>`);
        }
      });
      const xmpp = client({
        service: first.peer.url,
        domain: "example.test",
        username: "configured",
        password: "secret",
        timeout: TIMEOUT_MS,
      });
      xmpp.reconnect.stop();
      xmpp.sasl2.use(
        EXTENSION,
        async () => undefined,
        async () => {
          paused.resolve();
          await release.promise;
        },
      );
      const enabled = Promise.withResolvers<void>();
      xmpp.on("nonza", (element: Element) => {
        if (element.is("enabled", SM)) {
          enabled.resolve();
        }
      });
      const sm = xmpp.streamManagement;
      sm.requestAckInterval = 0;
      const errors: Error[] = [];
      xmpp.on("error", (error: Error) => errors.push(error));
      const acks: string[] = [];
      sm.on("ack", (stanza: Element) => acks.push(stanza.attrs.id));
      const order: string[] = [];
      let reconnecting = false;
      xmpp.on("send", (stanza: Element) => {
        if (reconnecting && stanza.attrs.id?.startsWith("pending-")) {
          order.push(stanza.attrs.id);
        }
      });
      xmpp.on("status", (status: string) => {
        if (reconnecting && status === "online") {
          order.push("online");
        }
      });
      try {
        expect((await xmpp.start()).toString()).toBe(FULL_JID);
        await enabled.promise;
        await flushWire(xmpp, first.peer);
        for (const [index, name] of ["message", "presence", "iq"].entries()) {
          await xmpp.send(
            xml(
              name,
              {
                id: `pending-${index}`,
                to: "bob@remote.test/r",
                ...(name === "iq" ? { type: "get" } : {}),
              },
              name === "iq" ? xml("query", EXTENSION) : undefined,
            ),
          );
        }
        await flushWire(xmpp, first.peer);
        const disconnected = new Promise<void>((resolve) =>
          xmpp.once("disconnect", resolve),
        );
        first.peer.terminate();
        await disconnected;
        reconnecting = true;
        Object.assign(xmpp.options, { service: second.url });
        let earlySend: Promise<unknown> | undefined;
        xmpp.once("connect", () => {
          earlySend = xmpp
            .send(
              xml("message", { id: "forbidden-connect", to: "remote.test" }),
            )
            .catch((error: Error) => error);
        });
        await xmpp.reconnect.reconnect();
        await paused.promise;
        const earlyResult = await earlySend;
        expect(earlyResult).toBeInstanceOf(Error);
        expect((earlyResult as Error).message).toBe(
          "Stream negotiation is not complete",
        );
        for (const name of ["message", "presence", "iq"]) {
          const result = await xmpp
            .send(
              xml(
                name,
                {
                  id: `forbidden-${name}`,
                  to: "remote.test",
                  ...(name === "iq" ? { type: "get" } : {}),
                },
                name === "iq" ? xml("query", EXTENSION) : undefined,
              ),
            )
            .catch((error: Error) => error);
          expect(result).toBeInstanceOf(Error);
          expect(result.message).toBe("Stream negotiation is not complete");
        }
        if (mode === "inline") {
          // A verified full aid confirms this account, not the former SM session.
          await xmpp.send(
            xml("message", {
              id: "self-before-resume",
              to: `${ACCOUNT}/another`,
            }),
          );
        }
        await flushWire(xmpp, second);
        expect(
          second.transcript.some((frame) => frame.includes('id="forbidden-')),
        ).toBe(false);
        expect(
          sm.outbound_q.map(
            ({ stanza }: { stanza: Element }) => stanza.attrs.id,
          ),
        ).toEqual(["pending-0", "pending-1", "pending-2"]);
        expect(acks).toEqual([]);
        expect(order).toEqual([]);
        const settled = new Promise<string>((resolve) => {
          const finish = (status: string) => {
            xmpp.off("status", onStatus);
            xmpp.off("disconnect", onDisconnect);
            xmpp.off("error", onError);
            resolve(status);
          };
          const onStatus = (status: string) => {
            if (status === "online") {
              finish(status);
            }
          };
          const onDisconnect = () => finish("disconnect");
          const onError = () => finish("error");
          xmpp.on("status", onStatus);
          xmpp.once("disconnect", onDisconnect);
          xmpp.once("error", onError);
        });
        if (mode === "ordinary") {
          second.send(response);
        } else {
          release.resolve();
        }
        expect(await settled).toBe(kind === "valid" ? "online" : "disconnect");
        if (kind === "valid") {
          await flushWire(xmpp, second);
          expect(acks).toEqual(["pending-0"]);
          expect(
            sm.outbound_q.map(
              ({ stanza }: { stanza: Element }) => stanza.attrs.id,
            ),
          ).toEqual(["pending-1", "pending-2"]);
          expect(order).toEqual(["pending-1", "pending-2", "online"]);
          expect(
            second.transcript.filter((frame) => frame.includes('id="pending-')),
          ).toHaveLength(2);
          await xmpp.send(
            xml("message", { id: "online-resumed", to: "remote.test" }),
          );
          await flushWire(xmpp, second);
          expect(
            second.transcript.some((frame) =>
              frame.includes('id="online-resumed"'),
            ),
          ).toBe(true);
        } else {
          await second.waitForClose();
          expect(acks).toEqual([]);
          expect(order).toEqual([]);
          expect(
            sm.outbound_q.map(
              ({ stanza }: { stanza: Element }) => stanza.attrs.id,
            ),
          ).toEqual(["pending-0", "pending-1", "pending-2"]);
          expect(
            second.transcript.some((frame) => frame.includes('id="pending-')),
          ).toBe(false);
        }
        expect(errors).toEqual([]);
        expect(first.peer.errors).toEqual([]);
        expect(second.errors).toEqual([]);
      } finally {
        release.resolve();
        await xmpp.stop();
        await first.peer.stop();
        await second.stop();
      }
    },
  );
}
