import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const EXTENSION = "urn:test:opening-dispatch";
const OPEN = `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="dispatch"/>`;
const CLOSE = `<close xmlns="${FRAMING}"/>`;
const OPTIONS = { domain: "example.test", lang: "en" };
const TIMEOUT_MS = 250;
const EVENT_TIMEOUT_MS = 2000;
const SHUTDOWN_WATCHDOG_MS = TIMEOUT_MS * 2;
const peers: ScriptedPeer[] = [];
const clients: ReturnType<typeof client>[] = [];
const errors: Error[] = [];

function openingPeer() {
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(OPEN);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(CLOSE);
    } else if (root.attributes["{}id"] === "barrier") {
      remote.send(`<barrier xmlns="${EXTENSION}"/>`);
    }
  });
  peers.push(peer);
  return peer;
}

function connection(peer: ScriptedPeer) {
  const xmpp = client({ ...OPTIONS, service: peer.url, timeout: TIMEOUT_MS });
  xmpp.reconnect.stop();
  xmpp.on("error", (error: Error) => errors.push(error));
  clients.push(xmpp);
  return xmpp;
}

afterEach(async () => {
  try {
    for (const xmpp of clients.splice(0)) {
      await xmpp.stop();
    }
  } finally {
    for (const peer of peers.splice(0)) {
      await peer.stop();
      expect(peer.errors).toEqual([]);
    }
    expect(errors.splice(0)).toEqual([]);
  }
});

test.each(["stop", "disconnect"] as const)(
  "RFC 7395 §3.4: connecting callback %s cancels before contacting the peer",
  async (method) => {
    const peer = openingPeer();
    const xmpp = connection(peer);
    let shutdown: Promise<unknown> | undefined;
    xmpp.once("connecting", () => {
      shutdown = xmpp[method]();
    });
    const result = await xmpp.connect(peer.url).catch((error: Error) => error);
    await shutdown;
    expect(shutdown).toBeDefined();
    expect(result).toBeInstanceOf(Error);
    expect(xmpp.status).toBe(method === "stop" ? "offline" : "disconnect");
    expect(peer.requests).toEqual([]);
  },
);

