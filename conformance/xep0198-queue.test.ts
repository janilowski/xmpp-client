import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const CONTENT = "jabber:client";
const SM = "urn:xmpp:sm:3";
const EXTENSION = "urn:test:sm-queue";
const PING = "urn:xmpp:ping";
const APPLICATION_ERRORS = "https://github.com/janilowski/xmpp-client/errors";
const SESSION_ID = "queue-session";
const QUEUE_FULL = "ERR_SM_QUEUE_FULL";
const TIMEOUT_MS = 1000;
const ACK_DEBOUNCE_MS = 60_000;
const DEFAULT_MAX_STANZAS = 1024;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

type Limits = { maxStanzas?: number; maxBytes?: number };
type QueueError = Error & { code?: string };

// The transcript is the oracle; this peer never acknowledges application writes
// automatically. Tests choose exact h values independently of the client queue.
function queuePeer(resumption: "allowed" | "denied" = "allowed") {
  let authenticated = false;
  const frames: string[] = [];
  const acknowledgements: string[] = [];
  const replied = Promise.withResolvers<void>();
  const peer = new ScriptedPeer((frame, remote) => {
    const element = readFrame(frame)[0];
    if (!element || !("open" in element)) {
      throw new Error("Expected a client element");
    }
    if (element.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="queue"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (element.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (
      element.open === `{${CONTENT}}iq` &&
      frame.includes(`<bind xmlns="${BIND}"`)
    ) {
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${element.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (element.open === `{${SM}}enable`) {
      remote.send(
        `<enabled xmlns="${SM}"${resumption === "allowed" ? ` id="${SESSION_ID}" resume="true"` : ""}/>`,
      );
    } else if (element.open === `{${SM}}resume`) {
      remote.send(`<resumed xmlns="${SM}" previd="${SESSION_ID}" h="0"/>`);
    } else if (element.open === `{${EXTENSION}}sync`) {
      remote.send(frame);
    } else if (element.open === `{${SM}}a`) {
      acknowledgements.push(element.attributes["{}h"]);
    } else if (
      element.open === `{${CONTENT}}message` ||
      element.open === `{${CONTENT}}presence` ||
      element.open === `{${CONTENT}}iq`
    ) {
      frames.push(frame);
      if (element.attributes["{}id"] === "required-reply") {
        replied.resolve();
      }
    } else if (element.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  return { peer, frames, acknowledgements, replied: replied.promise };
}

// Replay failures must produce an assertion, not leave a positive event pending.
function watchResumption(xmpp: ReturnType<typeof client>) {
  const observed = Promise.withResolvers<
    "resumed" | "error" | "deadline" | "cancelled"
  >();
  const finish = (outcome: "resumed" | "error" | "deadline" | "cancelled") => {
    clearTimeout(watchdog);
    xmpp.streamManagement.removeListener("resumed", resumed);
    xmpp.removeListener("error", error);
    observed.resolve(outcome);
  };
  const resumed = () => finish("resumed");
  const error = () => finish("error");
  const watchdog = setTimeout(() => finish("deadline"), TIMEOUT_MS);
  xmpp.streamManagement.once("resumed", resumed);
  xmpp.once("error", error);
  return { result: observed.promise, cancel: () => finish("cancelled") };
}

async function managedQueue(
  limits: Limits = {},
  resumption: "allowed" | "denied" = "allowed",
) {
  const fixture = queuePeer(resumption);
  const xmpp = client({
    service: fixture.peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
    streamManagement: limits,
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  xmpp.streamManagement.requestAckDebounce = ACK_DEBOUNCE_MS;
  const errors: QueueError[] = [];
  const acks: string[] = [];
  const failures: string[] = [];
  const enabled = Promise.withResolvers<void>();
  const barriers = new Map<string, () => void>();
  let sequence = 0;
  xmpp.on("error", (error: QueueError) => errors.push(error));
  xmpp.streamManagement.on("ack", (element: Element) =>
    acks.push(element.attrs.id),
  );
  xmpp.streamManagement.on("fail", (element: Element) =>
    failures.push(element.attrs.id),
  );
  xmpp.on("nonza", (element: Element) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    } else if (element.is("sync", EXTENSION)) {
      barriers.get(element.attrs.id)?.();
    }
  });

  // A document round trip settles prior ACKs and observes prior outgoing writes.
  async function sync() {
    const id = String(sequence++);
    const observed = Promise.withResolvers<void>();
    barriers.set(id, observed.resolve);
    const watchdog = setTimeout(
      () => observed.reject(new Error("Missing queue barrier")),
      TIMEOUT_MS,
    );
    try {
      await xmpp.send(xml("sync", { xmlns: EXTENSION, id }));
      await observed.promise;
    } finally {
      clearTimeout(watchdog);
      barriers.delete(id);
    }
  }

  try {
    expect(String(await xmpp.start())).toBe("user@example.test/r");
    await enabled.promise;
    await sync();
    expect(xmpp.streamManagement.enabled).toBe(true);
    return { ...fixture, xmpp, sync, errors, acks, failures };
  } catch (error) {
    await xmpp.stop();
    await fixture.peer.stop();
    throw error;
  }
}

// XEP-0198 v1.6.3 §4 retains responsibility until ACK. Limits/defaults and
// ERR_SM_QUEUE_FULL are local resource policy, not XEP-prescribed values.
test("XEP-0198 §4 local queue policy: exact count bound rejects before wire/send and ACK frees capacity", async () => {
  const fixture = await managedQueue({ maxStanzas: 2 });
  const { xmpp, peer, sync, frames, errors, acks, failures } = fixture;
  const sent: string[] = [];
  xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
  try {
    await xmpp.send(xml("message", { id: "a" }));
    await xmpp.send(xml("presence", { id: "b" }));
    const result = await xmpp
      .send(xml("message", { id: "overflow" }))
      .catch((error: QueueError) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toHaveProperty("code", QUEUE_FULL);
    await sync();
    expect(frames.map((frame) => readFrame(frame)[0])).toEqual([
      { open: `{${CONTENT}}message`, attributes: { "{}id": "a" } },
      { open: `{${CONTENT}}presence`, attributes: { "{}id": "b" } },
    ]);
    expect(sent).not.toContain("overflow");
    expect(acks).toEqual([]);
    expect(failures).toEqual([]);
    expect(xmpp.status).toBe("online");

    peer.send(`<a xmlns="${SM}" h="1"/>`);
    await sync();
    expect(acks).toEqual(["a"]);
    await xmpp.send(xml("message", { id: "c" }));
    const again = await xmpp
      .send(xml("presence", { id: "overflow-again" }))
      .catch((error: QueueError) => error);
    expect(again).toHaveProperty("code", QUEUE_FULL);
    await sync();
    peer.send(`<a xmlns="${SM}" h="3"/>`);
    await sync();
    expect(acks).toEqual(["a", "b", "c"]);
    expect(failures).toEqual([]);
    expect(frames).toHaveLength(3);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each([
  ["Latin", "é"],
  ["supplementary", "🙂"],
  ["escaped XML", "&amp;&lt;&gt;"],
] as const)(
  "XEP-0198 §4 local queue policy: exact serialized UTF-8 byte bound / %s",
  async (_name, body) => {
    const source = `<message xmlns="${CONTENT}" id="byte"><body>${body}</body></message>`;
    const bytes = new TextEncoder().encode(source).byteLength;
    const fixture = await managedQueue({ maxStanzas: 4, maxBytes: bytes });
    const { xmpp, peer, sync, frames, acks, errors } = fixture;
    const value = xml(
      "message",
      { id: "byte" },
      xml("body", {}, "different tree"),
    );
    let calls = 0;
    value.toString = () => {
      calls++;
      return source;
    };
    try {
      await xmpp.send(value);
      expect(calls).toBe(1);
      const rejected = await xmpp
        .send(xml("presence", { id: "extra" }))
        .catch((error: QueueError) => error);
      expect(rejected).toHaveProperty("code", QUEUE_FULL);
      await sync();
      expect(frames).toEqual([source]);
      peer.send(`<a xmlns="${SM}" h="1"/>`);
      await sync();
      expect(acks).toEqual(["byte"]);
      await xmpp.send(value);
      expect(calls).toBe(2);
      await sync();
      peer.send(`<a xmlns="${SM}" h="2"/>`);
      await sync();
      expect(frames).toEqual([source, source]);
      expect(acks).toEqual(["byte", "byte"]);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("XEP-0198 §4 local queue policy: sendMany preserves its accepted prefix and stops at overflow", async () => {
  const fixture = await managedQueue({ maxStanzas: 2 });
  const { xmpp, peer, sync, frames, acks, errors } = fixture;
  try {
    const result = await xmpp
      .sendMany([
        xml("message", { id: "a" }),
        xml("presence", { id: "b" }),
        xml("message", { id: "overflow" }),
        xml("message", { id: "never" }),
      ])
      .catch((error: QueueError) => error);
    expect(result).toHaveProperty("code", QUEUE_FULL);
    await sync();
    expect(frames.map((frame) => readFrame(frame)[0])).toEqual([
      { open: `{${CONTENT}}message`, attributes: { "{}id": "a" } },
      { open: `{${CONTENT}}presence`, attributes: { "{}id": "b" } },
    ]);
    peer.send(`<a xmlns="${SM}" h="2"/>`);
    await sync();
    expect(acks).toEqual(["a", "b"]);
    await xmpp.send(xml("message", { id: "recovery" }));
    await sync();
    expect(frames).toHaveLength(3);
    expect(readFrame(frames[2])[0]).toMatchObject({
      attributes: { "{}id": "recovery" },
    });
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("XEP-0198 §4 local queue policy: nonzas and benign inbound traffic do not release a full budget", async () => {
  const fixture = await managedQueue({ maxStanzas: 1 });
  const { xmpp, peer, sync, frames, acknowledgements, acks, errors } = fixture;
  try {
    await xmpp.send(xml("message", { id: "held" }));
    for (const id of ["one", "two", "three"]) {
      peer.send(`<message xmlns="${CONTENT}" id="${id}"/>`);
      peer.send(`<notice xmlns="${EXTENSION}"/>`);
    }
    peer.send(`<r xmlns="${SM}"/>`);
    await xmpp.send(xml("r", { xmlns: SM }));
    await xmpp.send(xml("a", { xmlns: SM, h: "0" }));
    await sync();
    await sync();
    expect(acknowledgements).toContain("3");
    const denied = await xmpp
      .send(xml("message", { id: "overflow" }))
      .catch((error: QueueError) => error);
    expect(denied).toHaveProperty("code", QUEUE_FULL);
    expect(frames).toHaveLength(1);
    expect(acks).toEqual([]);
    expect(xmpp.status).toBe("online");
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each(["distinct", "same"] as const)(
  "XEP-0198 §4 local queue policy: concurrent sends reserve capacity before write completion / %s Element",
  async (kind) => {
    const fixture = await managedQueue({ maxStanzas: 1 });
    const { xmpp, peer, sync, frames, acks, errors } = fixture;
    const first = xml("message", { id: "first" });
    const second = kind === "same" ? first : xml("message", { id: "second" });
    const socket = xmpp.socket!;
    const write = socket.write.bind(socket);
    const entered = Promise.withResolvers<void>();
    let release: (() => void) | undefined;
    let holding = true;
    socket.write = (source: string, callback: () => void) => {
      if (holding && source.includes('id="first"')) {
        holding = false;
        release = () => {
          release = undefined;
          write(source, callback);
        };
        entered.resolve();
        return;
      }
      return write(source, callback);
    };
    const pending = xmpp.send(first).catch((error: Error) => error);
    try {
      await entered.promise;
      const denied = await xmpp
        .send(second)
        .catch((error: QueueError) => error);
      expect(denied).toHaveProperty("code", QUEUE_FULL);
      expect(frames).toEqual([]);
      release!();
      expect(await pending).toBeUndefined();
      await sync();
      expect(frames).toHaveLength(1);
      peer.send(`<a xmlns="${SM}" h="1"/>`);
      await sync();
      expect(acks).toEqual(["first"]);
      await xmpp.send(second);
      await sync();
      peer.send(`<a xmlns="${SM}" h="2"/>`);
      await sync();
      expect(acks).toEqual(["first", kind === "same" ? "first" : "second"]);
      expect(frames).toHaveLength(2);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      release?.();
      await pending;
      socket.write = write;
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("XEP-0198 §4 local queue policy: an unsent write failure rolls back reservation", async () => {
  const fixture = await managedQueue({ maxStanzas: 1 });
  const { xmpp, peer, sync, frames, acks, errors } = fixture;
  const socket = xmpp.socket!;
  const write = socket.write.bind(socket);
  const failure = new Error("pre-wire failure");
  const sent: string[] = [];
  xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
  socket.write = (source: string, callback: () => void) => {
    if (source.includes('id="write-failed"')) {
      throw failure;
    }
    return write(source, callback);
  };
  try {
    const result = await xmpp
      .send(xml("message", { id: "write-failed" }))
      .catch((error: Error) => error);
    expect(result).toBe(failure);
    expect(sent).toEqual([]);
    await xmpp.send(xml("message", { id: "recovery" }));
    await sync();
    expect(frames).toHaveLength(1);
    expect(readFrame(frames[0])[0]).toMatchObject({
      attributes: { "{}id": "recovery" },
    });
    peer.send(`<a xmlns="${SM}" h="1"/>`);
    await sync();
    expect(acks).toEqual(["recovery"]);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    socket.write = write;
    await xmpp.stop();
    await peer.stop();
  }
});

test.each(["count", "bytes"] as const)(
  "XEP-0198 §§4–5 local queue policy: a full retained queue replays once and retains its %s budget",
  async (limit) => {
    const initial = `<message xmlns="${CONTENT}" id="a"/><presence xmlns="${CONTENT}" id="b"/>`;
    const fixture = await managedQueue(
      limit === "count"
        ? { maxStanzas: 2 }
        : {
            maxStanzas: 3,
            maxBytes: new TextEncoder().encode(initial).byteLength,
          },
    );
    const replacement = queuePeer();
    const { xmpp, peer, sync, acks, failures, errors } = fixture;
    let observation: ReturnType<typeof watchResumption> | undefined;
    try {
      await xmpp.send(xml("message", { id: "a" }));
      await xmpp.send(xml("presence", { id: "b" }));
      await sync();
      const disconnected = new Promise<void>((resolve) =>
        xmpp.once("disconnect", resolve),
      );
      peer.terminate();
      await disconnected;
      expect(failures).toEqual([]);
      Object.assign(xmpp.options, { service: replacement.peer.url });
      observation = watchResumption(xmpp);
      expect(
        await xmpp.reconnect.reconnect().catch((error: Error) => error),
      ).toBeUndefined();
      expect(await observation.result).toBe("resumed");
      await sync();
      expect(replacement.frames.map((frame) => readFrame(frame)[0])).toEqual([
        { open: `{${CONTENT}}message`, attributes: { "{}id": "a" } },
        { open: `{${CONTENT}}presence`, attributes: { "{}id": "b" } },
      ]);
      const denied = await xmpp
        .send(xml("message", { id: "overflow" }))
        .catch((error: QueueError) => error);
      expect(denied).toHaveProperty("code", QUEUE_FULL);
      replacement.peer.send(`<a xmlns="${SM}" h="1"/>`);
      await sync();
      expect(acks).toEqual(["a"]);
      const accepted = await xmpp
        .send(xml("message", { id: "c" }))
        .catch((error: QueueError) => error);
      expect(accepted).toBeUndefined();
      await sync();
      replacement.peer.send(`<a xmlns="${SM}" h="3"/>`);
      await sync();
      expect(acks).toEqual(["a", "b", "c"]);
      expect(failures).toEqual([]);
      expect(replacement.frames).toHaveLength(3);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
      expect(replacement.peer.errors).toEqual([]);
    } finally {
      observation?.cancel();
      await xmpp.stop();
      await peer.stop();
      await replacement.peer.stop();
    }
  },
);

test("XEP-0198 §§4–5 local queue policy: a late original write rejection cannot release a replayed item", async () => {
  const fixture = await managedQueue({ maxStanzas: 1 });
  const replacement = queuePeer();
  const { xmpp, peer, sync, frames, acks, failures, errors } = fixture;
  const write = xmpp.write.bind(xmpp);
  const completion = Promise.withResolvers<void>();
  const failure = new Error("late original write rejection");
  let holding = true;
  xmpp.write = (source: string) => {
    const written = write(source);
    if (holding && source.includes('id="held"')) {
      holding = false;
      // The real peer receives this write before its old operation settles.
      return written.then(() => completion.promise);
    }
    return written;
  };
  const pending = xmpp
    .send(xml("presence", { id: "held" }))
    .catch((error: Error) => error);
  let observation: ReturnType<typeof watchResumption> | undefined;
  try {
    await sync();
    expect(frames).toHaveLength(1);
    const disconnected = new Promise<void>((resolve) =>
      xmpp.once("disconnect", resolve),
    );
    peer.terminate();
    await disconnected;
    Object.assign(xmpp.options, { service: replacement.peer.url });
    observation = watchResumption(xmpp);
    expect(
      await xmpp.reconnect.reconnect().catch((error: Error) => error),
    ).toBeUndefined();
    expect(await observation.result).toBe("resumed");
    await sync();
    expect(replacement.frames.map((frame) => readFrame(frame)[0])).toEqual([
      { open: `{${CONTENT}}presence`, attributes: { "{}id": "held" } },
    ]);

    completion.reject(failure);
    expect(await pending).toBe(failure);
    const denied = await xmpp
      .send(xml("message", { id: "overflow" }))
      .catch((error: QueueError) => error);
    expect(denied).toHaveProperty("code", QUEUE_FULL);
    await sync();
    expect(replacement.frames).toHaveLength(1);
    replacement.peer.send(`<a xmlns="${SM}" h="1"/>`);
    await sync();
    expect(acks).toEqual(["held"]);
    const recovery = await xmpp
      .send(xml("presence", { id: "recovery" }))
      .catch((error: Error) => error);
    expect(recovery).toBeUndefined();
    await sync();
    replacement.peer.send(`<a xmlns="${SM}" h="2"/>`);
    await sync();
    expect(acks).toEqual(["held", "recovery"]);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
    expect(replacement.peer.errors).toEqual([]);
  } finally {
    observation?.cancel();
    completion.resolve();
    await pending;
    xmpp.write = write;
    await xmpp.stop();
    await peer.stop();
    await replacement.peer.stop();
  }
});

test.each(["concurrent application send", "ACK while replaying"] as const)(
  "XEP-0198 §§4–5 local queue policy: delayed replay completion / %s",
  async (scenario) => {
    const fixture = await managedQueue({
      maxStanzas: scenario === "ACK while replaying" ? 2 : 1,
    });
    const replacement = queuePeer();
    const { xmpp, peer, sync, acks, failures, errors } = fixture;
    const first = xml("presence", { id: "a" });
    const entered = Promise.withResolvers<void>();
    let release: (() => void) | undefined;
    let restore: (() => void) | undefined;
    let observation: ReturnType<typeof watchResumption> | undefined;
    try {
      await xmpp.send(first);
      if (scenario === "ACK while replaying") {
        await xmpp.send(xml("presence", { id: "b" }));
      }
      await sync();
      const disconnected = new Promise<void>((resolve) =>
        xmpp.once("disconnect", resolve),
      );
      peer.terminate();
      await disconnected;

      // Delay only completion: the replacement peer really receives replay a.
      xmpp.once("connect", () => {
        const socket = xmpp.socket!;
        const write = socket.write.bind(socket);
        let holding = true;
        restore = () => {
          socket.write = write;
        };
        socket.write = (source: string, callback: () => void) => {
          write(source, () => {
            if (holding && source.includes('id="a"')) {
              holding = false;
              release = () => {
                release = undefined;
                callback();
              };
              entered.resolve();
              return;
            }
            callback();
          });
        };
      });
      Object.assign(xmpp.options, { service: replacement.peer.url });
      observation = watchResumption(xmpp);
      expect(
        await xmpp.reconnect.reconnect().catch((error: Error) => error),
      ).toBeUndefined();
      expect(
        await Promise.race([
          entered.promise.then(() => "writing"),
          observation.result,
        ]),
      ).toBe("writing");
      await sync();
      expect(replacement.frames.map((frame) => readFrame(frame)[0])).toEqual([
        { open: `{${CONTENT}}presence`, attributes: { "{}id": "a" } },
      ]);

      if (scenario === "concurrent application send") {
        const denied = await xmpp
          .send(first)
          .catch((error: QueueError) => error);
        expect(denied).toHaveProperty("code", QUEUE_FULL);
        await sync();
        expect(replacement.frames).toHaveLength(1);
        expect(acks).toEqual([]);
      } else {
        // The peer handled both originals; b must not be replayed after this ACK.
        replacement.peer.send(`<a xmlns="${SM}" h="2"/>`);
        await sync();
        expect(acks).toEqual(["a", "b"]);
      }
      release!();
      expect(await observation.result).toBe("resumed");
      await sync();
      expect(replacement.frames).toHaveLength(1);
      if (scenario === "concurrent application send") {
        const denied = await xmpp
          .send(first)
          .catch((error: QueueError) => error);
        expect(denied).toHaveProperty("code", QUEUE_FULL);
        replacement.peer.send(`<a xmlns="${SM}" h="1"/>`);
        await sync();
        expect(acks).toEqual(["a"]);
      }
      const recovery = await xmpp
        .send(xml("presence", { id: "c" }))
        .catch((error: Error) => error);
      expect(recovery).toBeUndefined();
      await sync();
      expect(replacement.frames.map((frame) => readFrame(frame)[0])).toEqual([
        { open: `{${CONTENT}}presence`, attributes: { "{}id": "a" } },
        { open: `{${CONTENT}}presence`, attributes: { "{}id": "c" } },
      ]);
      replacement.peer.send(
        `<a xmlns="${SM}" h="${scenario === "ACK while replaying" ? 3 : 2}"/>`,
      );
      await sync();
      expect(acks).toEqual(
        scenario === "ACK while replaying" ? ["a", "b", "c"] : ["a", "c"],
      );
      expect(failures).toEqual([]);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
      expect(replacement.peer.errors).toEqual([]);
    } finally {
      observation?.cancel();
      release?.();
      restore?.();
      await xmpp.stop();
      await peer.stop();
      await replacement.peer.stop();
    }
  },
);

test("XEP-0198 §4 local queue policy: one byte over an empty budget rejects the serialized snapshot", async () => {
  const source = `<message xmlns="${CONTENT}" id="byte"><body>🙂</body></message>`;
  const fixture = await managedQueue({
    maxBytes: new TextEncoder().encode(source).byteLength - 1,
  });
  const { xmpp, peer, sync, frames, errors } = fixture;
  const value = xml("message", { id: "byte" });
  let calls = 0;
  value.toString = () => {
    calls++;
    return source;
  };
  try {
    const result = await xmpp.send(value).catch((error: QueueError) => error);
    expect(result).toHaveProperty("code", QUEUE_FULL);
    expect(calls).toBe(1);
    await sync();
    expect(frames).toEqual([]);
    const recovery = await xmpp
      .send(xml("presence", { id: "recovery" }))
      .catch((error: QueueError) => error);
    expect(recovery).toBeUndefined();
    await sync();
    expect(frames).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("XEP-0198 §4 local queue policy: nonresumable disconnect disposes ownership and releases both budgets", async () => {
  const source = `<message xmlns="${CONTENT}" id="old-item"/>`;
  const fixture = await managedQueue(
    { maxStanzas: 1, maxBytes: new TextEncoder().encode(source).byteLength },
    "denied",
  );
  const replacement = queuePeer("denied");
  const { xmpp, peer, sync, acks, failures, errors } = fixture;
  try {
    await xmpp.send(xml("message", { id: "old-item" }));
    await sync();
    const disconnected = new Promise<void>((resolve) =>
      xmpp.once("disconnect", resolve),
    );
    peer.terminate();
    await disconnected;
    expect(failures).toEqual(["old-item"]);
    Object.assign(xmpp.options, { service: replacement.peer.url });
    const enabled = Promise.withResolvers<void>();
    xmpp.on("nonza", (element: Element) => {
      if (element.is("enabled", SM)) {
        enabled.resolve();
      }
    });
    await xmpp.reconnect.reconnect();
    await enabled.promise;
    await sync();
    const accepted = await xmpp
      .send(xml("message", { id: "new-item" }))
      .catch((error: QueueError) => error);
    expect(accepted).toBeUndefined();
    await sync();
    replacement.peer.send(`<a xmlns="${SM}" h="1"/>`);
    await sync();
    expect(acks).toEqual(["new-item"]);
    expect(replacement.frames).toHaveLength(1);
    expect(readFrame(replacement.frames[0])[0]).toMatchObject({
      attributes: { "{}id": "new-item" },
    });
    await xmpp.stop();
    expect(failures).toEqual(["old-item"]);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
    expect(replacement.peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
    await replacement.peer.stop();
  }
});

test.each([
  ["get", "ping", PING],
  ["get", "unknown", EXTENSION],
  ["set", "unknown", EXTENSION],
] as const)(
  "XEP-0198 §4 local queue policy: a required IQ reply closes with queue-full at capacity / %s / %s",
  async (type, payload, namespace) => {
    const fixture = await managedQueue({ maxStanzas: 1 });
    const { xmpp, peer, frames, failures, replied, errors, sync } = fixture;
    const outcome = Promise.withResolvers<"closed" | "reply" | "timeout">();
    xmpp.once("disconnect", () => outcome.resolve("closed"));
    replied
      .then(() => outcome.resolve("reply"))
      .catch(() => outcome.resolve("timeout"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await xmpp.send(xml("message", { id: "held" }));
      await sync();
      const before = peer.transcript.length;
      peer.send(
        `<iq xmlns="${CONTENT}" from="example.test" id="required-reply" type="${type}"><${payload} xmlns="${namespace}"/></iq>`,
      );
      timer = setTimeout(() => outcome.resolve("timeout"), TIMEOUT_MS);
      expect(await outcome.promise).toBe("closed");
      expect(frames).toHaveLength(1);
      expect(readFrame(frames[0])[0]).toMatchObject({
        attributes: { "{}id": "held" },
      });
      await peer.waitForClose();
      const ending = peer.transcript.slice(before);
      expect(ending.map((frame) => readFrame(frame)[0])).toEqual([
        { open: `{${STREAM}}error`, attributes: {} },
        { open: `{${FRAMING}}close`, attributes: {} },
      ]);
      expect(readFrame(ending[0])).toEqual(
        readFrame(
          `<stream:error xmlns:stream="${STREAM}"><undefined-condition xmlns="${STREAM_ERRORS}"/><queue-full xmlns="${APPLICATION_ERRORS}"/></stream:error>`,
        ),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toHaveProperty("code", QUEUE_FULL);
      await xmpp.stop();
      expect(failures).toEqual(["held"]);
      expect(peer.errors).toEqual([]);
    } finally {
      clearTimeout(timer);
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("local queue defaults: 1024 unacknowledged stanzas fit, the next is refused", async () => {
  const fixture = await managedQueue();
  const { xmpp, peer, sync, frames } = fixture;
  try {
    for (let index = 0; index < DEFAULT_MAX_STANZAS; index++) {
      await xmpp.send(xml("message", { id: `item-${index}` }));
    }
    const denied = await xmpp
      .send(xml("presence", { id: "overflow" }))
      .catch((error: QueueError) => error);
    expect(denied).toHaveProperty("code", QUEUE_FULL);
    await sync();
    expect(frames).toHaveLength(DEFAULT_MAX_STANZAS);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each(["await send", "return reply"] as const)(
  "local queue policy: an optional middleware send failure does not end the stream / %s",
  async (mode) => {
    const fixture = await managedQueue({ maxStanzas: 1 });
    const { xmpp, peer, sync, frames, errors, failures } = fixture;
    const reported = Promise.withResolvers<void>();
    xmpp.on("error", () => reported.resolve());
    xmpp.middleware.use(
      async (context: { stanza: Element }, next: () => unknown) => {
        if (context.stanza.attrs.id === "incoming") {
          if (mode === "return reply") {
            return xml("message", { id: "optional-overflow" });
          }
          await xmpp.send(xml("message", { id: "optional-overflow" }));
        }
        return next();
      },
    );
    try {
      await xmpp.send(xml("message", { id: "held" }));
      peer.send(`<message xmlns="${CONTENT}" id="incoming"/>`);
      await reported.promise;
      expect(await sync().catch((error: Error) => error)).toBeUndefined();
      expect(xmpp.status).toBe("online");
      expect(errors.map((error) => error.code)).toEqual([QUEUE_FULL]);
      expect(frames).toHaveLength(1);
      expect(failures).toEqual([]);
      expect(
        peer.transcript.some((frame) => frame.startsWith("<stream:error")),
      ).toBe(false);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("local queue defaults: exact 8 MiB serialized UTF-8 budget fits, one more stanza does not", async () => {
  const prefix = `<message xmlns="${CONTENT}" id="boundary"><body>`;
  const suffix = "</body></message>";
  const overhead = new TextEncoder().encode(prefix + suffix).byteLength;
  const source = prefix + "x".repeat(DEFAULT_MAX_BYTES - overhead) + suffix;
  const fixture = await managedQueue();
  const { xmpp, peer, sync, frames } = fixture;
  const value = xml("message", { id: "boundary" });
  value.toString = () => source;
  try {
    expect(new TextEncoder().encode(source).byteLength).toBe(DEFAULT_MAX_BYTES);
    await xmpp.send(value);
    const denied = await xmpp
      .send(xml("presence", { id: "overflow" }))
      .catch((error: QueueError) => error);
    expect(denied).toHaveProperty("code", QUEUE_FULL);
    await sync();
    expect(frames).toEqual([source]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});
