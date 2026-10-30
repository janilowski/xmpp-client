import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { outgoingPresence } from "../src/connection/lib/outgoingPresence.ts";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const CONTENT = "jabber:client";
const SM = "urn:xmpp:sm:3";
const FOREIGN = "urn:test:closing-output";
const ACCOUNT = "user@example.test/r";
const CLOSE = `<close xmlns="${FRAMING}"/>`;
const TIMEOUT_MS = 500;
const OBSERVATION_MS = 150;

function closingPeer(reply: "automatic" | "held") {
  let authenticated = false;
  let replied = false;
  const closing = Promise.withResolvers<boolean>();
  const peer = new ScriptedPeer((frame, remote) => {
    const events = readFrame(frame);
    const root = events[0];
    if (!(root && "open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="closing-output"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      events.some((event) => "open" in event && event.open === `{${BIND}}bind`)
    ) {
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${ACCOUNT}</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      closing.resolve(true);
      if (reply === "automatic") {
        replied = true;
        remote.send(CLOSE);
      }
    }
  });
  return {
    peer,
    async waitForCloseHeader() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          closing.promise,
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), OBSERVATION_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    replyToClose() {
      if (replied) {
        return;
      }
      replied = true;
      try {
        peer.send(CLOSE);
      } catch {
        // Cleanup may run after a deliberately broken client closed transport.
      }
    },
  };
}

async function session(
  exercise: (
    xmpp: ReturnType<typeof client>,
    first: ReturnType<typeof closingPeer>,
    offset: number,
  ) => Promise<void>,
) {
  const first = closingPeer("held");
  const next = closingPeer("automatic");
  const xmpp = client({
    service: first.peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  const enabled = Promise.withResolvers<void>();
  const recovered = Promise.withResolvers<void>();
  const errors: Error[] = [];
  let replacing = false;
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("nonza", (element: Element) => {
    if (element.is("enabled", SM)) {
      (replacing ? recovered : enabled).resolve();
    }
  });
  try {
    expect(String(await xmpp.start())).toBe(ACCOUNT);
    await enabled.promise;
    await xmpp.send(xml("sync", { xmlns: FOREIGN, id: "setup" }));
    while (
      !first.peer.transcript.some((frame) => frame.includes('id="setup"'))
    ) {
      await first.peer.next();
    }
    expect(xmpp.streamManagement.enabled).toBe(true);
    expect(xmpp.streamManagement.outbound_q).toEqual([]);
    await exercise(xmpp, first, first.peer.transcript.length);

    // A closed direction cannot regain authority by status mutation; only a
    // fresh transport and authenticated negotiation restore application output.
    replacing = true;
    Object.assign(xmpp.options, { service: next.peer.url });
    expect(String(await xmpp.start())).toBe(ACCOUNT);
    await recovered.promise;
    await xmpp.send(
      xml("message", { id: "recovered", to: "peer@remote.test/r" }),
    );
    while (
      !next.peer.transcript.some((frame) => frame.includes('id="recovered"'))
    ) {
      await next.peer.next();
    }
    expect(errors).toEqual([]);
    expect(first.peer.errors).toEqual([]);
    expect(next.peer.errors).toEqual([]);
  } finally {
    first.replyToClose();
    await xmpp.stop();
    await first.peer.stop();
    await next.peer.stop();
  }
}

for (const method of ["send", "sendMany"] as const) {
  for (const payload of ["stanza", "nonza"] as const) {
    test(`RFC 6120 §4.4 / RFC 7395 §3.6: status mutation cannot authorize ${method} ${payload} after the footer`, async () => {
      await session(async (xmpp, first, offset) => {
        const inbound = Promise.withResolvers<Element | undefined>();
        const sent: string[] = [];
        let attempted: Promise<unknown> | undefined;
        let queueAtCallback: string[] | undefined;
        xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
        xmpp.once("stanza", (element: Element) => inbound.resolve(element));
        xmpp.once("closing", () => {
          xmpp.status = "online";
          const element =
            payload === "stanza"
              ? xml("message", { id: "forbidden", to: "peer@remote.test/r" })
              : xml("notice", { xmlns: FOREIGN, id: "forbidden" });
          attempted = (
            method === "send"
              ? xmpp.send(element)
              : xmpp.sendMany([
                  element,
                  xml("notice", { xmlns: FOREIGN, id: "forbidden-last" }),
                ])
          ).catch((error: Error) => error);
          queueAtCallback = xmpp.streamManagement.outbound_q.map(
            ({ stanza }: { stanza: Element }) => stanza.attrs.id,
          );
        });
        const stopping = xmpp.stop();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          expect(await first.waitForCloseHeader()).toBe(true);
          timer = setTimeout(() => inbound.resolve(undefined), OBSERVATION_MS);
          first.peer.send(
            `<message xmlns="${CONTENT}" from="peer@remote.test/r" to="${ACCOUNT}" id="remaining"><body>still received</body></message>`,
          );
          const remaining = await inbound.promise;
          clearTimeout(timer);
          expect(remaining?.getChildText("body")).toBe("still received");
          expect(xmpp.streamManagement.inbound).toBe(1);
          expect(attempted).toBeDefined();
          expect(await attempted).toBeInstanceOf(Error);
          expect(queueAtCallback).toEqual([]);
          expect(sent).not.toContain("forbidden");
          expect(sent).not.toContain("forbidden-last");
          first.replyToClose();
          await stopping;
          await first.peer.waitForClose();
          // The existing SM close hook remains legal before our footer; no
          // application data may follow it even while inbound data is handled.
          expect(first.peer.transcript.slice(offset).map(readFrame)).toEqual([
            readFrame(`<a xmlns="${SM}" h="0"/>`),
            readFrame(CLOSE),
          ]);
          expect(xmpp.status).toBe("offline");
        } finally {
          clearTimeout(timer);
          first.replyToClose();
          await stopping;
        }
      });
    });
  }

  test(`RFC 6120 §4.4 / XEP-0198: pending ${method} presence cannot enter SM after the footer`, async () => {
    await session(async (xmpp, first, offset) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const sent: string[] = [];
      xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
      outgoingPresence.set(xmpp, async (_source, original) => {
        entered.resolve();
        await release.promise;
        return original;
      });
      const presence = xml("presence", { id: "forbidden" });
      const pending = (
        method === "send" ? xmpp.send(presence) : xmpp.sendMany([presence])
      ).catch((error: Error) => error);
      let stopping: Promise<unknown> | undefined;
      try {
        await entered.promise;
        expect(xmpp.streamManagement.outbound_q).toEqual([]);
        stopping = xmpp.stop();
        expect(await first.waitForCloseHeader()).toBe(true);
        xmpp.status = "online";
        release.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect(xmpp.streamManagement.outbound_q).toEqual([]);
        expect(sent).not.toContain("forbidden");
        first.replyToClose();
        await stopping;
        await first.peer.waitForClose();
        expect(first.peer.transcript.slice(offset).map(readFrame)).toEqual([
          readFrame(`<a xmlns="${SM}" h="0"/>`),
          readFrame(CLOSE),
        ]);
        expect(xmpp.status).toBe("offline");
      } finally {
        release.resolve();
        await pending;
        outgoingPresence.delete(xmpp);
        first.replyToClose();
        await stopping;
      }
    });
  });
}
