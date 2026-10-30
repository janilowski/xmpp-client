import { afterEach, describe, expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer, waitForDisconnect } from "./peer.ts";
import { readFrame } from "./xml.ts";
import { once } from "node:events";

// Outgoing boundaries, raw writes and SM rejection: rfc7395-outgoing-framing.test.ts.
// Opening dispatch failure, cancellation and races: rfc7395-opening.test.ts.

const OPEN =
  '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="example.test" version="1.0" id="peer-1"/>';
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
const CLIENT_OPEN =
  '<open version="1.0" xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="example.test" xml:lang="en"/>';
const CLIENT_OPTIONS = { domain: "example.test", lang: "en" };
const CLOSE_TIMEOUT_MS = 250;
const EVENT_TIMEOUT_MS = 2000;

let peer: ScriptedPeer;
let xmpp: ReturnType<typeof client>;
let errors: Error[] = [];
let expectedErrors: string[] = [];

// Exercise the public client, but stop before authentication unless a scenario needs it.
async function openStream({
  closeReply = "reply",
  serverOpen = OPEN,
  establishment = "open",
  onFrame = undefined as
    ((frame: string, remote: ScriptedPeer) => void) | undefined,
  beforeConnect = undefined as
    ((entity: ReturnType<typeof client>) => void) | undefined,
  credentials = undefined as { username: string; password: string } | undefined,
} = {}) {
  peer = new ScriptedPeer((frame, remote) => {
    const [root] = readFrame(frame);
    if (
      root &&
      "open" in root &&
      root.open === "{urn:ietf:params:xml:ns:xmpp-framing}open"
    ) {
      if (serverOpen) {
        remote.send(serverOpen);
      }
    }
    if (
      root &&
      "open" in root &&
      root.open === "{urn:ietf:params:xml:ns:xmpp-framing}close"
    ) {
      if (closeReply === "reply") {
        remote.send(CLOSE);
      }
    }
    onFrame?.(frame, remote);
  });
  errors = [];
  expectedErrors = [];
  xmpp = client({
    ...CLIENT_OPTIONS,
    service: peer.url,
    timeout: CLOSE_TIMEOUT_MS,
    credentials,
  });
  xmpp.reconnect.stop();
  xmpp.on("error", (error: Error) => errors.push(error));
  beforeConnect?.(xmpp);
  if (establishment === "online") {
    await xmpp.start();
  } else {
    await xmpp.connect(peer.url);
    if (establishment !== "connect") {
      await xmpp.open(CLIENT_OPTIONS);
    }
  }
}

afterEach(async () => {
  try {
    if (xmpp && xmpp.status !== "offline") {
      await xmpp.stop();
    }
  } finally {
    if (peer) {
      await peer.stop();
    }
  }
  expect(errors.map((error) => error.message)).toEqual(expectedErrors);
  if (peer) {
    expect(peer.errors).toEqual([]);
  }
});

