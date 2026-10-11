import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const CLIENT = "jabber:client";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const FAST = "urn:xmpp:fast:0";
const ACCOUNT = "authorized@example.test";
const FULL_JID = `${ACCOUNT}/old`;
const SESSION_ID = "authorization-session";
const NEW_SESSION_ID = "replacement-session";
const TIMEOUT_MS = 300;

function readRoot(frame: string) {
  const root = readFrame(frame)[0];
  if (!root || !("open" in root)) {
    throw new Error("Expected a client element");
  }

  return root;
}

function initialResumablePeer() {
  return new ScriptedPeer((frame, peer) => {
    const root = readRoot(frame);
    if (root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="initial" version="1.0"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism></authentication></features>`,
      );
    } else if (root.open === `{${SASL2}}authenticate`) {
      peer.send(
        `<success xmlns="${SASL2}"><authorization-identifier>${ACCOUNT}</authorization-identifier></success>`,
      );
      peer.send(
        `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/><sm xmlns="${SM}"/></features>`,
      );
    } else if (root.open === `{${CLIENT}}iq`) {
      peer.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${FULL_JID}</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      peer.send(`<enabled xmlns="${SM}" id="${SESSION_ID}" resume="true"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

function inlineResumptionPeer(
  identifier: string,
  result = `<resumed xmlns="${SM}" previd="${SESSION_ID}" h="0"/>`,
  token = "",
  features: "absent" | "classic-binding" | "empty" = "absent",
) {
  return new ScriptedPeer((frame, peer) => {
    const root = readRoot(frame);
    if (root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="replacement" version="1.0"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><inline><sm xmlns="${SM}"/><bind xmlns="${BIND2}"/></inline></authentication></features>`,
      );
    } else if (root.open === `{${SASL2}}authenticate`) {
      peer.send(
        `<success xmlns="${SASL2}"><authorization-identifier>${identifier}</authorization-identifier>${token}${result}</success>`,
      );
      if (features !== "absent") {
        peer.send(
          `<features xmlns="${STREAM}">${features === "classic-binding" ? `<bind xmlns="${BIND}"/>` : ""}</features>`,
        );
      }
    } else if (root.open === `{${CLIENT}}iq`) {
      peer.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${ACCOUNT}/new</jid></bind></iq>`,
      );
    } else if (root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

function resumableClient(service: string) {
  const xmpp = client({
    service,
    domain: "example.test",
    username: "configured",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const sm = xmpp.streamManagement;
  sm.requestAckInterval = 0;
  const enabled = Promise.withResolvers<void>();
  xmpp.on("nonza", (element: Element) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    }
  });

  return { enabled: enabled.promise, sm, xmpp };
}

test.each([
  ["bare", ACCOUNT],
  ["full", FULL_JID],
  ["normalized full", "AUTHORIZED@ＥＸＡＭＰＬＥ。TEST/old"],
] as const)(
  "XEP-0388 §2.6.1 example 9 / XEP-0198 §9.2: %s resumed identity retains authority and replays once",
  async (_shape, identifier) => {
    const first = initialResumablePeer();
    const second = inlineResumptionPeer(identifier);
    const { enabled, sm, xmpp } = resumableClient(first.url);
    let online = 0;
    let resumedCount = 0;
    xmpp.on("status", (status) => {
      if (status === "online") {
        online += 1;
      }
    });
    sm.on("resumed", () => {
      resumedCount += 1;
    });
    try {
      expect((await xmpp.start()).toString()).toBe(FULL_JID);
      await enabled;
      await setImmediate();
      await xmpp.send(xml("message", { from: FULL_JID, id: "queued" }));
      while (!first.transcript.some((frame) => frame.includes('id="queued"'))) {
        await first.next();
      }
      const disconnected = new Promise<void>((resolve) =>
        xmpp.once("disconnect", resolve),
      );
      first.terminate();
      await disconnected;
      online = 0;
      resumedCount = 0;
      Object.assign(xmpp.options, { service: second.url });
      const resumed = new Promise<void>((resolve) =>
        sm.once("resumed", resolve),
      );
      await xmpp.reconnect.reconnect();
      await resumed;
      while (!second.transcript.some((frame) => frame.startsWith("<message"))) {
        await second.next();
      }
      await setImmediate();
      const replay = second.transcript.filter((frame) =>
        frame.startsWith("<message"),
      );
      expect(replay).toHaveLength(1);
      expect(readFrame(replay[0])[0]).toMatchObject({
        open: `{${CLIENT}}message`,
        attributes: { "{}from": FULL_JID, "{}id": "queued" },
      });
      expect(xmpp.jid?.toString()).toBe(FULL_JID);
      expect(xmpp.status).toBe("online");
      expect(resumedCount).toBe(1);
      expect(online).toBe(1);
      expect(
        second.transcript.filter((frame) => frame.startsWith("<open")),
      ).toHaveLength(1);
      expect(second.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
        false,
      );
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await first.stop();
      await second.stop();
    }
  },
);

const TOKEN = `<token xmlns="${FAST}" token="must-not-save" expiry="2099-01-01T00:00:00Z"/>`;

test.each([
  [
    "another bare account",
    "other@example.test",
    `<resumed xmlns="${SM}" previd="${SESSION_ID}" h="1"/>`,
    "absent",
  ],
  [
    "another full account",
    "other@example.test/old",
    `<resumed xmlns="${SM}" previd="${SESSION_ID}" h="1"/>`,
    "absent",
  ],
  [
    "another resource",
    `${ACCOUNT}/new`,
    `<resumed xmlns="${SM}" previd="${SESSION_ID}" h="1"/>`,
    "absent",
  ],
  [
    "wrong session identifier",
    FULL_JID,
    `<resumed xmlns="${SM}" previd="other-session" h="1"/>`,
    "absent",
  ],
  [
    "invalid handled counter",
    FULL_JID,
    `<resumed xmlns="${SM}" previd="${SESSION_ID}" h="invalid"/>`,
    "absent",
  ],
  [
    "duplicate resumption result",
    FULL_JID,
    `<resumed xmlns="${SM}" previd="${SESSION_ID}" h="1"/><resumed xmlns="${SM}" previd="${SESSION_ID}" h="1"/>`,
    "absent",
  ],
  [
    "duplicate failed result",
    ACCOUNT,
    `<failed xmlns="${SM}"/><failed xmlns="${SM}"/>`,
    "classic-binding",
  ],
  [
    "failed and resumed results",
    FULL_JID,
    `<failed xmlns="${SM}"/><resumed xmlns="${SM}" previd="${SESSION_ID}" h="1"/>`,
    "absent",
  ],
  [
    "resumed and bound results",
    FULL_JID,
    `<resumed xmlns="${SM}" previd="${SESSION_ID}" h="1"/><bound xmlns="${BIND2}"/>`,
    "absent",
  ],
] as const)(
  "XEP-0388 §2.6.1 / XEP-0198 §§5, 9.2: reject %s before token, ack, or replay",
  async (_case, identifier, result, features) => {
    const first = initialResumablePeer();
    const second = inlineResumptionPeer(
      identifier,
      result,
      TOKEN,
      features ?? "absent",
    );
    const { enabled, sm, xmpp } = resumableClient(first.url);
    let tokens = 0;
    const fast = xmpp.fast as unknown as {
      saveToken: (token: unknown) => Promise<void>;
    };
    fast.saveToken = async () => {
      tokens += 1;
    };
    xmpp.on("error", () => {});
    try {
      expect((await xmpp.start()).toString()).toBe(FULL_JID);
      await enabled;
      await setImmediate();
      await xmpp.send(xml("message", { from: FULL_JID, id: "queued" }));
      while (!first.transcript.some((frame) => frame.includes('id="queued"'))) {
        await first.next();
      }
      const disconnected = new Promise<void>((resolve) =>
        xmpp.once("disconnect", resolve),
      );
      first.terminate();
      await disconnected;
      Object.assign(xmpp.options, { service: second.url });
      const outcome = Promise.withResolvers<
        { kind: "closed" | "ready" } | { kind: "error"; error: Error }
      >();
      xmpp.once("close", () => outcome.resolve({ kind: "closed" }));
      xmpp.once("error", (error: Error) =>
        outcome.resolve({ kind: "error", error }),
      );
      sm.once("resumed", () => outcome.resolve({ kind: "ready" }));
      xmpp.once("online", () => outcome.resolve({ kind: "ready" }));
      await xmpp.reconnect
        .reconnect()
        .catch((error: Error) => outcome.resolve({ kind: "error", error }));
      const observed = await outcome.promise;
      expect(observed.kind).not.toBe("ready");
      if (observed.kind === "error") {
        expect(observed.error.name).not.toBe("TimeoutError");
      }
      expect(tokens).toBe(0);
      expect(xmpp.jid?.toString()).toBe(FULL_JID);
      expect(xmpp.status).not.toBe("online");
      expect(
        second.transcript.some((frame) => frame.startsWith("<message")),
      ).toBe(false);
      expect(
        sm.outbound_q.map(({ stanza }: { stanza: Element }) => stanza.attrs.id),
      ).toEqual(["queued"]);
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await first.stop();
      await second.stop();
    }
  },
);

test.each([
  [
    "failed before bound",
    `<failed xmlns="${SM}"/><bound xmlns="${BIND2}"><enabled xmlns="${SM}" id="${NEW_SESSION_ID}" resume="true"/></bound>`,
  ],
  [
    "bound before failed",
    `<bound xmlns="${BIND2}"><enabled xmlns="${SM}" id="${NEW_SESSION_ID}" resume="true"/></bound><failed xmlns="${SM}"/>`,
  ],
] as const)(
  "XEP-0388 §2.6.1 / XEP-0198 §9.2: failed resumption preserves replacement binding / %s",
  async (_order, result) => {
    const first = initialResumablePeer();
    const second = inlineResumptionPeer(`${ACCOUNT}/new`, result, "", "empty");
    const { enabled, sm, xmpp } = resumableClient(first.url);
    try {
      expect((await xmpp.start()).toString()).toBe(FULL_JID);
      await enabled;
      await setImmediate();
      const disconnected = new Promise<void>((resolve) =>
        xmpp.once("disconnect", resolve),
      );
      first.terminate();
      await disconnected;
      Object.assign(xmpp.options, { service: second.url });
      const online = new Promise<void>((resolve) =>
        xmpp.on("status", (status) => {
          if (status === "online") {
            resolve();
          }
        }),
      );
      await xmpp.reconnect.reconnect();
      await online;
      await setImmediate();
      expect(xmpp.jid?.toString()).toBe(`${ACCOUNT}/new`);
      expect(sm.enabled).toBe(true);
      expect(sm.id).toBe(NEW_SESSION_ID);
      expect(xmpp.status).toBe("online");
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await first.stop();
      await second.stop();
    }
  },
);

test("XEP-0198 §9.2: invalid failed counter has no token, identity, or binding side effects", async () => {
  const first = initialResumablePeer();
  const second = inlineResumptionPeer(
    `${ACCOUNT}/new`,
    `<failed xmlns="${SM}" h="invalid"/><bound xmlns="${BIND2}"><enabled xmlns="${SM}" id="${NEW_SESSION_ID}" resume="true"/></bound>`,
    TOKEN,
    "empty",
  );
  const { enabled, sm, xmpp } = resumableClient(first.url);
  let tokens = 0;
  const fast = xmpp.fast as unknown as {
    saveToken: (token: unknown) => Promise<void>;
  };
  fast.saveToken = async () => {
    tokens += 1;
  };
  xmpp.on("error", () => {});
  try {
    expect((await xmpp.start()).toString()).toBe(FULL_JID);
    await enabled;
    await setImmediate();
    const disconnected = new Promise<void>((resolve) =>
      xmpp.once("disconnect", resolve),
    );
    first.terminate();
    await disconnected;
    Object.assign(xmpp.options, { service: second.url });
    const outcome = Promise.withResolvers<"closed" | "error" | "online">();
    xmpp.once("close", () => outcome.resolve("closed"));
    xmpp.once("error", () => outcome.resolve("error"));
    xmpp.on("status", (status) => {
      if (status === "online") {
        outcome.resolve("online");
      }
    });
    await xmpp.reconnect.reconnect().catch(() => outcome.resolve("error"));
    expect(await outcome.promise).not.toBe("online");
    expect(tokens).toBe(0);
    expect(xmpp.jid?.toString()).toBe(FULL_JID);
    expect(sm.enabled).toBe(false);
    expect(sm.id).not.toBe(NEW_SESSION_ID);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await first.stop();
    await second.stop();
  }
});

test("XEP-0388 §2.6.1: cancellation during failed resumption stops success side effects", async () => {
  const first = initialResumablePeer();
  const second = inlineResumptionPeer(
    `${ACCOUNT}/new`,
    `<failed xmlns="${SM}"/><bound xmlns="${BIND2}"><enabled xmlns="${SM}" id="${NEW_SESSION_ID}" resume="true"/></bound>`,
    TOKEN,
    "empty",
  );
  const { enabled, sm, xmpp } = resumableClient(first.url);
  const failed = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let tokens = 0;
  let online = 0;
  const fast = xmpp.fast as unknown as {
    saveToken: (token: unknown) => Promise<void>;
  };
  fast.saveToken = async () => {
    tokens += 1;
  };
  xmpp.on("status", (status) => {
    if (status === "online") {
      online += 1;
    }
  });
  xmpp.on("error", () => {});
  xmpp.sasl2.use(
    SM,
    () =>
      xml("resume", {
        xmlns: SM,
        h: sm.inbound,
        previd: sm.id,
      }),
    async (element: Element) => {
      if (!element.is("failed", SM)) {
        return;
      }
      failed.resolve();
      await xmpp.stop();
      stopped.resolve();
    },
  );
  try {
    expect((await xmpp.start()).toString()).toBe(FULL_JID);
    await enabled;
    await setImmediate();
    await xmpp.send(xml("message", { from: FULL_JID, id: "queued" }));
    while (!first.transcript.some((frame) => frame.includes('id="queued"'))) {
      await first.next();
    }
    const disconnected = new Promise<void>((resolve) =>
      xmpp.once("disconnect", resolve),
    );
    first.terminate();
    await disconnected;
    online = 0;
    Object.assign(xmpp.options, { service: second.url });
    await xmpp.reconnect.reconnect();
    await failed.promise;
    await stopped.promise;
    await setImmediate();
    expect(xmpp.jid?.toString()).toBe(FULL_JID);
    expect(tokens).toBe(0);
    expect(online).toBe(0);
    expect(sm.id).not.toBe(NEW_SESSION_ID);
    expect(sm.enabled).toBe(false);
    expect(
      second.transcript.some((frame) => frame.startsWith("<message")),
    ).toBe(false);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await first.stop();
    await second.stop();
  }
});

test.each([
  ["bare identifier without binding", ACCOUNT, "", "classic-binding"],
  [
    "full identifier with new binding",
    `${ACCOUNT}/new`,
    `<bound xmlns="${BIND2}"><enabled xmlns="${SM}" id="${NEW_SESSION_ID}" resume="true"/></bound>`,
    "empty",
  ],
] as const)(
  "XEP-0198 §9.2: requested resumption rejects a missing outcome / %s",
  async (_case, identifier, result, features) => {
    const first = initialResumablePeer();
    const second = inlineResumptionPeer(identifier, result, TOKEN, features);
    const { enabled, sm, xmpp } = resumableClient(first.url);
    let tokens = 0;
    const errors: Error[] = [];
    const fast = xmpp.fast as unknown as {
      saveToken: (token: unknown) => Promise<void>;
    };
    fast.saveToken = async () => {
      tokens += 1;
    };
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      expect((await xmpp.start()).toString()).toBe(FULL_JID);
      await enabled;
      await setImmediate();
      await xmpp.send(xml("message", { from: FULL_JID, id: "queued" }));
      while (!first.transcript.some((frame) => frame.includes('id="queued"'))) {
        await first.next();
      }
      const disconnected = new Promise<void>((resolve) =>
        xmpp.once("disconnect", resolve),
      );
      first.terminate();
      await disconnected;
      Object.assign(xmpp.options, { service: second.url });
      const outcome = Promise.withResolvers<"closed" | "error" | "online">();
      xmpp.once("close", () => outcome.resolve("closed"));
      xmpp.once("error", () => outcome.resolve("error"));
      xmpp.on("status", (status) => {
        if (status === "online") {
          outcome.resolve("online");
        }
      });
      await xmpp.reconnect.reconnect().catch(() => outcome.resolve("error"));
      const observed = await outcome.promise;
      expect(observed).not.toBe("online");
      if (observed === "error") {
        expect(errors[0]?.name).not.toBe("TimeoutError");
      }
      expect(tokens).toBe(0);
      expect(xmpp.jid?.toString()).toBe(FULL_JID);
      expect(sm.id).toBe(SESSION_ID);
      expect(sm.enabled).toBe(false);
      expect(
        sm.outbound_q.map(({ stanza }: { stanza: Element }) => stanza.attrs.id),
      ).toEqual(["queued"]);
      expect(
        second.transcript.some((frame) => frame.startsWith("<message")),
      ).toBe(false);
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await first.stop();
      await second.stop();
    }
  },
);

test("XEP-0198 §9.2.1: failed inline resumption can continue with classic binding", async () => {
  const first = initialResumablePeer();
  const second = inlineResumptionPeer(
    ACCOUNT,
    `<failed xmlns="${SM}"/>`,
    "",
    "classic-binding",
  );
  const { enabled, sm, xmpp } = resumableClient(first.url);
  const failed = Promise.withResolvers<void>();
  sm.once("fail", () => failed.resolve());
  try {
    await xmpp.start();
    await enabled;
    await setImmediate();
    await xmpp.send(xml("message", { id: "queued" }));
    const disconnected = new Promise<void>((resolve) =>
      xmpp.once("disconnect", resolve),
    );
    first.terminate();
    await disconnected;
    Object.assign(xmpp.options, { service: second.url });
    const online = new Promise<void>((resolve) =>
      xmpp.on("status", (status) => {
        if (status === "online") {
          resolve();
        }
      }),
    );
    await xmpp.reconnect.reconnect();
    await Promise.all([failed.promise, online]);
    expect(xmpp.jid?.toString()).toBe(`${ACCOUNT}/new`);
    expect(sm.id).toBe("");
    expect(sm.enabled).toBe(false);
    expect(sm.outbound_q).toEqual([]);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await first.stop();
    await second.stop();
  }
});

function postAuthenticationResumptionPeer(identifier: string) {
  return new ScriptedPeer((frame, peer) => {
    const root = readRoot(frame);
    if (root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="ordinary" version="1.0"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism></authentication></features>`,
      );
    } else if (root.open === `{${SASL2}}authenticate`) {
      peer.send(
        `<success xmlns="${SASL2}"><authorization-identifier>${identifier}</authorization-identifier></success>`,
      );
      peer.send(`<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`);
    } else if (root.open === `{${SM}}resume`) {
      peer.send(`<resumed xmlns="${SM}" previd="${SESSION_ID}" h="0"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

test.each([
  ["retained account", ACCOUNT, "accepted"],
  ["different confirmed account", "other@example.test", "rejected"],
] as const)(
  "XEP-0198 §5: post-authentication resumption with %s",
  async (_case, identifier, expectation) => {
    const first = initialResumablePeer();
    const second = postAuthenticationResumptionPeer(identifier);
    const { enabled, sm, xmpp } = resumableClient(first.url);
    xmpp.on("error", () => {});
    try {
      expect((await xmpp.start()).toString()).toBe(FULL_JID);
      await enabled;
      await setImmediate();
      const disconnected = new Promise<void>((resolve) =>
        xmpp.once("disconnect", resolve),
      );
      first.terminate();
      await disconnected;
      Object.assign(xmpp.options, { service: second.url });
      const outcome = Promise.withResolvers<"closed" | "error" | "resumed">();
      xmpp.once("close", () => outcome.resolve("closed"));
      xmpp.once("error", () => outcome.resolve("error"));
      sm.once("resumed", () => outcome.resolve("resumed"));
      await xmpp.reconnect.reconnect().catch(() => outcome.resolve("error"));
      const observed = await outcome.promise;
      if (expectation === "accepted") {
        expect(observed).toBe("resumed");
      } else {
        expect(observed).not.toBe("resumed");
      }
      expect(xmpp.jid?.toString()).toBe(
        expectation === "accepted" ? FULL_JID : identifier,
      );
      expect(xmpp.status === "online").toBe(expectation === "accepted");
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await first.stop();
      await second.stop();
    }
  },
);
