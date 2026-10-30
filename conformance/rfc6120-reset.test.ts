import { expect, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer, waitForDisconnect } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const CLIENT = "jabber:client";
const OLD_SESSION = "before-reset";
const NEW_SESSION = "after-reset";
const OLD_MESSAGE = "owned-before-reset";
const TIMEOUT_MS = 300;
const WATCHDOG_MS = TIMEOUT_MS * 3;

type Offer = "authentication" | "unauthenticated SM";

// A hostile peer accepts even unauthenticated resumption deliberately. The client
// must enforce authentication rather than trusting a resumed response alone.
function sessionPeer(
  resource: string,
  session: string,
  offer: Offer = "authentication",
) {
  let authenticated = false;
  return new ScriptedPeer((frame, peer) => {
    const events = readFrame(frame);
    const root = events[0];
    if (!root || !("open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="${resource}" version="1.0"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : offer === "authentication" ? `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>` : ""}<sm xmlns="${SM}"/></features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      peer.send(`<success xmlns="${SASL}"/>`);
    } else if (
      root.open === `{${CLIENT}}iq` &&
      events.some((event) => "open" in event && event.open === `{${BIND}}bind`)
    ) {
      peer.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/${resource}</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      peer.send(`<enabled xmlns="${SM}" resume="true" id="${session}"/>`);
    } else if (root.open === `{${SM}}resume`) {
      peer.send(`<resumed xmlns="${SM}" previd="${OLD_SESSION}" h="0"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

// WebSocket cannot force fresh TLS: reset is terminal for this instance.
// Other recoverable errors still require fresh SASL before SM resumption.
test.each([
  ["reset", "authentication"],
  ["system-shutdown", "authentication"],
  ["reset", "unauthenticated SM"],
  ["system-shutdown", "unauthenticated SM"],
] as const)(
  "RFC 6120 §§4.3.5/4.9.3.16 / XEP-0198 §§3/5/10: after %s, %s cannot bypass fresh SASL",
  async (condition, offer) => {
    const first = sessionPeer("old", OLD_SESSION);
    const second = sessionPeer("new", NEW_SESSION, offer);
    const xmpp = client({
      service: first.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const sm = xmpp.streamManagement;
    sm.requestAckInterval = 0;
    const errors: Error[] = [];
    const failures: string[] = [];
    const acks: string[] = [];
    const online: string[] = [];
    const reentrant: Promise<unknown>[] = [];
    const initialEnabled = Promise.withResolvers<boolean>();
    const replacement = Promise.withResolvers<
      "enabled" | "resumed" | "closed" | "error" | "timeout"
    >();
    let replacing = false;
    let resumed = 0;
    xmpp.on("nonza", (element) => {
      if (!element.is("enabled", SM)) {
        return;
      }
      if (replacing) {
        replacement.resolve("enabled");
      } else {
        initialEnabled.resolve(true);
      }
    });
    xmpp.on("error", (error: Error) => {
      errors.push(error);
      if (
        error instanceof Error &&
        "condition" in error &&
        error.condition === "reset"
      ) {
        // Error listeners run before disconnect: they must not restart old TLS.
        const connection = xmpp as typeof xmpp & { restart(): Promise<void> };
        // eslint-disable-next-line promise/no-promise-in-callback -- Deliberate synchronous reentry.
        reentrant.push(connection.restart().catch((failure: Error) => failure));
        reentrant.push(
          // eslint-disable-next-line promise/no-promise-in-callback -- Deliberate synchronous reentry.
          xmpp
            .send(xml("message", { id: "forbidden", to: "peer@remote.test/r" }))
            .catch((failure: Error) => failure),
        );
      }
      if (replacing) {
        replacement.resolve("error");
      }
    });
    xmpp.on("close", () => {
      if (replacing) {
        replacement.resolve("closed");
      }
    });
    xmpp.on("online", (address) => online.push(address.toString()));
    sm.on("ack", (stanza: Element) => acks.push(stanza.attrs.id));
    sm.on("fail", (stanza: Element) => failures.push(stanza.attrs.id));
    sm.on("resumed", () => {
      resumed++;
      replacement.resolve("resumed");
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      expect((await xmpp.start()).toString()).toBe("user@example.test/old");
      watchdog = setTimeout(() => initialEnabled.resolve(false), WATCHDOG_MS);
      expect(await initialEnabled.promise).toBe(true);
      clearTimeout(watchdog);
      await setImmediate();
      expect(sm.enabled).toBe(true);
      expect(sm.id).toBe(OLD_SESSION);
      await xmpp.send(
        xml("message", { id: OLD_MESSAGE, to: "peer@remote.test/r" }),
      );
      while (!first.transcript.some((frame) => frame.includes(OLD_MESSAGE))) {
        await first.next();
      }
      expect(
        sm.outbound_q.map(({ stanza }: { stanza: Element }) => stanza.attrs.id),
      ).toEqual([OLD_MESSAGE]);

      first.send(
        `<error xmlns="${STREAM}"><${condition} xmlns="${ERRORS}"/><text xmlns="${ERRORS}" xml:lang="en">Reconnect</text></error>`,
      );
      expect(await waitForDisconnect(xmpp, WATCHDOG_MS)).toBe(true);
      await first.waitForClose();
      expect(xmpp.status).toBe("disconnect");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        name: "StreamError",
        condition,
        text: "Reconnect",
      });
      expect(online).toEqual(["user@example.test/old"]);
      expect(acks).toEqual([]);
      expect(readFrame(first.transcript.at(-1)!)).toEqual([
        { open: `{${FRAMING}}close`, attributes: {} },
        { close: `{${FRAMING}}close` },
      ]);
      expect(
        first.transcript.filter((frame) => frame.startsWith("<close")),
      ).toHaveLength(1);
      expect(
        first.transcript.some((frame) => frame.startsWith("<stream:error")),
      ).toBe(false);

      Object.assign(xmpp.options, { service: second.url });
      replacing = true;
      watchdog = setTimeout(() => replacement.resolve("timeout"), WATCHDOG_MS);
      await xmpp.reconnect
        .reconnect()
        .catch(() => replacement.resolve("error"));
      const outcome = await replacement.promise;
      clearTimeout(watchdog);
      await setImmediate();
      if (condition === "reset") {
        const [restart, send] = await Promise.all(reentrant);
        expect(restart).toMatchObject({
          name: "StreamError",
          condition: "reset",
        });
        expect(send).toBeInstanceOf(Error);
        expect(
          sm.outbound_q.some(
            ({ stanza }: { stanza: Element }) =>
              stanza.attrs.id === "forbidden",
          ),
        ).toBe(false);
        expect(outcome).toBe("error");
        expect(second.transcript).toEqual([]);
        expect(second.requests).toEqual([]);
        expect(resumed).toBe(0);
        await expect(xmpp.reconnect.reconnect()).rejects.toMatchObject({
          name: "StreamError",
          condition: "reset",
        });
        await xmpp.stop();
        await expect(xmpp.start()).rejects.toMatchObject({
          name: "StreamError",
          condition: "reset",
        });
        // Discovery must not contact HTTPS before the transport guard runs.
        Object.assign(xmpp.options, { service: "unreachable.invalid" });
        const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
          new Error("Discovery must not run"),
        );
        try {
          await expect(xmpp.start()).rejects.toMatchObject({
            name: "StreamError",
            condition: "reset",
          });
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          fetch.mockRestore();
        }
        expect(second.transcript).toEqual([]);
        expect(second.requests).toEqual([]);
        return;
      }
      if (offer === "unauthenticated SM") {
        // If the hostile resumed response grants authority, this fails immediately.
        // Rejecting or ignoring its offer are both allowed; no error text is prescribed.
        expect(resumed).toBe(0);
        expect(xmpp.status).not.toBe("online");
        expect(online).toEqual(["user@example.test/old"]);
        expect(acks).toEqual([]);
        const forbidden = await xmpp
          .send(xml("message", { id: "forbidden", to: "peer@remote.test/r" }))
          .then(
            () => undefined,
            (error: Error) => error,
          );
        expect(forbidden).toBeInstanceOf(Error);
        expect(
          sm.outbound_q.some(
            ({ stanza }: { stanza: Element }) =>
              stanza.attrs.id === "forbidden",
          ),
        ).toBe(false);
        const roots = second.transcript.map((frame) => readFrame(frame)[0]);
        expect(
          roots.some(
            (root) =>
              "open" in root &&
              [
                `{${SASL}}auth`,
                `{${SM}}resume`,
                `{${SM}}enable`,
                `{${CLIENT}}iq`,
                `{${CLIENT}}message`,
              ].includes(root.open),
          ),
        ).toBe(false);
        expect(first.errors).toEqual([]);
        expect(second.errors).toEqual([]);
        return;
      }

      // Compatibility control: accepting the former SM delivery state after fresh
      // SASL is permitted. Neither error universally requires retaining that state.
      expect(outcome).toBe("resumed");
      expect(resumed).toBe(1);
      expect(xmpp.jid?.toString()).toBe("user@example.test/old");
      expect(online).toEqual(["user@example.test/old"]);
      expect(sm.enabled).toBe(true);
      expect(sm.id).toBe(OLD_SESSION);
      expect(failures).toEqual([]);
      expect(acks).toEqual([]);
      expect(
        sm.outbound_q.map(({ stanza }: { stanza: Element }) => stanza.attrs.id),
      ).toEqual([OLD_MESSAGE]);
      // Ordered peer receipt, not client send completion, bounds the old replay check.
      await xmpp.send(
        xml("message", { id: "newly-owned", to: "peer@remote.test/r" }),
      );
      while (
        !second.transcript.some((frame) => frame.includes("newly-owned"))
      ) {
        await second.next();
      }
      expect(
        readFrame(
          second.transcript.find((frame) => frame.includes("newly-owned"))!,
        )[0],
      ).toMatchObject({
        open: `{${CLIENT}}message`,
        attributes: { "{}id": "newly-owned", "{}to": "peer@remote.test/r" },
      });
      const roots = second.transcript.map((frame) => readFrame(frame)[0]);
      expect(
        roots.filter((root) => "open" in root && root.open === `{${SASL}}auth`),
      ).toHaveLength(1);
      expect(
        roots.filter((root) => "open" in root && root.open === `{${CLIENT}}iq`),
      ).toHaveLength(0);
      expect(
        roots.filter((root) => "open" in root && root.open === `{${SM}}enable`),
      ).toHaveLength(0);
      expect(
        roots.filter((root) => "open" in root && root.open === `{${SM}}resume`),
      ).toHaveLength(1);
      expect(
        second.transcript.filter((frame) => frame.includes(OLD_MESSAGE)),
      ).toHaveLength(1);
      const names = roots.flatMap((root) =>
        "open" in root ? [root.open] : [],
      );
      expect(
        names.filter((name) =>
          [`{${FRAMING}}open`, `{${SASL}}auth`, `{${SM}}resume`].includes(name),
        ),
      ).toEqual([
        `{${FRAMING}}open`,
        `{${SASL}}auth`,
        `{${FRAMING}}open`,
        `{${SM}}resume`,
      ]);
      expect(names.indexOf(`{${CLIENT}}message`)).toBeGreaterThan(
        names.indexOf(`{${SM}}resume`),
      );
      expect(errors).toHaveLength(1);
      expect(first.errors).toEqual([]);
      expect(second.errors).toEqual([]);
    } finally {
      clearTimeout(watchdog);
      await xmpp.stop();
      await first.stop();
      await second.stop();
    }
  },
);