describe("RFC 7395 — client wire behavior", () => {
  test.each([
    ["restart", "send"],
    ["restart", "sendMany"],
    ["transport", "send"],
    ["transport", "sendMany"],
  ] as const)(
    "§§3.4/3.7: replacement %s does not retain %s permission from the former stream",
    async (replacement, method) => {
      await openStream();
      await peer.next();
      if (replacement === "transport") {
        await xmpp.stop();
        await peer.stop();
        expect(peer.errors).toEqual([]);
        peer = new ScriptedPeer((frame, remote) => {
          if (frame.startsWith("<open")) {
            remote.send(OPEN);
          } else if (frame === CLOSE) {
            remote.send(CLOSE);
          }
        });
      }
      let sent: Promise<unknown> | undefined;
      xmpp.once(replacement === "restart" ? "opening" : "connect", () => {
        // Mutable presentation fields cannot grant stream-initiation authority.
        xmpp.root = xml("pretend", { xmlns: "urn:test:lifecycle" });
        xmpp.status = "online";
        const message = xml("message", { id: "too-early" });
        sent = (
          method === "send" ? xmpp.send(message) : xmpp.sendMany([message])
        ).catch((error: Error) => error);
      });
      if (replacement === "restart") {
        await xmpp.restart();
      } else {
        await xmpp.connect(peer.url);
        await xmpp.open(CLIENT_OPTIONS);
      }
      expect(await sent).toBeInstanceOf(Error);
      await xmpp.send(
        xml("notice", { xmlns: "urn:test:lifecycle", id: "barrier" }),
      );
      while (!peer.transcript.some((frame) => frame.includes('id="barrier"'))) {
        await peer.next();
      }
      expect(
        peer.transcript.some((frame) => frame.includes('id="too-early"')),
      ).toBe(false);
      expect(readFrame(peer.transcript[0])).toEqual(readFrame(CLIENT_OPEN));
      expect(xmpp.streamManagement.outbound_q).toEqual([]);
    },
  );

  test.each(["open", "close"] as const)(
    "§§3.4/3.6: normalized scalar namespaces cannot smuggle framing %s",
    async (name) => {
      await openStream();
      await peer.next();
      const header = xml(name, {
        xmlns: { toString: () => "urn:ietf:params:xml:ns:xmpp-framing" },
      });
      await expect(xmpp.send(header)).rejects.toBeInstanceOf(TypeError);
      expect(peer.transcript).toHaveLength(1);
      expect(xmpp.status).toBe("open");
    },
  );

  test.each(["send", "sendMany"] as const)(
    "§§3.4/3.7: %s cannot open another stream without a matching lifecycle transition",
    async (method) => {
      let openings = 0;
      await openStream({
        onFrame(frame, remote) {
          if (frame.startsWith("<open") && ++openings === 2) {
            remote.send(
              '<barrier xmlns="urn:test:lifecycle" id="replacement"/>',
            );
          }
        },
      });
      await peer.next();
      const replacement = Promise.withResolvers<string>();
      xmpp.on("nonza", (element) => {
        if (element.is("barrier", "urn:test:lifecycle")) {
          replacement.resolve("replacement");
        }
      });
      xmpp.once("error", () => replacement.resolve("error"));
      const element = xml("open", {
        xmlns: "urn:ietf:params:xml:ns:xmpp-framing",
        version: "1.0",
        to: "example.test",
      });
      const result = await (
        method === "send" ? xmpp.send(element) : xmpp.sendMany([element])
      ).catch((error: Error) => error);
      if (result instanceof Error) {
        expect(openings).toBe(1);
        expect(xmpp.status).toBe("open");
        return;
      }
      // If accepted, the replacement server opening must be parsed as a new
      // stream, not as an unexpected second open on the old parser.
      const timer = setTimeout(
        () => replacement.resolve("timeout"),
        EVENT_TIMEOUT_MS,
      );
      try {
        expect(await replacement.promise).toBe("replacement");
        expect(xmpp.status).toBe("open");
      } finally {
        clearTimeout(timer);
      }
    },
  );

  test.each(["send", "sendMany"] as const)(
    "§3.6: %s cannot write a close while leaving ordinary output enabled",
    async (method) => {
      await openStream();
      await peer.next();
      const element = xml("close", {
        xmlns: "urn:ietf:params:xml:ns:xmpp-framing",
      });
      const closed = (
        method === "send" ? xmpp.send(element) : xmpp.sendMany([element])
      ).catch((error: Error) => error);
      // Both writes are requested in one stack: peer timing cannot repair a
      // missing local transition to closing.
      const notice = xmpp
        .send(xml("notice", { xmlns: "urn:test:lifecycle", id: "after-close" }))
        .catch((error: Error) => error);
      const [result, later] = await Promise.all([closed, notice]);
      if (result instanceof Error) {
        expect(later).not.toBeInstanceOf(Error);
        while (
          !peer.transcript.some((frame) => frame.includes("after-close"))
        ) {
          await peer.next();
        }
        expect(
          peer.transcript.some((frame) => frame.startsWith("<close")),
        ).toBe(false);
        expect(xmpp.status).toBe("open");
        return;
      }
      // Rejection or managed closure are allowed; accepting a close and then
      // writing another document over that stream is not.
      expect(later).toBeInstanceOf(Error);
      await peer.waitForClose();
      expect(
        peer.transcript.some((frame) => frame.includes("after-close")),
      ).toBe(false);
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<close")),
      ).toHaveLength(1);
      expect(await waitForDisconnect(xmpp)).toBe(true);
    },
  );

  test.each(["open", "close"] as const)(
    "§3.3.3: a foreign serializer cannot smuggle a framing %s",
    async (name) => {
      await openStream();
      await peer.next();
      const element = xml("notice", { xmlns: "urn:test:lifecycle" });
      element.toString = () =>
        `<${name} xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>`;
      await expect(xmpp.send(element)).rejects.toBeInstanceOf(TypeError);
      expect(peer.transcript).toHaveLength(1);
      expect(xmpp.status).toBe("open");
    },
  );

  test.each([
    ["connect", "send"],
    ["connect", "sendMany"],
    ["opening", "send"],
    ["opening", "sendMany"],
  ] as const)(
    "§3.4: %s callback cannot put %s output before the initiating open",
    async (event, method) => {
      let called = 0;
      let sent: Promise<unknown> | undefined;
      await openStream({
        beforeConnect(entity) {
          entity.once(event, () => {
            called++;
            const element = xml("notice", {
              xmlns: "urn:test:early-send",
              id: "before-initiation",
            });
            sent = (
              method === "send"
                ? entity.send(element)
                : entity.sendMany([element])
            ).catch((error: Error) => error);
          });
        },
      });
      expect(called).toBe(1);
      const result = await sent;
      // Rejection or deferral until after the opening are both conforming.
      expect(readFrame(peer.transcript[0])).toEqual(readFrame(CLIENT_OPEN));
      if (!(result instanceof Error)) {
        expect(
          peer.transcript.findIndex((frame) =>
            frame.includes("before-initiation"),
          ),
        ).toBeGreaterThan(0);
      }
      await xmpp.send(
        xml("notice", { xmlns: "urn:test:early-send", id: "after-initiation" }),
      );
      while (
        !peer.transcript.some((frame) => frame.includes("after-initiation"))
      ) {
        await peer.next();
      }
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<open")),
      ).toHaveLength(1);
    },
  );

  test("§3.4/3.6 stopping before stream initiation sends no XML close", async () => {
    await openStream({ establishment: "connect" });
    await xmpp.stop();
    await peer.waitForClose();
    expect(peer.transcript).toEqual([]);
  });

  test("§3.8 XMPP ping uses XML frames, never whitespace keepalives", async () => {
    await openStream({
      onFrame(frame, remote) {
        if (frame.includes('id="keepalive"')) {
          remote.send(
            '<iq xmlns="jabber:client" type="result" id="keepalive"/>',
          );
        }
      },
    });
    await peer.next();
    const reply = await xmpp.iqCaller.request(
      xml(
        "iq",
        { type: "get", id: "keepalive" },
        xml("ping", { xmlns: "urn:xmpp:ping" }),
      ),
    );
    expect(reply.attrs.type).toBe("result");
    const frame = await peer.next();
    expect(frame.startsWith("<iq ")).toBe(true);
    expect(frame).toContain('<ping xmlns="urn:xmpp:ping"/>');
    expect(peer.transcript).toHaveLength(2);
    for (const sent of peer.transcript) {
      expect(sent.startsWith("<")).toBe(true);
      expect(sent.startsWith("<?xml")).toBe(false);
    }
  });

  test.each([
    [
      "size",
      '<message xmlns="jabber:client">' +
        "x".repeat(1024 * 1024) +
        "</message>",
    ],
    [
      "depth",
      '<message xmlns="jabber:client">' +
        "<x>".repeat(64) +
        "</x>".repeat(64) +
        "</message>",
    ],
  ])(
    "§6 local XML %s limit fails atomically with policy-violation",
    async (limit, frame) => {
      await openStream();
      await peer.next();
      const received: unknown[] = [];
      xmpp.on("stanza", (element: unknown) => received.push(element));
      expectedErrors = [`XML document exceeds ${limit} limit`];
      peer.send(frame);
      expect(await peer.next()).toContain(
        '<policy-violation xmlns="urn:ietf:params:xml:ns:xmpp-streams"/>',
      );
      expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
      await peer.waitForClose();
      expect(received).toEqual([]);
    },
  );

  test("§3.3.1 unsupported peer version rejects initiation and sends its stream error", async () => {
    const result = await openStream({
      serverOpen: OPEN.replace('version="1.0"', 'version="0.9"'),
    }).catch((error: Error) => error);
    expectedErrors = ["Unsupported stream version"];
    expect(result).toMatchObject({ condition: "unsupported-version" });
    await peer.next();
    expect(await peer.next()).toContain(
      '<unsupported-version xmlns="urn:ietf:params:xml:ns:xmpp-streams"/>',
    );
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
  });

  test("§3.3.3 every outgoing stanza carries its language without overwriting explicit values", async () => {
    await openStream();
    await peer.next();
    await xmpp.send(xml("message", {}, xml("body", {}, "hello")));
    await xmpp.sendMany([
      xml("message", { "xml:lang": "pl" }),
      xml("message", { "xml:lang": "x-private" }),
      xml("presence"),
    ]);
    for (const language of ["en", "pl", "x-private", "en"]) {
      const [root] = readFrame(await peer.next());
      expect(
        root &&
          "open" in root &&
          root.attributes["{http://www.w3.org/XML/1998/namespace}lang"],
      ).toBe(language);
    }
  });

  test("§3.3.3 incoming language is local to each document", async () => {
    await openStream();
    const received: unknown[] = [];
    xmpp.on("stanza", (element: { attrs: Record<string, string> }) =>
      received.push(element.attrs["xml:lang"]),
    );
    const last = once(xmpp, "nonza", {
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    peer.send('<message xmlns="jabber:client" xml:lang="pl"/>');
    peer.send('<message xmlns="jabber:client"/>');
    peer.send('<barrier xmlns="urn:test"/>');
    await last;
    expect(received).toEqual(["pl", undefined]);
  });

  test("§3.7 repeated restarts retain destination, version and language without closing", async () => {
    await openStream();
    await peer.next();
    for (let index = 0; index < 3; index += 1) {
      await xmpp.restart();
      expect(readFrame(await peer.next())).toEqual(readFrame(CLIENT_OPEN));
    }
    expect(peer.requests).toHaveLength(1);
  });

  test("§3.7 a rejected restart settles without retaining an old stream", async () => {
    let opens = 0;
    await openStream({
      serverOpen: "",
      onFrame(frame, remote) {
        if (!frame.startsWith("<open")) {
          return;
        }
        opens += 1;
        remote.send(opens === 1 ? OPEN : CLOSE);
      },
    });
    await expect(xmpp.restart()).rejects.toThrow("Stream closed before open");
    await peer.waitForClose();
  });

  test("§3.5 opening then stream error then close rejects start", async () => {
    const result = await openStream({
      establishment: "online",
      onFrame(frame, remote) {
        if (!frame.startsWith("<open")) {
          return;
        }
        remote.send(
          '<error xmlns="http://etherx.jabber.org/streams"><host-unknown xmlns="urn:ietf:params:xml:ns:xmpp-streams"/></error>',
        );
        remote.send(CLOSE);
      },
    }).catch((error: Error) => error);
    expectedErrors = ["host-unknown"];
    expect(result).toMatchObject({ condition: "host-unknown" });
    await peer.waitForClose();
  });

  test("§3.4 peer close during initiation rejects start without a timeout", async () => {
    const result = await openStream({
      serverOpen: CLOSE,
      establishment: "online",
    }).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message: expect.stringMatching(/closed before (open|online)/),
    });
    await peer.waitForClose();
  });

  test("§3.6 transport loss during initiation rejects start", async () => {
    const result = await openStream({
      serverOpen: "",
      establishment: "online",
      onFrame(_frame, remote) {
        remote.terminate();
      },
    }).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message: expect.stringMatching(/closed before (open|online)/),
    });
  });
  test("§3.7/3.9 ignores STARTTLS, authenticates and restarts after SASL success", async () => {
    let opens = 0;
    const online = Promise.withResolvers<unknown>();
    await openStream({
      credentials: { username: "user", password: "secret" },
      onFrame(frame, remote) {
        const [root] = readFrame(frame);
        if (!root || !("open" in root)) {
          return;
        }
        if (root.open === "{urn:ietf:params:xml:ns:xmpp-framing}open") {
          opens += 1;
          if (opens === 1) {
            xmpp.once("online", online.resolve);
            remote.send(
              '<features xmlns="http://etherx.jabber.org/streams"><starttls xmlns="urn:ietf:params:xml:ns:xmpp-tls"><required/></starttls><mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms></features>',
            );
          } else {
            remote.send(
              '<features xmlns="http://etherx.jabber.org/streams"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/></features>',
            );
          }
        } else if (root.open === "{urn:ietf:params:xml:ns:xmpp-sasl}auth") {
          remote.send('<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>');
        } else if (root.open === "{jabber:client}iq") {
          remote.send(
            `<iq xmlns="jabber:client" type="result" id="${root.attributes["{}id"]}"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>user@example.test/test</jid></bind></iq>`,
          );
        }
      },
    });
    // Four peer frames are an explicit progress barrier; silence fails in next().
    const sent = [];
    for (let index = 0; index < 4; index += 1) {
      sent.push(readFrame(await peer.next())[0]);
    }
    const address = await online.promise;
    expect(String(address)).toBe("user@example.test/test");
    expect(opens).toBe(2);
    expect(
      sent.map((frame) => (frame && "open" in frame ? frame.open : null)),
    ).toEqual([
      "{urn:ietf:params:xml:ns:xmpp-framing}open",
      "{urn:ietf:params:xml:ns:xmpp-sasl}auth",
      "{urn:ietf:params:xml:ns:xmpp-framing}open",
      "{jabber:client}iq",
    ]);
  });

  test("§3.6 abrupt transport loss disconnects the stream", async () => {
    await openStream();
    const disconnected = once(xmpp, "disconnect", {
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    peer.terminate();
    await disconnected;
    expect(xmpp.status).toBe("disconnect");
  });
  test("§3.3.2 invalid framing namespace produces a standalone stream error and close", async () => {
    await openStream();
    await peer.next();
    expectedErrors = ["Invalid framing namespace"];
    peer.send('<close xmlns="urn:wrong"/>');
    expect(readFrame(await peer.next())).toEqual(
      readFrame(
        '<stream:error xmlns:stream="http://etherx.jabber.org/streams" xml:lang="en"><invalid-namespace xmlns="urn:ietf:params:xml:ns:xmpp-streams"/></stream:error>',
      ),
    );
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
  });

  test("§3.2 binary frames close the transport without delivering a stanza", async () => {
    await openStream();
    const stanzas: unknown[] = [];
    xmpp.on("stanza", (stanza: unknown) => stanzas.push(stanza));
    expectedErrors = ["XMPP requires WebSocket text messages"];
    peer.send(new TextEncoder().encode('<message xmlns="jabber:client"/>'));
    await peer.waitForClose();
    expect(stanzas).toEqual([]);
  });

  test("§3.6 responds to peer close and completes the transport handshake", async () => {
    await openStream();
    await peer.next();
    peer.send(CLOSE);
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
    expect(await waitForDisconnect(xmpp)).toBe(true);
    expect(xmpp.status).toBe("disconnect");
  });

  test("§3.6 missing close reply has a bounded transport shutdown", async () => {
    await openStream({ closeReply: "omit" });
    await peer.next();
    await xmpp.stop();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
    expect(xmpp.status).toBe("offline");
  });

  test("§3.6 sendMany cannot bypass the closing stream", async () => {
    await openStream({ closeReply: "omit" });
    await peer.next();
    const stopped = xmpp.stop();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    const result = await xmpp
      .sendMany([xml("message")])
      .catch((error: Error) => error);
    await stopped;
    expect(result).toBeInstanceOf(Error);
    expect(peer.transcript).toHaveLength(2);
  });

  // RFC 6120 §4.4: stop sending, but keep processing the peer's remaining input.
  test.each(["open", "restart"] as const)(
    "§3.6: %s cannot reopen while awaiting reciprocal close",
    async (method) => {
      await openStream({ closeReply: "omit" });
      await peer.next();
      const stopped = xmpp.stop();
      try {
        expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
        const result = await (
          method === "open" ? xmpp.open(CLIENT_OPTIONS) : xmpp.restart()
        ).catch((error: Error) => error);
        expect(result).toBeInstanceOf(Error);
        expect(xmpp.status).toBe("closing");

        const received: string[] = [];
        xmpp.on("stanza", (element) => received.push(element.attrs.id));
        peer.send('<message xmlns="jabber:client" id="remaining"/>');
        peer.send(CLOSE);
        expect((await stopped)?.toString()).toBe(CLOSE);
        await peer.waitForClose();
        expect(received).toEqual(["remaining"]);
        expect(peer.transcript.map(readFrame)).toEqual([
          readFrame(CLIENT_OPEN),
          readFrame(CLOSE),
        ]);
        expect(xmpp.status).toBe("offline");
      } finally {
        await stopped;
      }
    },
  );

  for (const initiator of ["client", "peer"] as const) {
    test.each(["open", "restart"] as const)(
      `§3.6: %s cannot reopen from the close callback / ${initiator}`,
      async (method) => {
        await openStream({ closeReply: "omit" });
        await peer.next();
        const reopened = Promise.withResolvers<unknown>();
        xmpp.once("close", () => {
          const result =
            method === "open" ? xmpp.open(CLIENT_OPTIONS) : xmpp.restart();
          return result.then(reopened.resolve, reopened.resolve);
        });
        const stopped = initiator === "client" ? xmpp.stop() : undefined;
        try {
          if (initiator === "client") {
            expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
          }
          peer.send(CLOSE);
          expect(await reopened.promise).toBeInstanceOf(Error);
          const closed = await stopped;
          if (initiator === "client") {
            expect(closed?.toString()).toBe(CLOSE);
          }
          await peer.waitForClose();
          expect(peer.transcript.map(readFrame)).toEqual([
            readFrame(CLIENT_OPEN),
            readFrame(CLOSE),
          ]);
        } finally {
          await stopped;
        }
      },
    );
  }

  test.each(["open", "restart"] as const)(
    "§3.6: %s cannot initiate a stream while its transport is shutting down",
    async (method) => {
      await openStream({ establishment: "connect" });
      const reopened = Promise.withResolvers<unknown>();
      xmpp.once("disconnecting", () => {
        const result =
          method === "open" ? xmpp.open(CLIENT_OPTIONS) : xmpp.restart();
        return result.then(reopened.resolve, reopened.resolve);
      });
      const stopped = xmpp.stop();
      try {
        expect(await reopened.promise).toBeInstanceOf(Error);
        await stopped;
        await peer.waitForClose();
        expect(peer.transcript).toEqual([]);
        expect(xmpp.status).toBe("offline");
      } finally {
        await stopped;
      }
    },
  );

  test("§3.6/3.7: completed shutdown permits initiation on a fresh transport", async () => {
    await openStream();
    await xmpp.stop();
    await peer.waitForClose();
    await peer.stop();
    peer = new ScriptedPeer((frame, remote) => {
      remote.send(frame.startsWith("<close") ? CLOSE : OPEN);
    });

    await xmpp.connect(peer.url);
    const result = await xmpp
      .open(CLIENT_OPTIONS)
      .catch((error: Error) => error);
    expect(result).not.toBeInstanceOf(Error);
    expect(peer.transcript.map(readFrame)).toEqual([readFrame(CLIENT_OPEN)]);
    expect(xmpp.status).toBe("open");
    await xmpp.stop();
    await peer.waitForClose();
    expect(peer.transcript.map(readFrame)).toEqual([
      readFrame(CLIENT_OPEN),
      readFrame(CLOSE),
    ]);
    expect(xmpp.status).toBe("offline");
  });

  test("§3.4 a second open cannot multiplex an existing stream", async () => {
    await openStream();
    const result = await xmpp
      .open(CLIENT_OPTIONS)
      .catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(peer.transcript).toHaveLength(1);
  });

  test("§3.6.1 a peer redirect is not followed implicitly", async () => {
    await openStream();
    await peer.next();
    peer.send(
      '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing" see-other-uri="ws://attacker.invalid/xmpp"/>',
    );
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
    expect(peer.requests).toHaveLength(1);
  });

  test("§3.5 fatal stream errors are delivered and followed by stream closure", async () => {
    await openStream();
    await peer.next();
    expectedErrors = ["policy-violation"];
    peer.send(
      '<stream:error xmlns:stream="http://etherx.jabber.org/streams"><policy-violation xmlns="urn:ietf:params:xml:ns:xmpp-streams"/></stream:error>',
    );
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    await peer.waitForClose();
    expect(errors).toHaveLength(1);
  });
  test("§3.1 offers xmpp in the HTTP upgrade", async () => {
    await openStream();
    expect(peer.requests).toHaveLength(1);
    expect(
      peer.requests[0].get("sec-websocket-protocol")?.split(/\s*,\s*/),
    ).toContain("xmpp");
  });

  test("§3.3.2/3.4 first message is a standalone framing open", async () => {
    const result = await openStream().then(
      () => undefined,
      (error: Error) => error,
    );
    expect(result).toBeUndefined();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLIENT_OPEN));
    expect(peer.transcript).toHaveLength(1);
  });

  test("§3.2/3.3.3 sends UTF-8 text with independent stanza namespaces", async () => {
    await openStream();
    await peer.next();
    const result = await xmpp
      .send(xml("message", {}, xml("body", {}, "Zażółć 🐦 & < >")))
      .catch((error: Error) => error);
    expect(result).toBeUndefined();
    expect(readFrame(await peer.next())).toEqual(
      readFrame(
        '<message xmlns="jabber:client" xml:lang="en"><body>Zażółć 🐦 &amp; &lt; &gt;</body></message>',
      ),
    );
  });

  test("§3.3.3 sendMany uses one message per stanza", async () => {
    await openStream();
    await peer.next();
    await xmpp.sendMany([xml("presence"), xml("message", { id: "second" })]);
    expect(readFrame(await peer.next())).toEqual(
      readFrame('<presence xmlns="jabber:client" xml:lang="en"/>'),
    );
    expect(readFrame(await peer.next())).toEqual(
      readFrame('<message id="second" xmlns="jabber:client" xml:lang="en"/>'),
    );
    expect(peer.transcript).toHaveLength(3);
  });

  test("§3.7 restart opens a new stream without a close frame", async () => {
    await openStream();
    await peer.next();
    await xmpp.restart();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLIENT_OPEN));
    expect(peer.transcript.map(readFrame)).toEqual([
      readFrame(CLIENT_OPEN),
      readFrame(CLIENT_OPEN),
    ]);
  });

  test("§3.6 closes the XMPP stream before the WebSocket", async () => {
    await openStream();
    await peer.next();
    const statuses: string[] = [];
    xmpp.on("status", (status: string) => statuses.push(status));
    await xmpp.stop();
    expect(readFrame(await peer.next())).toEqual(readFrame(CLOSE));
    expect(statuses).toEqual([
      "closing",
      "close",
      "disconnecting",
      "disconnect",
      "offline",
    ]);
  });
});
