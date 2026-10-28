import { expect, test } from "bun:test";
import { once } from "node:events";
import { client } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const OPTIONS = { domain: "example.test", lang: "pl" };
const EVENT_TIMEOUT_MS = 2000;
const MAX_REDIRECTS = 5;
const CROSS_HOST_REDIRECT_MESSAGE =
  "Cross-host stream redirects are not supported";

function target(peer: ScriptedPeer) {
  return new URL(peer.url).host;
}

function redirectPeer(targetHost: string) {
  return new ScriptedPeer((frame, peer) => {
    const [root] = readFrame(frame);
    if ("open" in root && root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="redirect"/>`,
      );
      peer.send(
        `<stream:error xmlns:stream="${STREAM}"><see-other-host xmlns="${STREAM_ERRORS}">${targetHost}</see-other-host></stream:error>`,
      );
    } else if ("open" in root && root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

function onlinePeer(index: number) {
  let authenticated = false;
  return new ScriptedPeer((frame, peer) => {
    const [root] = readFrame(frame);
    if ("open" in root && root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="online-${index}"/>`,
      );
      peer.send(
        authenticated
          ? `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/></features>`
          : `<features xmlns="${STREAM}"><mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms></features>`,
      );
    } else if ("open" in root && root.open === `{${SASL}}auth`) {
      authenticated = true;
      peer.send(`<success xmlns="${SASL}"/>`);
    } else if ("open" in root && root.open === "{jabber:client}iq") {
      peer.send(
        `<iq xmlns="jabber:client" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r${index}</jid></bind></iq>`,
      );
    } else if ("open" in root && root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

// RFC 6120 §4.9.3.19 retains the original service reference identity.
// Browser policy: reject another URL host before contacting it, even if it
// resolves to the same address; explicit caller-selected connections still work.
test.each([
  ["IP to name", "127.0.0.1", "localhost", "original"],
  ["name to IP", "localhost", "127.0.0.1", "original"],
  [
    "actual socket overrides configured target",
    "127.0.0.1",
    "localhost",
    "target",
  ],
] as const)(
  "RFC 6120 §4.9.3.19 / browser policy: cross-host redirect makes no contact / %s",
  async (_label, sourceHost, destinationHost, configuration) => {
    const destination = onlinePeer(99);
    const destinationUrl = new URL(destination.url);
    destinationUrl.hostname = destinationHost;
    const source = redirectPeer(destinationUrl.host);
    const sourceUrl = new URL(source.url);
    sourceUrl.hostname = sourceHost;
    const service = sourceUrl.toString();
    const xmpp = client({
      ...OPTIONS,
      service,
      username: "user",
      password: "secret",
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    const observed = once(xmpp, "error", {
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    try {
      await xmpp.connect(service);
      if (configuration === "target") {
        Object.assign(xmpp.options, { service: destinationUrl.toString() });
      }
      await xmpp.open(OPTIONS);
      const result = await Promise.race([
        observed.then(([error]) => error),
        destination.next().then(() => "contacted"),
      ]);
      // A permissive destination accepts the old unsafe path: RED is an assertion.
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe(CROSS_HOST_REDIRECT_MESSAGE);
      await source.waitForClose();
      expect(destination.requests).toEqual([]);
      expect(destination.transcript).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(xmpp.options).toMatchObject({
        domain: OPTIONS.domain,
        lang: OPTIONS.lang,
        service:
          configuration === "target" ? destinationUrl.toString() : service,
      });

      await xmpp.stop();
      Object.assign(xmpp.options, { service: destinationUrl.toString() });
      expect((await xmpp.start()).toString()).toBe("user@example.test/r99");
      const openings = destination.transcript.filter((frame) =>
        frame.startsWith("<open"),
      );
      expect(openings).toHaveLength(2);
      for (const opening of openings) {
        expect(readFrame(opening)[0]).toMatchObject({
          attributes: {
            "{}to": OPTIONS.domain,
            "{http://www.w3.org/XML/1998/namespace}lang": OPTIONS.lang,
          },
        });
      }
      expect(source.errors).toEqual([]);
      expect(destination.errors).toEqual([]);
    } finally {
      await xmpp.stop().catch(() => {});
      await source.stop();
      await destination.stop();
    }
  },
);

test("RFC 6120 §4.9.3.19: same-host redirect preserves WebSocket policy and stream identity", async () => {
  const destination = new ScriptedPeer((frame, peer) => {
    const [root] = readFrame(frame);
    if ("open" in root && root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="destination"/>`,
      );
    } else if ("open" in root && root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const source = redirectPeer(target(destination));
  const xmpp = client({ ...OPTIONS, service: source.url });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    await xmpp.connect(source.url);
    await xmpp.open(OPTIONS);
    const frame = await destination.next();
    expect(readFrame(frame)[0]).toMatchObject({
      attributes: {
        "{}to": OPTIONS.domain,
        "{http://www.w3.org/XML/1998/namespace}lang": OPTIONS.lang,
      },
      open: `{${FRAMING}}open`,
    });
    expect(new URL(destination.requestUrls[0]).pathname).toBe("/xmpp");
    expect(errors).toEqual([]);
  } finally {
    await xmpp.stop().catch(() => {});
    await source.stop();
    await destination.stop();
  }
});

test("RFC 6120 §4.9.3.19 / RFC 7622 §3.2: prepared same-host redirect preserves the WebSocket path", async () => {
  const destination = new ScriptedPeer((frame, peer) => {
    const [root] = readFrame(frame);
    if ("open" in root && root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="destination"/>`,
      );
    } else if ("open" in root && root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const port = new URL(destination.url).port;
  const source = redirectPeer(`LOCALHOST.:${port}`);
  const service = source.url.replace("127.0.0.1", "localhost");
  const xmpp = client({ ...OPTIONS, service });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  const failed = Promise.withResolvers<Error>();
  xmpp.on("error", (error: Error) => {
    errors.push(error);
    failed.resolve(error);
  });
  try {
    await xmpp.connect(service);
    await xmpp.open(OPTIONS);
    const frame = await Promise.race([destination.next(), failed.promise]);
    expect(typeof frame).toBe("string");
    expect(readFrame(frame as string)[0]).toMatchObject({
      attributes: {
        "{}to": OPTIONS.domain,
        "{http://www.w3.org/XML/1998/namespace}lang": OPTIONS.lang,
      },
      open: `{${FRAMING}}open`,
    });
    expect(new URL(destination.requestUrls[0]).pathname).toBe("/xmpp");
    expect(errors).toEqual([]);
  } finally {
    await xmpp.stop().catch(() => {});
    await source.stop();
    await destination.stop();
  }
});

const INVALID_TARGETS: [string, (host: string) => string][] = [
  ["empty target", () => ""],
  ["URI scheme", (host) => `ws://${host}/xmpp`],
  ["userinfo", (host) => `user@${host}`],
  ["path", (host) => `${host}/not-a-domainpart`],
  ["query", (host) => `${host}?route=other`],
  ["fragment", (host) => `${host}#other`],
  ["nonnumeric port", () => "example.test:xmpp"],
  ["out-of-range port", () => "example.test:65536"],
  ["unbracketed IPv6", () => "2001:db8::1"],
  ["domainpart", () => "exa_mple.test"],
];

test.each(INVALID_TARGETS)(
  "RFC 6120 §4.9.3.19: invalid %s causes no network contact",
  async (_name, makeTarget) => {
    const destination = new ScriptedPeer((frame, peer) => {
      const [root] = readFrame(frame);
      if ("open" in root && root.open === `{${FRAMING}}close`) {
        peer.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
    const source = redirectPeer(makeTarget(target(destination)));
    const xmpp = client({ ...OPTIONS, service: source.url });
    xmpp.reconnect.stop();
    const error = once(xmpp, "error", {
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    try {
      await xmpp.connect(source.url);
      await xmpp.open(OPTIONS);
      const result = await Promise.race([
        error.then(([observed]) => observed),
        destination.next().then(() => "contacted"),
      ]);
      expect(result).toBeInstanceOf(TypeError);
      expect((result as Error).message).toBe("Invalid see-other-host target");
      expect(destination.requests).toHaveLength(0);
    } finally {
      await xmpp.stop().catch(() => {});
      await source.stop();
      await destination.stop();
    }
  },
);

test("RFC 6120 §4.9.3.19: aborts after five successive redirects", async () => {
  const terminal = new ScriptedPeer((frame, peer) => {
    const [root] = readFrame(frame);
    if ("open" in root && root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const peers: ScriptedPeer[] = [terminal];
  for (let index = 0; index <= MAX_REDIRECTS; index += 1) {
    peers.unshift(redirectPeer(target(peers[0])));
  }
  const source = peers[0];
  const xmpp = client({ ...OPTIONS, service: source.url });
  xmpp.reconnect.stop();
  const error = once(xmpp, "error", {
    signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
  });
  try {
    await xmpp.connect(source.url);
    await xmpp.open(OPTIONS);
    const result = await Promise.race([
      error.then(([observed]) => observed),
      terminal.next().then(() => "contacted"),
    ]);
    expect(result).toBeInstanceOf(Error);
    const observed = result as Error;
    expect(observed).toBeInstanceOf(Error);
    expect(observed.message).toContain("redirect");
    expect(terminal.requests).toHaveLength(0);
    expect(
      peers.slice(0, MAX_REDIRECTS + 1).map((peer) => peer.requests.length),
    ).toEqual(Array(MAX_REDIRECTS + 1).fill(1));
  } finally {
    await xmpp.stop().catch(() => {});
    await Promise.all(peers.map((peer) => peer.stop()));
  }
});

test("RFC 6120 §4.9.3.19: successful negotiation ends a redirect sequence", async () => {
  const peers = Array.from({ length: MAX_REDIRECTS + 2 }, (_value, index) =>
    onlinePeer(index),
  );
  const xmpp = client({
    ...OPTIONS,
    service: peers[0].url,
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  const unexpected = Promise.withResolvers<Error>();
  xmpp.on("error", unexpected.resolve);
  try {
    expect((await xmpp.start()).toString()).toBe("user@example.test/r0");
    for (let index = 1; index < peers.length; index += 1) {
      const online = once(xmpp, "online", {
        signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
      });
      peers[index - 1].send(
        `<stream:error xmlns:stream="${STREAM}"><see-other-host xmlns="${STREAM_ERRORS}">${target(peers[index])}</see-other-host></stream:error>`,
      );
      const result = await Promise.race([
        online.then(([address]) => address.toString()),
        unexpected.promise,
      ]);
      expect(result).toBe(`user@example.test/r${index}`);
    }
    expect(peers.map((peer) => peer.requests.length)).toEqual(
      Array(peers.length).fill(1),
    );
  } finally {
    await xmpp.stop().catch(() => {});
    await Promise.all(peers.map((peer) => peer.stop()));
  }
});
