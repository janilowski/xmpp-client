import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import TimeoutError from "../src/events/lib/TimeoutError.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const SASL2 = "urn:xmpp:sasl:2";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const TIMEOUT_MS = 150;
const WATCHDOG_MS = TIMEOUT_MS * 4;
const PROOF_MECHANISM = "TEST-FEATURES";

// XEP-0388 v1.0.4 §2.6.1: success is followed by features without a restart.
// XEP-0198 v1.6.3 §9.2: successful inline resumption forbids those features.
// The deadline below is client policy, not a duration prescribed by either XEP.
type Binding = "classic" | "inline" | "resume" | "failed-resume";

function sasl2Peer(binding: Binding, offer: "present" | "missing") {
  return new ScriptedPeer((frame, peer) => {
    const el = readFrame(frame)[0];
    if (!el || !("open" in el)) {
      throw new Error("Expected a client element");
    }
    if (el.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="sasl2" version="1.0"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><mechanism>${PROOF_MECHANISM}</mechanism>${binding === "classic" ? "" : `<inline><sm xmlns="${SM}"/><bind xmlns="${BIND2}"/></inline>`}</authentication></features>`,
      );
    } else if (el.open === `{${SASL2}}authenticate`) {
      const result =
        binding === "resume"
          ? `<resumed xmlns="${SM}" previd="session" h="0"/>`
          : binding === "classic"
            ? ""
            : `${binding === "failed-resume" ? `<failed xmlns="${SM}"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></failed>` : ""}<bound xmlns="${BIND2}"/>`;
      peer.send(
        `<success xmlns="${SASL2}"><authorization-identifier>user@example.test${binding === "classic" ? "" : "/r"}</authorization-identifier>${result}</success>`,
      );
      if (offer === "present") {
        peer.send(
          `<features xmlns="${STREAM}">${binding === "classic" ? `<bind xmlns="${BIND}"/>` : ""}<sm xmlns="${SM}"/></features>`,
        );
      }
    } else if (el.open === "{jabber:client}iq") {
      peer.send(
        `<iq xmlns="jabber:client" type="result" id="${el.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (el.open === `{${SM}}enable`) {
      peer.send(`<enabled xmlns="${SM}" id="session" resume="true"/>`);
    } else if (el.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

test.each([
  ["start", "classic"],
  ["start", "inline"],
  ["reconnect", "classic"],
  ["reconnect", "inline"],
] as const)(
  "XEP-0388 §2.6.1: missing post-success features hit the local deadline / %s / %s",
  async (entry, binding) => {
    const peer = sasl2Peer(binding, "missing");
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const failure = Promise.withResolvers<Error>();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => {
      errors.push(error);
      failure.resolve(error);
    });
    let online = 0;
    xmpp.on("online", () => {
      online++;
    });
    const listeners = xmpp.listenerCount("nonza");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = (
      entry === "start" ? xmpp.start() : xmpp.reconnect.reconnect()
    ).catch((error: Error) => error);
    try {
      const result = await Promise.race([
        failure.promise,
        new Promise<Error>((resolve) => {
          timer = setTimeout(
            () => resolve(new Error("Features deadline was not enforced")),
            WATCHDOG_MS,
          );
        }),
      ]);
      expect(result).toBeInstanceOf(TimeoutError);
      expect(result.message).toBe("Timed out waiting for stream features");
      await peer.waitForClose();
      expect(errors).toEqual([result]);
      expect(online).toBe(binding === "inline" ? 1 : 0);
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<authenticate")),
      ).toHaveLength(1);
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<open")),
      ).toHaveLength(1);
      expect(peer.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
        false,
      );
      expect(peer.transcript.at(-1)).toBe(`<close xmlns="${FRAMING}"/>`);
      expect(xmpp.listenerCount("nonza")).toBe(listeners);
      expect(peer.errors).toEqual([]);
    } finally {
      clearTimeout(timer);
      await xmpp.stop();
      await started;
      await peer.stop();
    }
  },
);

test.each([
  ["classic", "immediate"],
  ["inline", "immediate"],
  ["classic", "delayed"],
  ["inline", "delayed"],
] as const)(
  "XEP-0388 §2.6.1: features received during proof verification cancel the deadline / %s / %s",
  async (binding, timing) => {
    const peer = sasl2Peer(
      binding,
      timing === "immediate" ? "present" : "missing",
    );
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      timeout: TIMEOUT_MS,
      credentials: async (
        authenticate: (credentials: object, mechanism: string) => Promise<void>,
      ) => {
        await authenticate({}, PROOF_MECHANISM);
      },
    });
    let verified = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const received = Promise.withResolvers<void>();
    xmpp.on("nonza", (el: Element) => {
      if (el.is("features", STREAM) && el.getChild("sm", SM)) {
        received.resolve();
      }
      if (el.is("success", SASL2) && timing === "delayed") {
        timer = setTimeout(
          () =>
            peer.send(
              `<features xmlns="${STREAM}">${binding === "classic" ? `<bind xmlns="${BIND}"/>` : ""}<sm xmlns="${SM}"/></features>`,
            ),
          TIMEOUT_MS / 3,
        );
      }
    });
    xmpp.saslMechanisms.register(PROOF_MECHANISM, () => ({
      name: PROOF_MECHANISM,
      clientFirst: true,
      response: () => "",
      final: async () => {
        await received.promise;
        await Bun.sleep(10);
        verified = true;
      },
    }));
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      expect((await xmpp.start()).toString()).toBe("user@example.test/r");
      await Bun.sleep(TIMEOUT_MS * 2);
      expect(verified).toBe(true);
      expect(xmpp.status).toBe("online");
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      clearTimeout(timer);
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each([
  ["resume", "missing"],
  ["failed-resume", "present"],
  ["failed-resume", "missing"],
] as const)(
  "XEP-0198 §9.2: only successful inline resumption omits features / %s / %s",
  async (binding, offer) => {
    const first = sasl2Peer("classic", "present");
    const second = sasl2Peer(binding, offer);
    const xmpp = client({
      service: first.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    let resumed = 0;
    xmpp.streamManagement.on("resumed", () => {
      resumed++;
    });
    try {
      await xmpp.start();
      await Bun.sleep(TIMEOUT_MS * 2);
      expect(xmpp.streamManagement.id).toBe("session");
      expect(errors).toEqual([]);
      const disconnected = new Promise<void>((resolve) =>
        xmpp.once("disconnect", resolve),
      );
      first.terminate();
      await disconnected;
      Object.assign(xmpp.options, { service: second.url });
      await xmpp.reconnect.reconnect();
      await Bun.sleep(TIMEOUT_MS * 2);
      const authenticate = second.transcript.find((frame) =>
        frame.startsWith("<authenticate"),
      );
      expect(authenticate).toBeDefined();
      expect(readFrame(authenticate!)).toContainEqual({
        open: `{${SM}}resume`,
        attributes: { "{}h": "0", "{}previd": "session" },
      });
      expect(resumed).toBe(binding === "resume" ? 1 : 0);
      if (binding === "failed-resume" && offer === "missing") {
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(TimeoutError);
        expect(errors[0]?.message).toBe(
          "Timed out waiting for stream features",
        );
        await second.waitForClose();
      } else {
        expect(errors).toEqual([]);
        expect(xmpp.status).toBe("online");
        expect(xmpp.streamManagement.enabled).toBe(true);
      }
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await first.stop();
      await second.stop();
    }
  },
);

test.each(["stop", "disconnect"])(
  "XEP-0388 §2.6.1: cancellation removes the success observer and isolates a replacement / %s",
  async (action) => {
    const first = sasl2Peer("classic", "missing");
    const second = sasl2Peer("classic", "present");
    const proof = Promise.withResolvers<void>();
    const success = Promise.withResolvers<void>();
    const xmpp = client({
      service: first.url,
      domain: "example.test",
      timeout: TIMEOUT_MS,
      credentials: async (
        authenticate: (credentials: object, mechanism: string) => Promise<void>,
      ) => {
        await authenticate({}, PROOF_MECHANISM);
      },
    });
    let verification = 0;
    xmpp.saslMechanisms.register(PROOF_MECHANISM, () => ({
      name: PROOF_MECHANISM,
      clientFirst: true,
      response: () => "",
      final: async () => {
        if (++verification === 1) {
          await proof.promise;
        }
      },
    }));
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    const errorsAfterDisconnect: Error[] = [];
    let disconnected = false;
    xmpp.once("disconnect", () => {
      disconnected = true;
    });
    xmpp.on("error", (error: Error) => {
      errors.push(error);
      if (disconnected) {
        errorsAfterDisconnect.push(error);
      }
    });
    xmpp.on("nonza", (el: Element) => {
      if (el.is("success", SASL2)) {
        success.resolve();
      }
    });
    const listeners = xmpp.listenerCount("nonza");
    const started = xmpp.start().catch((error: Error) => error);
    try {
      await success.promise;
      if (action === "stop") {
        await xmpp.stop();
      } else {
        const disconnected = new Promise<void>((resolve) =>
          xmpp.once("disconnect", resolve),
        );
        first.terminate();
        await disconnected;
      }
      const startError = await started;
      expect(startError).toBeInstanceOf(Error);
      const cancelledErrors = [...errors];
      // Native transport loss is asynchronous; the old proof deadline may win.
      // No error is permitted after disconnect or in the replacement session.
      expect(errorsAfterDisconnect).toEqual([]);
      if (action === "stop") {
        expect(cancelledErrors).toEqual([]);
      } else {
        expect(cancelledErrors.length).toBeLessThanOrEqual(1);
        if (cancelledErrors.length) {
          expect(cancelledErrors[0]).toBe(startError);
          expect(startError).toBeInstanceOf(TimeoutError);
        }
      }
      expect(xmpp.listenerCount("nonza")).toBe(listeners);
      Object.assign(xmpp.options, { service: second.url });
      if (action === "stop") {
        await xmpp.start();
      } else {
        const online = new Promise<void>((resolve) =>
          xmpp.once("online", resolve),
        );
        await xmpp.reconnect.reconnect();
        await online;
      }
      expect(xmpp.jid?.toString()).toBe("user@example.test/r");
      proof.resolve();
      await Bun.sleep(TIMEOUT_MS * 2);
      expect(xmpp.status).toBe("online");
      expect(verification).toBe(2);
      expect(errors).toEqual(cancelledErrors);
      expect(errorsAfterDisconnect).toEqual([]);
      expect(xmpp.listenerCount("nonza")).toBe(listeners);
      expect(first.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
        false,
      );
      expect(
        second.transcript.filter((frame) => frame.startsWith("<authenticate")),
      ).toHaveLength(1);
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    } finally {
      proof.resolve();
      await xmpp.stop();
      await started;
      await first.stop();
      await second.stop();
    }
  },
);
