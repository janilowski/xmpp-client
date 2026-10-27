import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const CONTENT = "jabber:client";
const BARRIER = "urn:test:sm-enable-attempt";
const TIMEOUT_MS = 1000;
const SESSION_ID = "enabled-session";

type Mode = "ordinary" | "inline";
type Outcome = "failed" | "enabled" | "resumable" | "omitted";
type PeerOptions = {
  resumeHandled?: number;
  features?: "with-sm" | "binding-only";
};

function managementPeer(
  mode: Mode,
  outcome: Outcome,
  options: PeerOptions = {},
) {
  let authenticated = false;
  let attempts = 0;
  let resumptions = 0;
  let acknowledged = options.resumeHandled ?? 0;
  const messages: string[] = [];
  const response =
    outcome === "omitted"
      ? ""
      : outcome === "failed"
        ? `<failed xmlns="${SM}"><internal-server-error xmlns="${STANZAS}"/></failed>`
        : `<enabled xmlns="${SM}"${outcome === "resumable" ? ` resume="true" id="${SESSION_ID}"` : ""}/>`;
  const peer = new ScriptedPeer((frame, remote) => {
    const element = readFrame(frame)[0];
    if (!element || !("open" in element)) {
      throw new Error("Expected a client element");
    }
    if (element.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="stream" version="1.0"/>`,
      );
      const features =
        mode === "inline"
          ? `<authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><inline><sm xmlns="${SM}"/><bind xmlns="${BIND2}"><inline><feature var="${SM}"/></inline></bind></inline></authentication>`
          : authenticated
            ? `<bind xmlns="${BIND}"/>${options.features === "binding-only" ? "" : `<sm xmlns="${SM}"/>`}`
            : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`;
      remote.send(`<features xmlns="${STREAM}">${features}</features>`);
    } else if (element.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (element.open === `{${SASL2}}authenticate`) {
      attempts += readFrame(frame).filter(
        (item) => "open" in item && item.open === `{${SM}}enable`,
      ).length;
      remote.send(
        `<success xmlns="${SASL2}"><authorization-identifier>user@example.test/r</authorization-identifier><bound xmlns="${BIND2}">${response}</bound></success>`,
      );
      remote.send(`<features xmlns="${STREAM}"/>`);
    } else if (element.open === `{${CONTENT}}iq`) {
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${element.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (element.open === `{${SM}}enable`) {
      attempts++;
      // The test controls the first ordinary response to exercise its pending queue.
      if (attempts > 1) {
        remote.send(
          `<failed xmlns="${SM}"><unexpected-request xmlns="${STANZAS}"/></failed>`,
        );
      }
    } else if (element.open === `{${SM}}resume`) {
      resumptions++;
      remote.send(
        `<resumed xmlns="${SM}" previd="${SESSION_ID}" h="${acknowledged}"/>`,
      );
    } else if (element.open === `{${CONTENT}}message`) {
      messages.push(element.attributes["{}id"]);
    } else if (element.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  return {
    peer,
    response,
    messages,
    get attempts() {
      return attempts;
    },
    get resumptions() {
      return resumptions;
    },
    acknowledge(h: number) {
      acknowledged = h;
      peer.send(`<a xmlns="${SM}" h="${h}"/>`);
    },
  };
}

// XEP-0198 v1.6.3 §3: one enable attempt, including inline Bind2 (§9.1).
// Recoverability (§6) permits stanza traffic after refusal. The fail event is
// the library's ownership disposition, not an invented mandatory XEP UI policy.
for (const mode of ["ordinary", "inline"] as const) {
  test.each(["failed", "enabled", "resumable"] as const)(
    `XEP-0198 §3: ${mode} makes one enable attempt after %s`,
    async (outcome) => {
      const first = managementPeer(mode, outcome);
      const second = managementPeer(mode, "enabled");
      const xmpp = client({
        service: first.peer.url,
        domain: "example.test",
        username: "user",
        password: "secret",
        timeout: TIMEOUT_MS,
      });
      xmpp.reconnect.stop();
      xmpp.streamManagement.requestAckInterval = 0;
      const acks: string[] = [];
      const failures: string[] = [];
      const errors: Error[] = [];
      xmpp.streamManagement.on("ack", (stanza) => acks.push(stanza.attrs.id));
      xmpp.streamManagement.on("fail", (stanza) =>
        failures.push(stanza.attrs.id),
      );
      xmpp.on("error", (error: Error) => errors.push(error));
      let responseReceived = false;
      xmpp.on("nonza", (element) => {
        if (element.is("enabled", SM) || element.is("failed", SM)) {
          responseReceived = true;
        }
      });

      try {
        expect((await xmpp.start()).toString()).toBe("user@example.test/r");
        if (mode === "ordinary") {
          const enableDeadline = Date.now() + TIMEOUT_MS;
          while (first.attempts === 0 && Date.now() < enableDeadline) {
            await setImmediate();
          }
          expect(first.attempts).toBe(1);
          first.peer.send(first.response);
          const deadline = Date.now() + TIMEOUT_MS;
          while (!responseReceived && Date.now() < deadline) {
            await setImmediate();
          }
          expect(responseReceived).toBe(true);
        }
        await setImmediate();

        // Repeated offers must neither re-enable nor resume the current stream.
        first.peer.send(
          `<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`,
        );
        first.peer.send(
          `<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`,
        );
        await setImmediate();
        await xmpp.send(xml("barrier", { xmlns: BARRIER, id: "offers" }));
        while (
          !first.peer.transcript.some((frame) => frame.includes('id="offers"'))
        ) {
          await first.peer.next();
        }
        await setImmediate();
        // A permissive peer answers illegal attempts so the assertion owns RED.
        expect(first.attempts).toBe(1);
        expect(first.resumptions).toBe(0);
        expect(xmpp.streamManagement.enabled).toBe(outcome !== "failed");
        expect(failures).toEqual([]);

        await xmpp.send(xml("message", { id: "after-offers" }));
        while (!first.messages.includes("after-offers")) {
          await first.peer.next();
        }
        if (outcome !== "failed") {
          first.acknowledge(1);
          const deadline = Date.now() + TIMEOUT_MS;
          while (acks.length === 0 && Date.now() < deadline) {
            await setImmediate();
          }
          expect(acks).toEqual(["after-offers"]);
        }
        expect(first.messages).toEqual(["after-offers"]);

        // A clean stop ends this session; a fresh transport gets its own attempt.
        await xmpp.stop();
        expect(failures).toEqual([]);
        responseReceived = false;
        Object.assign(xmpp.options, { service: second.peer.url });
        expect((await xmpp.start()).toString()).toBe("user@example.test/r");
        if (mode === "ordinary") {
          const enableDeadline = Date.now() + TIMEOUT_MS;
          while (second.attempts === 0 && Date.now() < enableDeadline) {
            await setImmediate();
          }
          expect(second.attempts).toBe(1);
          second.peer.send(second.response);
          const deadline = Date.now() + TIMEOUT_MS;
          while (!responseReceived && Date.now() < deadline) {
            await setImmediate();
          }
          expect(responseReceived).toBe(true);
        }
        await setImmediate();
        expect(second.attempts).toBe(1);
        expect(second.resumptions).toBe(0);
        expect(xmpp.streamManagement.enabled).toBe(true);
        await xmpp.send(xml("message", { id: "fresh" }));
        while (!second.messages.includes("fresh")) {
          await second.peer.next();
        }
        second.acknowledge(1);
        const deadline = Date.now() + TIMEOUT_MS;
        while (!acks.includes("fresh") && Date.now() < deadline) {
          await setImmediate();
        }
        expect(acks).toEqual(
          outcome === "failed" ? ["fresh"] : ["after-offers", "fresh"],
        );
        expect(second.messages).toEqual(["fresh"]);
        expect(errors).toEqual([]);
        expect(first.peer.errors).toEqual([]);
        expect(second.peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await first.peer.stop();
        await second.peer.stop();
      }
    },
  );
}

test("XEP-0198 §§3–4/6: refused enable resolves provisional stanza ownership once", async () => {
  const { peer, response, messages } = managementPeer("ordinary", "failed");
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  const failures: string[] = [];
  const errors: Error[] = [];
  const refused = Promise.withResolvers<void>();
  xmpp.streamManagement.on("fail", (stanza) => failures.push(stanza.attrs.id));
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("nonza", (element) => {
    if (element.is("failed", SM)) {
      refused.resolve();
    }
  });
  try {
    expect((await xmpp.start()).toString()).toBe("user@example.test/r");
    while (!peer.transcript.some((frame) => frame.startsWith("<enable "))) {
      await peer.next();
    }
    await xmpp.send(xml("message", { id: "provisional" }));
    while (!messages.includes("provisional")) {
      await peer.next();
    }
    peer.send(response);
    await refused.promise;
    await setImmediate();
    await xmpp.send(xml("barrier", { xmlns: BARRIER, id: "refused" }));
    while (!peer.transcript.some((frame) => frame.includes('id="refused"'))) {
      await peer.next();
    }
    expect(failures).toEqual(["provisional"]);
    expect(xmpp.streamManagement.enabled).toBe(false);
    await xmpp.send(xml("message", { id: "after-refusal" }));
    while (!messages.includes("after-refusal")) {
      await peer.next();
    }
    await xmpp.stop();
    expect(failures).toEqual(["provisional"]);
    expect(messages).toEqual(["provisional", "after-refusal"]);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each(["failed", "enabled"] as const)(
  "XEP-0198 §3: repeated offers cannot overlap a pending enable / %s",
  async (outcome) => {
    const fixture = managementPeer("ordinary", outcome);
    const { peer } = fixture;
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.streamManagement.requestAckInterval = 0;
    const errors: Error[] = [];
    const acks: string[] = [];
    const failures: string[] = [];
    let settled = false;
    xmpp.on("error", (error: Error) => errors.push(error));
    xmpp.streamManagement.on("ack", (stanza) => acks.push(stanza.attrs.id));
    xmpp.streamManagement.on("fail", (stanza) =>
      failures.push(stanza.attrs.id),
    );
    xmpp.on("nonza", (element) => {
      if (element.is("enabled", SM) || element.is("failed", SM)) {
        settled = true;
      }
    });
    try {
      expect((await xmpp.start()).toString()).toBe("user@example.test/r");
      const enableDeadline = Date.now() + TIMEOUT_MS;
      while (fixture.attempts === 0 && Date.now() < enableDeadline) {
        await setImmediate();
      }
      expect(fixture.attempts).toBe(1);
      peer.send(`<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`);
      peer.send(`<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`);
      await setImmediate();
      await xmpp.send(xml("barrier", { xmlns: BARRIER, id: "pending-offers" }));
      while (
        !peer.transcript.some((frame) => frame.includes('id="pending-offers"'))
      ) {
        await peer.next();
      }
      await setImmediate();
      expect(fixture.attempts).toBe(1);
      expect(fixture.resumptions).toBe(0);
      expect(settled).toBe(false);
      peer.send(fixture.response);
      const responseDeadline = Date.now() + TIMEOUT_MS;
      while (!settled && Date.now() < responseDeadline) {
        await setImmediate();
      }
      expect(settled).toBe(true);
      await setImmediate();
      expect(xmpp.streamManagement.enabled).toBe(outcome === "enabled");
      await xmpp.send(xml("message", { id: "after-pending" }));
      while (!fixture.messages.includes("after-pending")) {
        await peer.next();
      }
      if (outcome === "enabled") {
        fixture.acknowledge(1);
        const ackDeadline = Date.now() + TIMEOUT_MS;
        while (acks.length === 0 && Date.now() < ackDeadline) {
          await setImmediate();
        }
      }
      expect(acks).toEqual(outcome === "enabled" ? ["after-pending"] : []);
      await xmpp.stop();
      expect(fixture.messages).toEqual(["after-pending"]);
      expect(failures).toEqual([]);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("XEP-0198 §§3/5: repeated offers preserve an already resumed stream", async () => {
  const first = managementPeer("ordinary", "resumable");
  const second = managementPeer("ordinary", "resumable", { resumeHandled: 1 });
  const xmpp = client({
    service: first.peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  const acks: string[] = [];
  const failures: string[] = [];
  const errors: Error[] = [];
  let enabled = false;
  let resumed = 0;
  xmpp.streamManagement.on("ack", (stanza) => acks.push(stanza.attrs.id));
  xmpp.streamManagement.on("fail", (stanza) => failures.push(stanza.attrs.id));
  xmpp.streamManagement.on("resumed", () => resumed++);
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("nonza", (element) => {
    if (element.is("enabled", SM)) {
      enabled = true;
    }
  });
  try {
    expect((await xmpp.start()).toString()).toBe("user@example.test/r");
    const enableDeadline = Date.now() + TIMEOUT_MS;
    while (first.attempts === 0 && Date.now() < enableDeadline) {
      await setImmediate();
    }
    expect(first.attempts).toBe(1);
    first.peer.send(first.response);
    const responseDeadline = Date.now() + TIMEOUT_MS;
    while (!enabled && Date.now() < responseDeadline) {
      await setImmediate();
    }
    expect(enabled).toBe(true);
    await setImmediate();
    await xmpp.send(xml("message", { id: "a" }));
    await xmpp.send(xml("message", { id: "b" }));
    while (!first.messages.includes("b")) {
      await first.peer.next();
    }
    first.acknowledge(1);
    const ackDeadline = Date.now() + TIMEOUT_MS;
    while (acks.length === 0 && Date.now() < ackDeadline) {
      await setImmediate();
    }
    expect(acks).toEqual(["a"]);
    first.peer.send(`<message xmlns="${CONTENT}" id="incoming-one"/>`);
    first.peer.send(`<r xmlns="${SM}"/>`);
    while (!first.peer.transcript.some((frame) => frame.startsWith("<a "))) {
      await first.peer.next();
    }
    expect(
      readFrame(
        first.peer.transcript.find((frame) => frame.startsWith("<a "))!,
      ),
    ).toContainEqual({
      open: `{${SM}}a`,
      attributes: { "{}h": "1" },
    });

    const disconnected = new Promise<void>((resolve) =>
      xmpp.once("disconnect", resolve),
    );
    first.peer.terminate();
    await disconnected;
    Object.assign(xmpp.options, { service: second.peer.url });
    await xmpp.reconnect.reconnect();
    const resumeDeadline = Date.now() + TIMEOUT_MS;
    while (resumed === 0 && Date.now() < resumeDeadline) {
      await setImmediate();
    }
    expect(resumed).toBe(1);
    second.peer.send(
      `<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`,
    );
    second.peer.send(
      `<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`,
    );
    await setImmediate();
    await xmpp.send(xml("barrier", { xmlns: BARRIER, id: "resumed-offers" }));
    while (
      !second.peer.transcript.some((frame) =>
        frame.includes('id="resumed-offers"'),
      )
    ) {
      await second.peer.next();
    }
    await setImmediate();
    expect(second.resumptions).toBe(1);
    expect(second.attempts).toBe(0);
    expect(resumed).toBe(1);
    expect(second.messages).toEqual(["b"]);
    const requests = second.peer.transcript
      .flatMap(readFrame)
      .filter(
        (element) => "open" in element && element.open === `{${SM}}resume`,
      );
    expect(requests).toEqual([
      {
        open: `{${SM}}resume`,
        attributes: { "{}previd": SESSION_ID, "{}h": "1" },
      },
    ]);
    await xmpp.send(xml("message", { id: "c" }));
    while (!second.messages.includes("c")) {
      await second.peer.next();
    }
    second.acknowledge(2);
    const secondAckDeadline = Date.now() + TIMEOUT_MS;
    while (acks.length < 2 && Date.now() < secondAckDeadline) {
      await setImmediate();
    }
    expect(acks).toEqual(["a", "b"]);
    second.acknowledge(3);
    const thirdAckDeadline = Date.now() + TIMEOUT_MS;
    while (acks.length < 3 && Date.now() < thirdAckDeadline) {
      await setImmediate();
    }
    expect(acks).toEqual(["a", "b", "c"]);
    second.peer.send(`<presence xmlns="${CONTENT}" id="incoming-two"/>`);
    second.peer.send(`<r xmlns="${SM}"/>`);
    while (!second.peer.transcript.some((frame) => frame.startsWith("<a "))) {
      await second.peer.next();
    }
    expect(
      readFrame(
        second.peer.transcript.find((frame) => frame.startsWith("<a "))!,
      ),
    ).toContainEqual({
      open: `{${SM}}a`,
      attributes: { "{}h": "2" },
    });
    await xmpp.stop();
    expect(second.messages).toEqual(["b", "c"]);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
    expect(first.peer.errors).toEqual([]);
    expect(second.peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await first.peer.stop();
    await second.peer.stop();
  }
});

test("XEP-0198 §§3/9.1: cancelled Bind2 builder cannot spend a new stream's enable attempt", async () => {
  const first = managementPeer("inline", "enabled");
  const second = managementPeer("ordinary", "enabled", {
    features: "binding-only",
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  let resources = 0;
  const xmpp = client({
    service: first.peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
    resource: () => {
      resources++;
      if (resources === 1) {
        entered.resolve();
        return release.promise;
      }
      return "r";
    },
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  const errors: Error[] = [];
  const failures: string[] = [];
  const acks: string[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.streamManagement.on("ack", (stanza) => acks.push(stanza.attrs.id));
  xmpp.streamManagement.on("fail", (stanza) => failures.push(stanza.attrs.id));
  const starting = xmpp.start().then(
    (address) => address,
    (error: Error) => error,
  );
  try {
    await entered.promise;
    const disconnected = new Promise<void>((resolve) =>
      xmpp.once("disconnect", resolve),
    );
    first.peer.terminate();
    await disconnected;
    expect(await starting).toBeInstanceOf(Error);
    Object.assign(xmpp.options, { service: second.peer.url });
    await xmpp.reconnect.reconnect();
    const bindingDeadline = Date.now() + TIMEOUT_MS;
    while (xmpp.status !== "online" && Date.now() < bindingDeadline) {
      await setImmediate();
    }
    expect(xmpp.status).toBe("online");
    expect(xmpp.jid?.toString()).toBe("user@example.test/r");
    expect(second.attempts).toBe(0);
    release.resolve("old-tag");
    await setImmediate();
    second.peer.send(
      `<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`,
    );
    const enableDeadline = Date.now() + TIMEOUT_MS;
    while (second.attempts === 0 && Date.now() < enableDeadline) {
      await setImmediate();
    }
    expect(second.attempts).toBe(1);
    expect(first.attempts).toBe(0);
    expect(
      first.peer.transcript.some((frame) => frame.startsWith("<authenticate ")),
    ).toBe(false);
    second.peer.send(second.response);
    await setImmediate();
    await xmpp.send(xml("message", { id: "after-cancellation" }));
    while (!second.messages.includes("after-cancellation")) {
      await second.peer.next();
    }
    second.acknowledge(1);
    const ackDeadline = Date.now() + TIMEOUT_MS;
    while (acks.length === 0 && Date.now() < ackDeadline) {
      await setImmediate();
    }
    expect(acks).toEqual(["after-cancellation"]);
    await xmpp.stop();
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
    expect(first.peer.errors).toEqual([]);
    expect(second.peer.errors).toEqual([]);
  } finally {
    release.resolve("old-tag");
    await starting;
    await xmpp.stop();
    await first.peer.stop();
    await second.peer.stop();
  }
});

test("XEP-0198 §§3/9.1: unanswered inline enable still spends the stream's attempt", async () => {
  const fixture = managementPeer("inline", "omitted");
  const { peer } = fixture;
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  const failures: string[] = [];
  const errors: Error[] = [];
  xmpp.streamManagement.on("fail", (stanza) => failures.push(stanza.attrs.id));
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    expect((await xmpp.start()).toString()).toBe("user@example.test/r");
    await setImmediate();
    expect(fixture.attempts).toBe(1);
    expect(xmpp.streamManagement.enabled).toBe(false);

    // Missing enabled/failed violates the server's obligation. The client's
    // already transmitted enable still counts; omission grants no SM session.
    peer.send(`<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`);
    peer.send(`<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`);
    await setImmediate();
    await xmpp.send(
      xml("barrier", { xmlns: BARRIER, id: "unanswered-offers" }),
    );
    while (
      !peer.transcript.some((frame) => frame.includes('id="unanswered-offers"'))
    ) {
      await peer.next();
    }
    await setImmediate();
    expect(fixture.attempts).toBe(1);
    expect(fixture.resumptions).toBe(0);
    expect(xmpp.streamManagement.enabled).toBe(false);
    await xmpp.send(xml("message", { id: "after-unanswered" }));
    while (!fixture.messages.includes("after-unanswered")) {
      await peer.next();
    }
    await xmpp.stop();
    expect(fixture.messages).toEqual(["after-unanswered"]);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});
