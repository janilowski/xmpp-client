import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const AUTH = `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`;
const BINDING = `<bind xmlns="${BIND}"/>`;
const OPTIONAL = '<future xmlns="urn:test:optional"/>';
const WATCHDOG_MS = 500;
const FEATURE_TIMEOUT_MS = 100;

function negotiationPeer(
  before: string | null,
  after: string | null,
  closing: "reply" | "silent" = "reply",
) {
  let authenticated = false;
  return new ScriptedPeer((frame, peer) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="${authenticated ? "second" : "first"}"/>`,
      );
      const offer = authenticated ? after : before;
      if (offer !== null) {
        peer.send(`<features xmlns="${STREAM}">${offer}</features>`);
      }
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      peer.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === "{jabber:client}iq") {
      peer.send(
        `<iq xmlns="jabber:client" id="${root.attributes["{}id"]}" type="result"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
      peer.send(`<features xmlns="${STREAM}"/>`);
    } else if (root.open === `{${SM}}enable`) {
      peer.send(`<enabled xmlns="${SM}"/>`);
    } else if (root.open === `{${SM}}resume`) {
      peer.send(
        `<failed xmlns="${SM}"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></failed>`,
      );
    } else if (root.open === `{${FRAMING}}close` && closing === "reply") {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

test.each([BINDING, BINDING + `<sm xmlns="${SM}"/>`])(
  "RFC 6120 §§4.3.5/4.4: completion features cannot poison immediate stop / %s",
  async (features) => {
    const peer = negotiationPeer(AUTH, features);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      await xmpp.start();
      await xmpp.stop();
      expect(errors).toEqual([]);
      expect(xmpp.status).toBe("offline");
    } finally {
      await peer.stop();
    }
  },
);

test.each(["before", "after"])(
  "RFC 6120 §§4.3.2–4.3.5/7: optional features %s mandatory features",
  async (order) => {
    const offer = (required: string) =>
      order === "before" ? OPTIONAL + required : required + OPTIONAL;
    const peer = negotiationPeer(offer(AUTH), offer(BINDING));
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    const online: string[] = [];
    xmpp.on("online", (address: { toString(): string }) =>
      online.push(address.toString()),
    );
    try {
      expect((await xmpp.start()).toString()).toBe("user@example.test/r");
      expect(online).toEqual(["user@example.test/r"]);
      expect(peer.requests).toHaveLength(1);
      expect(
        peer.transcript
          .map((frame) => readFrame(frame)[0])
          .map((root) => ("open" in root ? root.open : "")),
      ).toEqual([
        `{${FRAMING}}open`,
        `{${SASL}}auth`,
        `{${FRAMING}}open`,
        "{jabber:client}iq",
      ]);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each(["enable", "failed resumption"])(
  "RFC 6120 §7 / XEP-0198 §3: bind before SM / %s",
  async (mode) => {
    const peer = negotiationPeer(AUTH, BINDING + `<sm xmlns="${SM}"/>`);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    if (mode === "failed resumption") {
      xmpp.streamManagement.id = "previous-session";
    }
    try {
      expect((await xmpp.start()).toString()).toBe("user@example.test/r");
      const frames = [];
      // next() has its own watchdog. Read the actual outbound enable, not a timer.
      while (true) {
        const frame = await peer.next();
        const root = readFrame(frame)[0];
        frames.push("open" in root ? root.open : "");
        if (frames.at(-1) === `{${SM}}enable`) {
          break;
        }
      }
      expect(frames).toEqual([
        `{${FRAMING}}open`,
        `{${SASL}}auth`,
        `{${FRAMING}}open`,
        ...(mode === "failed resumption" ? [`{${SM}}resume`] : []),
        "{jabber:client}iq",
        `{${SM}}enable`,
      ]);
      expect(xmpp.status).toBe("online");
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each(["online", "stop", "silent stop", "peer close", "stream error"])(
  "RFC 6120 §§4.3–4.4: clear features deadline / %s",
  async (outcome) => {
    const peer = negotiationPeer(
      outcome === "online" ? AUTH : null,
      BINDING,
      outcome === "silent stop" ? "silent" : "reply",
    );
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: FEATURE_TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    const opened = new Promise<void>((resolve) =>
      xmpp.once("open", () => resolve()),
    );
    const started = xmpp.start().catch((error: Error) => error);
    try {
      await opened;
      if (outcome === "stop" || outcome === "silent stop") {
        await xmpp.stop();
      } else if (outcome === "peer close") {
        peer.send(`<close xmlns="${FRAMING}"/>`);
      } else if (outcome === "stream error") {
        peer.send(
          `<error xmlns="${STREAM}"><policy-violation xmlns="${ERRORS}"/></error>`,
        );
      }
      const result = await started;
      if (outcome === "online") {
        expect(result.toString()).toBe("user@example.test/r");
      } else {
        expect(result).toBeInstanceOf(Error);
        await peer.waitForClose();
      }
      await new Promise((resolve) =>
        setTimeout(resolve, FEATURE_TIMEOUT_MS * 2),
      );
      expect(errors.map((error) => error.name)).toEqual(
        outcome === "stream error" ? ["StreamError"] : [],
      );
      expect(xmpp.status).toBe(
        outcome === "online"
          ? "online"
          : outcome === "stop" || outcome === "silent stop"
            ? "offline"
            : "disconnect",
      );
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §4.4: abandoned features wait cannot close a replacement session", async () => {
  const abandoned = negotiationPeer(null, BINDING);
  const replacement = negotiationPeer(AUTH, BINDING);
  const xmpp = client({
    service: abandoned.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: FEATURE_TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  const opened = new Promise<void>((resolve) =>
    xmpp.once("open", () => resolve()),
  );
  const started = xmpp.start().catch((error: Error) => error);
  try {
    await opened;
    await xmpp.stop();
    expect(await started).toBeInstanceOf(Error);
    xmpp.options = { ...xmpp.options, service: replacement.url };
    expect((await xmpp.start()).toString()).toBe("user@example.test/r");
    await new Promise((resolve) => setTimeout(resolve, FEATURE_TIMEOUT_MS * 2));
    expect(xmpp.status).toBe("online");
    expect(errors).toEqual([]);
    expect(abandoned.errors).toEqual([]);
    expect(replacement.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await started;
    await abandoned.stop();
    await replacement.stop();
  }
});

test.each([
  ["empty before authentication", "", BINDING],
  ["unknown before authentication", OPTIONAL, BINDING],
  [
    "unknown required convention",
    '<future xmlns="urn:test:future"><required/></future>',
    BINDING,
  ],
  ["empty before binding", AUTH, ""],
  ["unknown before binding", AUTH, OPTIONAL],
  ["SM before authentication (XEP-0198 §3)", `<sm xmlns="${SM}"/>`, BINDING],
  ["SM without binding (XEP-0198 §3)", AUTH, `<sm xmlns="${SM}"/>`],
  ["stream namespace child", AUTH + "<future/>", BINDING],
  [
    "content namespace child",
    AUTH + '<future xmlns="jabber:client"/>',
    BINDING,
  ],
] as const)(
  "RFC 6120 §§4.3.2/7: fail incomplete negotiation / %s",
  async (_name, before, after) => {
    const peer = negotiationPeer(before, after);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    let online = 0;
    xmpp.on("online", () => online++);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = xmpp.start().catch((error: Error) => error);
    try {
      const result = await Promise.race([
        started,
        new Promise<Error>((resolve) => {
          timer = setTimeout(
            () => resolve(new Error("test watchdog: negotiation stalled")),
            WATCHDOG_MS,
          );
        }),
      ]);
      expect(peer.transcript.some((frame) => frame.startsWith("<enable"))).toBe(
        false,
      );
      // A watchdog is only a test guard: timeout alone never proves rejection.
      expect(result.message).toMatch(
        /^(Unsupported stream features|Invalid stream feature namespace|Stream Management requires resource binding)$/,
      );
      expect(online).toBe(0);
      await peer.waitForClose();
      expect(peer.transcript.at(-1)).toBe(`<close xmlns="${FRAMING}"/>`);
      expect(peer.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
        false,
      );
      expect(errors).toHaveLength(1);
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
  ["start", "initial", null, BINDING],
  ["start", "SASL restart", AUTH, null],
  ["reconnect", "initial", null, BINDING],
  ["reconnect", "SASL restart", AUTH, null],
] as const)(
  "RFC 6120 §4.3: local features deadline / %s / %s",
  async (entry, _stage, before, after) => {
    const peer = negotiationPeer(before, after);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: FEATURE_TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    const failure = Promise.withResolvers<Error>();
    xmpp.on("error", (error: Error) => {
      errors.push(error);
      failure.resolve(error);
    });
    let online = 0;
    xmpp.on("online", () => online++);
    const started = (
      entry === "start" ? xmpp.start() : xmpp.reconnect.reconnect()
    ).catch((error: Error) => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        failure.promise,
        new Promise<Error>((resolve) => {
          timer = setTimeout(
            () => resolve(new Error("test watchdog")),
            WATCHDOG_MS,
          );
        }),
      ]);
      expect(result.name).toBe("TimeoutError");
      expect(result.message).toBe("Timed out waiting for stream features");
      if (entry === "start") {
        expect(await started).toBe(result);
      }
      await peer.waitForClose();
      expect(online).toBe(0);
      expect(errors).toEqual([result]);
      expect(peer.transcript.at(-1)).toBe(`<close xmlns="${FRAMING}"/>`);
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<open")),
      ).toHaveLength(before === null ? 1 : 2);
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
  ["normal", `<policy-violation xmlns="${ERRORS}"/>`, "policy-violation"],
  ["unknown", `<future-condition xmlns="${ERRORS}"/>`, "undefined-condition"],
  [
    "wrong namespace",
    '<policy-violation xmlns="urn:test:application"/>',
    "undefined-condition",
  ],
  ["missing condition", "", "undefined-condition"],
] as const)(
  "RFC 6120 §§4.9.1–4.9.2: stream error closes without a loop / %s",
  async (_name, condition, expected) => {
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open")) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" id="failure" version="1.0"/>`,
        );
        remote.send(
          `<error xmlns="${STREAM}"><text xmlns="${ERRORS}" xml:lang="en">Diagnostic</text>${condition}<detail xmlns="urn:test:detail"/></error>`,
        );
      } else if (frame.startsWith("<close")) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
    const xmpp = client({ service: peer.url, domain: "example.test" });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      const result = await xmpp.start().catch((error: Error) => error);
      expect(result.name).toBe("StreamError");
      expect(result.condition).toBe(expected);
      expect(result.text).toBe("Diagnostic");
      await peer.waitForClose();
      expect(peer.transcript).toHaveLength(2);
      expect(peer.transcript[1]).toBe(`<close xmlns="${FRAMING}"/>`);
      expect(errors).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