// RFC 7395 §§3.4/3.6: a rejected initial write cannot authorize other XML.
test.each(["retry", "stop"] as const)(
  "failed initial opening dispatch keeps output blocked before %s",
  async (action) => {
    const peer = openingPeer();
    const xmpp = connection(peer);
    await xmpp.connect(peer.url);
    const socket = xmpp.socket;
    const original = socket.write;
    const failure = new Error("Opening was not dispatched");
    socket.write = () => {
      throw failure;
    };
    try {
      await expect(xmpp.open(OPTIONS)).rejects.toBe(failure);
    } finally {
      socket.write = original;
    }
    const forbidden = await xmpp
      .send(xml("notice", { xmlns: EXTENSION, id: "forbidden" }))
      .catch((error: Error) => error);
    expect(forbidden).toBeInstanceOf(Error);
    expect(peer.transcript).toEqual([]);

    if (action === "stop") {
      await xmpp.stop();
      await peer.waitForClose();
      expect(peer.transcript).toEqual([]);
      return;
    }

    await xmpp.restart();
    const received = once(xmpp, "nonza", {
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    await xmpp.send(xml("notice", { xmlns: EXTENSION, id: "barrier" }));
    await received;
    await xmpp.stop();
    await peer.waitForClose();
    expect(peer.transcript.map((frame) => readFrame(frame)[0])).toMatchObject([
      { open: `{${FRAMING}}open` },
      { open: `{${EXTENSION}}notice`, attributes: { "{}id": "barrier" } },
      { open: `{${FRAMING}}close` },
    ]);
    expect(peer.transcript).toHaveLength(3);
  },
);

test("RFC 7395 §§3.4/3.6: a missing opening-write callback cannot hang shutdown or authorize a replacement", async () => {
  const first = openingPeer();
  const second = openingPeer();
  const xmpp = connection(first);
  await xmpp.connect(first.url);
  const socket = xmpp.socket;
  const original = socket.write;
  let release: (() => void) | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<unknown> | undefined;
  socket.write = (_source: string, callback: () => void) => {
    // A driver that neither dispatches the header nor completes its write.
    release = callback;
  };
  try {
    await expect(xmpp.open(OPTIONS)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(release).toBeFunction();
    socket.write = original;
    stopping = xmpp.stop();
    const outcome = await Promise.race([
      stopping.then(() => "stopped"),
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve("watchdog"), SHUTDOWN_WATCHDOG_MS);
      }),
    ]);
    clearTimeout(watchdog);
    if (outcome === "watchdog") {
      // Release before asserting so a broken shutdown yields an assertion,
      // not a framework timeout or a hanging cleanup hook.
      release?.();
      await stopping;
    }
    expect(outcome).toBe("stopped");
    await first.waitForClose();
    expect(first.transcript).toEqual([]);

    await xmpp.connect(second.url);
    release?.();
    await Promise.resolve();
    const forbidden = await xmpp
      .send(xml("notice", { xmlns: EXTENSION, id: "forbidden" }))
      .catch((error: Error) => error);
    expect(forbidden).toBeInstanceOf(Error);
    expect(second.transcript).toEqual([]);
    await xmpp.open(OPTIONS);
    const received = once(xmpp, "nonza", {
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    await xmpp.send(xml("notice", { xmlns: EXTENSION, id: "barrier" }));
    await received;
    await xmpp.stop();
    await second.waitForClose();
    expect(second.transcript.map((frame) => readFrame(frame)[0])).toMatchObject(
      [
        { open: `{${FRAMING}}open` },
        { open: `{${EXTENSION}}notice`, attributes: { "{}id": "barrier" } },
        { open: `{${FRAMING}}close` },
      ],
    );
    expect(second.transcript).toHaveLength(3);
  } finally {
    clearTimeout(watchdog);
    socket.write = original;
    release?.();
    await stopping;
  }
});

test("RFC 7395 §3.4: stale opening callbacks cannot authorize replacement output", async () => {
  const first = openingPeer();
  const second = openingPeer();
  const xmpp = connection(first);
  await xmpp.connect(first.url);
  let replacing: Promise<unknown> | undefined;
  xmpp.once("opening", () => {
    replacing = xmpp.connect(second.url);
  });
  const stale = await xmpp.open(OPTIONS).catch((error: Error) => error);
  expect(replacing).toBeDefined();
  await replacing;
  expect(stale).toBeInstanceOf(Error);
  const forbidden = await xmpp
    .send(xml("notice", { xmlns: EXTENSION, id: "forbidden" }))
    .catch((error: Error) => error);
  expect(forbidden).toBeInstanceOf(Error);
  expect(first.transcript).toEqual([]);
  expect(second.transcript).toEqual([]);

  const recovered = await xmpp.open(OPTIONS).catch((error: Error) => error);
  expect(recovered).not.toBeInstanceOf(Error);
  const received = once(xmpp, "nonza", {
    signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
  });
  await xmpp.send(xml("notice", { xmlns: EXTENSION, id: "barrier" }));
  await received;
  await xmpp.stop();
  await second.waitForClose();
  expect(second.transcript.map((frame) => readFrame(frame)[0])).toMatchObject([
    { open: `{${FRAMING}}open` },
    { open: `{${EXTENSION}}notice`, attributes: { "{}id": "barrier" } },
    { open: `{${FRAMING}}close` },
  ]);
  expect(second.transcript).toHaveLength(3);
  expect(first.transcript).toEqual([]);
});

test.each(["stop", "disconnect"] as const)(
  "RFC 7395 §§3.4/3.6: opening callback %s cannot be lost to parser attachment",
  async (method) => {
    const peer = openingPeer();
    const xmpp = connection(peer);
    await xmpp.connect(peer.url);
    let shutdown: Promise<unknown> | undefined;
    xmpp.once("opening", () => {
      shutdown = xmpp[method]();
    });
    const opened = await xmpp.open(OPTIONS).catch((error: Error) => error);
    expect(shutdown).toBeDefined();
    await shutdown;
    expect(xmpp.status).toBe(method === "stop" ? "offline" : "disconnect");
    await peer.waitForClose();
    if (opened instanceof Error) {
      expect(opened.name).not.toBe("TimeoutError");
      expect(peer.transcript).toEqual([]);
    } else {
      // Managed completion followed by balanced closure is also permitted.
      expect(peer.transcript.map((frame) => readFrame(frame)[0])).toMatchObject(
        [{ open: `{${FRAMING}}open` }, { open: `{${FRAMING}}close` }],
      );
      expect(peer.transcript).toHaveLength(2);
    }
  },
);

test("RFC 7395 §§3.4/3.6: same-stack open then stop balances dispatched XML", async () => {
  const peer = openingPeer();
  const xmpp = connection(peer);
  await xmpp.connect(peer.url);
  const opening = xmpp.open(OPTIONS).catch((error: Error) => error);
  const stopping = xmpp.stop();
  await Promise.all([opening, stopping]);
  await peer.waitForClose();
  expect(peer.transcript.map((frame) => readFrame(frame)[0])).toMatchObject([
    { open: `{${FRAMING}}open` },
    { open: `{${FRAMING}}close` },
  ]);
  expect(peer.transcript).toHaveLength(2);
  expect(xmpp.status).toBe("offline");
});

test("RFC 7395 §3.6: shutdown inside an opening writer joins its dispatched header", async () => {
  const peer = openingPeer();
  const xmpp = connection(peer);
  await xmpp.connect(peer.url);
  const original = xmpp.write.bind(xmpp);
  let shutdown: Promise<unknown> | undefined;
  xmpp.write = (source: string) => {
    const result = original(source);
    if (source.startsWith("<open")) {
      shutdown = xmpp.stop();
    }
    return result;
  };
  await xmpp.open(OPTIONS).catch(() => {});
  expect(shutdown).toBeDefined();
  await shutdown;
  await peer.waitForClose();
  expect(peer.transcript.map((frame) => readFrame(frame)[0])).toMatchObject([
    { open: `{${FRAMING}}open` },
    { open: `{${FRAMING}}close` },
  ]);
  expect(peer.transcript).toHaveLength(2);
  expect(xmpp.status).toBe("offline");
});

// §3.7 implicitly closes both streams on a mandated SASL restart; an abort
// before its new opening must not add a closing header for the former stream.
test.each(["stop", "disconnect"] as const)(
  "RFC 7395 §3.7: %s during mandated restart cancels before its new opening",
  async (method) => {
    let authenticated = false;
    const peer = new ScriptedPeer((frame, remote) => {
      const root = readFrame(frame)[0];
      if (!("open" in root)) {
        throw new Error("Expected a client element");
      }
      if (root.open === `{${FRAMING}}open`) {
        remote.send(OPEN);
        if (!authenticated) {
          remote.send(
            `<features xmlns="${STREAM}"><mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms></features>`,
          );
        }
      } else if (root.open === `{${SASL}}auth`) {
        authenticated = true;
        remote.send(`<success xmlns="${SASL}"/>`);
      } else if (root.open === `{${FRAMING}}close`) {
        remote.send(CLOSE);
      }
    });
    peers.push(peer);
    const xmpp = client({
      ...OPTIONS,
      service: peer.url,
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    clients.push(xmpp);
    xmpp.reconnect.stop();
    xmpp.on("error", (error: Error) => errors.push(error));
    let openings = 0;
    let shutdown: Promise<unknown> | undefined;
    xmpp.on("opening", () => {
      if (++openings === 2) {
        shutdown = xmpp[method]();
      }
    });
    const started = await xmpp.start().catch((error: Error) => error);
    expect(shutdown).toBeDefined();
    await shutdown;
    expect(peer.transcript.map((frame) => readFrame(frame)[0])).toMatchObject([
      { open: `{${FRAMING}}open` },
      { open: `{${SASL}}auth` },
    ]);
    expect(peer.transcript).toHaveLength(2);
    expect(started).toBeInstanceOf(Error);
    expect(started.name).not.toBe("TimeoutError");
    expect(xmpp.status).toBe(method === "stop" ? "offline" : "disconnect");
    await peer.waitForClose();
  },
);

test("RFC 7395 §§3.4/3.6: a peer opening cannot remove the write-completion deadline", async () => {
  const peer = openingPeer();
  const xmpp = connection(peer);
  await xmpp.connect(peer.url);
  const socket = xmpp.socket;
  const original = socket.write;
  let release: (() => void) | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  socket.write = (source: string, callback: () => void) => {
    release = callback;
    // The independent features deadline must not satisfy our write deadline.
    xmpp.timeout = EVENT_TIMEOUT_MS;
    // Bytes reach the real peer, but the driver never completes our write.
    original.call(socket, source, () => {});
  };
  const received = once(xmpp, "open", {
    signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
  });
  const opening = xmpp.open(OPTIONS).catch((error: Error) => error);
  try {
    const [header] = await received;
    expect(header.attrs.id).toBe("dispatch");
    expect(release).toBeFunction();
    const result = await Promise.race([
      opening,
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve("watchdog"), SHUTDOWN_WATCHDOG_MS);
      }),
    ]);
    clearTimeout(watchdog);
    socket.write = original;
    if (result === "watchdog") {
      // A stalled mutant must settle before assertions and fixture cleanup.
      release?.();
      await opening;
    }
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ name: "TimeoutError" });
    release?.();
    await Promise.resolve();
    const forbidden = await xmpp
      .send(xml("notice", { xmlns: EXTENSION, id: "forbidden" }))
      .catch((error: Error) => error);
    expect(forbidden).toBeInstanceOf(Error);
    expect(peer.transcript).toHaveLength(1);
    expect(readFrame(peer.transcript[0])[0]).toMatchObject({
      open: `{${FRAMING}}open`,
    });
    await xmpp.stop();
    await peer.waitForClose();
  } finally {
    clearTimeout(watchdog);
    socket.write = original;
    release?.();
    await opening;
  }
});
