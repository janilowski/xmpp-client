import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const CONTENT = "jabber:client";
const ACCOUNT = "user@example.test/r";
const CLOSE = `<close xmlns="${FRAMING}"/>`;
const AUTH = `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`;
const CLOSE_TIMEOUT_MS = 300;
const EARLY_CLOSE_CHECK_MS = 75;
const CLOCK_TOLERANCE_MS = 5;

const INVALID = [
  [
    "mismatched XML tags",
    `<message xmlns="${CONTENT}"><body></message>`,
    "not-well-formed",
  ],
  [
    "restricted XML",
    `<message xmlns="${CONTENT}"><!--forbidden--></message>`,
    "restricted-xml",
  ],
  [
    "wrong framing namespace",
    '<close xmlns="urn:test:wrong"/>',
    "invalid-namespace",
  ],
  [
    "server content namespace",
    '<message xmlns="jabber:server"/>',
    "invalid-namespace",
  ],
] as const;

type Stage =
  | "opening"
  | "initial features"
  | "authentication"
  | "classic restart"
  | "bound";
type CloseReply = "reply" | "omit";

// A fully composed client retains its real close hooks and protocol adapters.
// Literal classic SASL/binding replies never derive expected XML from the client.
function parserPeer(stage: Stage, source: string, reply: CloseReply) {
  let authenticated = false;
  return new ScriptedPeer((frame, remote) => {
    const events = readFrame(frame);
    const root = events[0];
    if (!(root && "open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      if (stage === "opening") {
        remote.send(source);
        return;
      }
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="parser-error" version="1.0"/>`,
      );
      if (
        (!authenticated && stage === "initial features") ||
        (authenticated && stage === "classic restart")
      ) {
        remote.send(source);
        return;
      }
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : AUTH}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      if (stage === "authentication") {
        remote.send(source);
        return;
      }
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      events.some((event) => "open" in event && event.open === `{${BIND}}bind`)
    ) {
      remote.send(
        `<iq xmlns="${CONTENT}" id="${root.attributes["{}id"]}" type="result"><bind xmlns="${BIND}"><jid>${ACCOUNT}</jid></bind></iq>`,
      );
    } else if (root.open === `{${FRAMING}}close` && reply === "reply") {
      remote.send(CLOSE);
    }
  });
}

function parserSession(stage: Stage, source: string, reply: CloseReply) {
  const peer = parserPeer(stage, source, reply);
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    resource: "r",
    timeout: CLOSE_TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  const closes: { clean: boolean; reason?: Error }[] = [];
  const online: string[] = [];
  const stanzas: string[] = [];
  const elements: string[] = [];
  let closingAt = 0;
  let closedAt = 0;
  let disconnected = 0;
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("close", (event: { clean: boolean; reason?: Error }) =>
    closes.push(event),
  );
  xmpp.on("online", (address: { toString(): string }) =>
    online.push(String(address)),
  );
  xmpp.on("stanza", (element: { toString(): string }) =>
    stanzas.push(String(element)),
  );
  xmpp.on("element", (element: { toString(): string }) =>
    elements.push(String(element)),
  );
  xmpp.on("closing", () => {
    closingAt = performance.now();
  });
  xmpp.on("disconnect", () => {
    disconnected += 1;
  });
  const transportClosed = peer.waitForClose().then(() => {
    closedAt = performance.now();
    return undefined;
  });
  const started = xmpp.start().catch((error: Error) => error);
  return {
    xmpp,
    peer,
    errors,
    closes,
    online,
    stanzas,
    elements,
    started,
    transportClosed,
    get closingAt() {
      return closingAt;
    },
    get closedAt() {
      return closedAt;
    },
    get disconnected() {
      return disconnected;
    },
  };
}

// Error condition alternatives are specified by §4.9.3.1; framing's namespace
// condition is mandatory in RFC 7395 §3.3.2. Compare expanded XML, not prefixes.
function assertFatalTranscript(
  peer: ScriptedPeer,
  stage: Stage,
  condition: string,
) {
  const events = peer.transcript.map((frame) => readFrame(frame));
  expect(
    events
      .map((frame) => frame[0])
      .map((root) => ("open" in root ? root.open : "")),
  ).toEqual([
    `{${FRAMING}}open`,
    ...(stage === "authentication" ||
    stage === "classic restart" ||
    stage === "bound"
      ? [`{${SASL}}auth`]
      : []),
    ...(stage === "classic restart" || stage === "bound"
      ? [`{${FRAMING}}open`]
      : []),
    ...(stage === "bound" ? [`{${CONTENT}}iq`] : []),
    `{${STREAM}}error`,
    `{${FRAMING}}close`,
  ]);
  const error = events.at(-2)!;
  const actual = error[1];
  expect(actual && "open" in actual ? actual.open : "").toBeOneOf([
    `{${ERRORS}}${condition}`,
    ...(condition === "invalid-namespace" ? [] : [`{${ERRORS}}bad-format`]),
  ]);
  const actualCondition = actual && "open" in actual ? actual.open : "";
  expect(error).toEqual([
    { open: `{${STREAM}}error`, attributes: {} },
    { open: actualCondition, attributes: {} },
    { close: actualCondition },
    { close: `{${STREAM}}error` },
  ]);
  expect(events.at(-1)).toEqual(readFrame(CLOSE));
  expect(peer.errors).toEqual([]);
}

test("RFC 6120 §4.4 / RFC 7395 §3.6: full-client reciprocal close control", async () => {
  const session = parserSession("bound", "", "reply");
  try {
    expect(String(await session.started)).toBe(ACCOUNT);
    expect((await session.xmpp.stop())?.toString()).toBe(CLOSE);
    await session.transportClosed;
    expect(session.closes).toHaveLength(1);
    expect(session.closes[0].reason).toBeUndefined();
    expect(session.errors).toEqual([]);
    expect(session.peer.errors).toEqual([]);
  } finally {
    await session.xmpp.stop();
    await session.peer.stop();
    await session.transportClosed;
  }
});

test("RFC 6120 §4.4 / RFC 7395 §3.6: automatic fatal reciprocal survives stop-on-error", async () => {
  const [, input, condition] = INVALID[0];
  const session = parserSession("bound", input, "reply");
  const stopped = Promise.withResolvers<unknown>();
  try {
    expect(String(await session.started)).toBe(ACCOUNT);
    const stanzasBefore = [...session.stanzas];
    // The peer answers the footer in its message callback; public stop must
    // join the same shutdown even when the application reacts synchronously.
    session.xmpp.once("error", () => {
      stopped.resolve(session.xmpp.stop());
    });
    session.peer.send(input);
    expect(String(await stopped.promise)).toBe(CLOSE);
    await session.transportClosed;
    assertFatalTranscript(session.peer, "bound", condition);
    expect(session.closes).toHaveLength(1);
    expect(session.closes[0].reason).toBeUndefined();
    expect(session.errors).toHaveLength(1);
    expect(session.stanzas).toEqual(stanzasBefore);
    expect(session.online).toEqual([ACCOUNT]);
    expect(session.disconnected).toBe(1);
  } finally {
    await session.xmpp.stop();
    await session.peer.stop();
    await session.transportClosed;
  }
});

const DELAYED_CASES = [
  ...INVALID.map((failure) => ["bound", ...failure] as const),
  ["initial features", ...INVALID[2]],
  ["authentication", ...INVALID[1]],
  ["classic restart", ...INVALID[0]],
] as const;

test.each(DELAYED_CASES)(
  "RFC 6120 §§4.4/4.9.1.1 / RFC 7395 §3.6: %s retains delayed reciprocal after %s",
  async (stage, _name, input, condition) => {
    const session = parserSession(stage, input, "omit");
    try {
      const result = await session.started;
      const stanzasBefore = [...session.stanzas];
      if (stage === "bound") {
        expect(String(result)).toBe(ACCOUNT);
        session.peer.send(input);
      } else {
        expect(result).toBeInstanceOf(Error);
      }
      for (;;) {
        const root = readFrame(await session.peer.next())[0];
        if ("open" in root && root.open === `{${FRAMING}}close`) {
          break;
        }
      }
      assertFatalTranscript(session.peer, stage, condition);
      await delay(EARLY_CLOSE_CHECK_MS);
      expect(session.closedAt).toBe(0);
      expect(session.disconnected).toBe(0);
      expect(session.xmpp.status).toBe("closing");
      expect(session.errors).toHaveLength(1);
      const stopped = session.xmpp.stop();
      session.peer.send(CLOSE);
      expect(String(await stopped)).toBe(CLOSE);
      await session.transportClosed;
      expect(session.closes).toHaveLength(1);
      expect(session.closes[0].reason).toBeUndefined();
      expect(session.errors).toHaveLength(1);
      expect(session.stanzas).toEqual(stanzasBefore);
      assertFatalTranscript(session.peer, stage, condition);
    } finally {
      await session.xmpp.stop();
      await session.peer.stop();
      await session.transportClosed;
    }
  },
);

// RFC 6120 §4.9.1.1 explicitly includes malformed XML. XML 1.0 §1.2 forbids
// normal processing of that failed document; it does not forbid recognizing
// the next independent RFC 7395 document exclusively for stream teardown.
for (const stage of [
  "initial features",
  "authentication",
  "classic restart",
  "bound",
] as const) {
  test.each(INVALID)(
    `RFC 6120 §4.4 / RFC 7395 §§3.3.3/3.6: ${stage} recognizes reciprocal after %s`,
    async (_name, input, condition) => {
      const session = parserSession(stage, input, "omit");
      try {
        const result = await session.started;
        const stanzasBefore = [...session.stanzas];
        if (stage === "bound") {
          expect(String(result)).toBe(ACCOUNT);
          session.peer.send(input);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(session.errors).toEqual([result]);
        }
        for (;;) {
          const root = readFrame(await session.peer.next())[0];
          if ("open" in root && root.open === `{${FRAMING}}close`) {
            break;
          }
        }
        assertFatalTranscript(session.peer, stage, condition);
        // Join the existing shutdown after observing its actual footer, then
        // reply immediately. Returning CLOSE proves parsing, not timer expiry.
        const stopped = session.xmpp.stop();
        session.peer.send(CLOSE);
        expect(String(await stopped)).toBe(CLOSE);
        await session.transportClosed;
        expect(session.closes).toHaveLength(1);
        expect(session.closes[0].reason).toBeUndefined();
        expect(session.errors).toHaveLength(1);
        expect(session.online).toEqual(stage === "bound" ? [ACCOUNT] : []);
        expect(session.stanzas).toEqual(stanzasBefore);
        expect(session.disconnected).toBe(1);
      } finally {
        await session.xmpp.stop();
        await session.started;
        await session.peer.stop();
        await session.transportClosed;
      }
    },
  );
}

// The 300 ms deadline and 75 ms early observation are explicit local policy,
// not RFC durations. A missing reply is tested after an observed wire footer.
test.each(INVALID)(
  "RFC 6120 §4.4 / RFC 7395 §3.6: silent peer retains close deadline after %s",
  async (_name, input, condition) => {
    const session = parserSession("bound", input, "omit");
    try {
      expect(String(await session.started)).toBe(ACCOUNT);
      const negotiated = session.peer.transcript.length;
      const stanzasBefore = [...session.stanzas];
      session.peer.send(input);
      for (let index = 0; index < negotiated + 2; index += 1) {
        await session.peer.next();
      }
      assertFatalTranscript(session.peer, "bound", condition);
      expect(session.errors).toHaveLength(1);
      await delay(EARLY_CLOSE_CHECK_MS);
      expect(session.closedAt).toBe(0);
      expect(session.disconnected).toBe(0);
      expect(session.xmpp.status).toBe("closing");
      const stopped = session.xmpp.stop();
      expect(await stopped).toBeUndefined();
      await session.transportClosed;
      expect(session.closedAt - session.closingAt).toBeGreaterThanOrEqual(
        CLOSE_TIMEOUT_MS - CLOCK_TOLERANCE_MS,
      );
      expect(session.closes).toHaveLength(1);
      expect(session.errors).toHaveLength(1);
      expect(session.stanzas).toEqual(stanzasBefore);
      expect(session.disconnected).toBe(1);
      assertFatalTranscript(session.peer, "bound", condition);
    } finally {
      await session.xmpp.stop();
      await session.peer.stop();
      await session.transportClosed;
    }
  },
);

const ISOLATION_CASES = [
  ["initial features", ...INVALID[0]],
  ["authentication", ...INVALID[1]],
  ["classic restart", ...INVALID[2]],
  ["bound", ...INVALID[3]],
] as const;

test.each(ISOLATION_CASES)(
  "RFC 6120 §§4.4/4.9.1.1: %s has teardown-only reception after %s",
  async (stage, _name, input, condition) => {
    const session = parserSession(stage, input, "omit");
    const nextPeer = parserPeer("bound", "", "reply");
    const reopening: Promise<unknown>[] = [];
    // Application error callbacks cannot re-open a failed stream before its
    // asynchronously scheduled footer. Each attempted operation is observed.
    session.xmpp.once("error", () => {
      reopening.push(
        session.xmpp
          .open({ domain: "example.test", lang: "en" })
          .catch((error: Error) => error),
        session.xmpp.restart().catch((error: Error) => error),
      );
    });
    try {
      const result = await session.started;
      const stanzasBefore = [...session.stanzas];
      if (stage === "bound") {
        expect(String(result)).toBe(ACCOUNT);
        session.peer.send(input);
      } else {
        expect(result).toBeInstanceOf(Error);
      }
      for (;;) {
        const root = readFrame(await session.peer.next())[0];
        if ("open" in root && root.open === `{${FRAMING}}close`) {
          break;
        }
      }
      assertFatalTranscript(session.peer, stage, condition);
      const error = session.errors[0];
      expect(error).toBeInstanceOf(Error);
      expect(session.errors).toEqual([error]);
      const elementsBefore = [...session.elements];
      const attempted = await Promise.all(reopening);
      expect(attempted).toHaveLength(2);
      for (const operation of attempted) {
        expect(operation).toBeInstanceOf(Error);
        expect(operation).toMatchObject({ message: "Connection is closing" });
      }
      expect(
        await session.xmpp
          .send(xml("message", { to: "other@example.test/r" }))
          .catch((failure: Error) => failure),
      ).toBeInstanceOf(Error);

      // Bad, reopened, negotiable and ordinary documents cannot revive this
      // stream. Invalid close lookalikes must not replace the original deadline.
      for (const followup of [
        "<close>",
        '<close xmlns="urn:test:wrong"/>',
        `<close xmlns="${FRAMING}"><unexpected/></close>`,
        `<open xmlns="${FRAMING}" from="example.test" id="reopened" version="1.0"/>`,
        `<features xmlns="${STREAM}">${AUTH}<bind xmlns="${BIND}"/><sm xmlns="urn:xmpp:sm:3"/></features>`,
        `<success xmlns="${SASL}"/>`,
        `<message xmlns="${CONTENT}" id="late-stanza"><body>ignored</body></message>`,
      ]) {
        session.peer.send(followup);
      }
      await delay(EARLY_CLOSE_CHECK_MS);
      expect(session.closedAt).toBe(0);
      expect(session.xmpp.status).toBe("closing");
      expect(session.errors).toEqual([error]);
      expect(session.elements).toEqual(elementsBefore);
      expect(session.stanzas).toEqual(stanzasBefore);
      expect(session.online).toEqual(stage === "bound" ? [ACCOUNT] : []);
      assertFatalTranscript(session.peer, stage, condition);
      const stopped = session.xmpp.stop();
      session.peer.send(CLOSE);
      expect(String(await stopped)).toBe(CLOSE);
      await session.transportClosed;
      expect(session.closes).toHaveLength(1);
      expect(session.closes[0].reason).toBeUndefined();
      expect(session.disconnected).toBe(1);
      assertFatalTranscript(session.peer, stage, condition);
      await session.xmpp.stop();

      // A new transport, not another header on the failed transport, resets
      // terminal state and can establish new authenticated stanza authority.
      Object.assign(session.xmpp.options, { service: nextPeer.url });
      expect(String(await session.xmpp.start())).toBe(ACCOUNT);
      expect(session.xmpp.status).toBe("online");
      expect(session.online).toEqual(
        stage === "bound" ? [ACCOUNT, ACCOUNT] : [ACCOUNT],
      );
      expect(session.errors).toEqual([error]);
      expect(
        nextPeer.transcript
          .map((frame) => readFrame(frame)[0])
          .map((root) => ("open" in root ? root.open : "")),
      ).toEqual([
        `{${FRAMING}}open`,
        `{${SASL}}auth`,
        `{${FRAMING}}open`,
        `{${CONTENT}}iq`,
      ]);
      expect((await session.xmpp.stop())?.toString()).toBe(CLOSE);
      expect(nextPeer.errors).toEqual([]);
    } finally {
      await session.xmpp.stop();
      await session.started;
      await session.peer.stop();
      await nextPeer.stop();
      await session.transportClosed;
    }
  },
);

test("RFC 6120 §§4.4/4.9.1.2: an invalid initial opening retains reciprocal close", async () => {
  const session = parserSession(
    "opening",
    `<open xmlns="${FRAMING}" version="1.0">`,
    "omit",
  );
  try {
    const result = await session.started;
    expect(result).toBeInstanceOf(Error);
    for (;;) {
      const root = readFrame(await session.peer.next())[0];
      if ("open" in root && root.open === `{${FRAMING}}close`) {
        break;
      }
    }
    assertFatalTranscript(session.peer, "opening", "not-well-formed");
    const stopped = session.xmpp.stop();
    session.peer.send(CLOSE);
    expect(String(await stopped)).toBe(CLOSE);
    await session.transportClosed;
    expect(session.errors).toEqual([result]);
    expect(session.closes).toHaveLength(1);
    expect(session.closes[0].reason).toBeUndefined();
    expect(session.online).toEqual([]);
    expect(session.stanzas).toEqual([]);
  } finally {
    await session.xmpp.stop();
    await session.started;
    await session.peer.stop();
    await session.transportClosed;
  }
});

// RFC 6120 §4.6.1 / RFC 7395 §3.6: dead WS implicitly ends XMPP; §3.2 and
// RFC 6455 §7.1.7 reject binary transport input. Neither path owes XML closure
// through a transport that has already failed, unlike a bad standalone document.
test.each(["dead WebSocket", "binary message"] as const)(
  "RFC 6120 §4.6.1 / RFC 7395 §§3.2/3.6: distinguish %s from XML failure",
  async (failure) => {
    const session = parserSession("bound", "", "omit");
    try {
      expect(String(await session.started)).toBe(ACCOUNT);
      const transcriptBefore = [...session.peer.transcript];
      const stanzasBefore = [...session.stanzas];
      const disconnected = new Promise<void>((resolve) => {
        session.xmpp.once("disconnect", () => resolve());
      });
      if (failure === "dead WebSocket") {
        session.peer.terminate();
      } else {
        session.peer.send(new TextEncoder().encode(CLOSE));
      }
      await session.transportClosed;
      await disconnected;
      expect(session.peer.transcript).toEqual(transcriptBefore);
      expect(session.stanzas).toEqual(stanzasBefore);
      expect(session.disconnected).toBe(1);
      expect(session.xmpp.status).toBe("disconnect");
      expect(session.errors.map((error) => error.message)).toEqual(
        failure === "dead WebSocket"
          ? []
          : ["XMPP requires WebSocket text messages"],
      );
      expect(session.peer.errors).toEqual([]);
    } finally {
      await session.xmpp.stop();
      await session.peer.stop();
      await session.transportClosed;
    }
  },
);
