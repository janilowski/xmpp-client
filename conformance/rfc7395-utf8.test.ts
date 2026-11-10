import { describe, expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { RawPeer } from "./raw-peer.ts";

// Client receiver: RFC 7395 §3.2; RFC 6455 §§5.4/5.6/8.1; RFC 3629 §4.
// Native Bun WebSocket byte evidence, not browser or XML-version evidence.
const DEADLINE_MS = 2000;
const TEXT = 0x81;
const TEXT_START = 0x01;
const TEXT_END = 0x80;
const PING = new Uint8Array([0x89, 0x01, 0x3f]);
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const NOTICE = "urn:test:utf8";
const HEAD = `<notice xmlns="${NOTICE}" id="bytes">`;
const TAIL = "</notice>";
const OPEN = `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="utf8"/>`;

type Observation =
  { kind: "message"; data: unknown } | { kind: "close"; code: number };

// Settle on forbidden delivery too: accepting invalid bytes must fail directly,
// not merely leave a negative test waiting until its deadline.
function observe(socket: WebSocket) {
  return new Promise<Observation>((resolve, reject) => {
    const finish = (result: Observation) => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) =>
      finish({ kind: "message", data: event.data });
    const onClose = (event: { code: number }) =>
      finish({ kind: "close", code: event.code });
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      reject(new Error("WebSocket byte observation timed out"));
    }, DEADLINE_MS);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.onerror = () => {};
  });
}

// Fixtures are literal RFC 3629 boundary octets and independent Unicode text.
// No production encoder/decoder constructs the expected values.
const valid = [
  // U+0000 is legal UTF-8 transport data, but XML 1.0 separately rejects it.
  ["U+0000 (native transport only)", [0x00], "\u0000"],
  ["U+007F", [0x7f], "\u007f"],
  ["U+0080", [0xc2, 0x80], "\u0080"],
  ["U+07FF", [0xdf, 0xbf], "\u07ff"],
  ["U+0800", [0xe0, 0xa0, 0x80], "\u0800"],
  ["U+D7FF", [0xed, 0x9f, 0xbf], "\ud7ff"],
  ["U+E000", [0xee, 0x80, 0x80], "\ue000"],
  ["U+FFFD", [0xef, 0xbf, 0xbd], "\ufffd"],
  ["U+10000", [0xf0, 0x90, 0x80, 0x80], "\u{10000}"],
  ["U+10FFFF", [0xf4, 0x8f, 0xbf, 0xbf], "\u{10ffff}"],
] as const;

const invalid = [
  ["stray continuation", [0x80]],
  ["two-byte overlong", [0xc0, 0xaf]],
  ["three-byte overlong", [0xe0, 0x9f, 0xbf]],
  ["four-byte overlong", [0xf0, 0x8f, 0xbf, 0xbf]],
  ["high surrogate U+D800", [0xed, 0xa0, 0x80]],
  ["low surrogate U+DFFF", [0xed, 0xbf, 0xbf]],
  ["above U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
  ["forbidden leading byte", [0xf5, 0x80, 0x80, 0x80]],
  ["forbidden FE octet", [0xfe]],
  ["forbidden FF octet", [0xff]],
  ["non-continuation", [0xc3, 0x28]],
] as const;

describe("RFC 7395 §3.2 native UTF-8 message boundaries", () => {
  for (const [name, bytes, text] of valid) {
    // A message, not each fragment, must be UTF-8. Every scalar split is legal;
    // a control frame between its bytes must not reset text-decoder state.
    for (let split = 1; split <= bytes.length; split++) {
      test(`RFC 6455 §§5.4/5.6: ${name}, split ${split}, interleaved ping`, async () => {
        const first = [...Buffer.from(HEAD, "ascii"), ...bytes.slice(0, split)];
        const last = [...bytes.slice(split), ...Buffer.from(TAIL, "ascii")];
        const peer = await new RawPeer("xmpp", [
          new Uint8Array([TEXT_START, first.length, ...first]),
          PING,
          new Uint8Array([TEXT_END, last.length, ...last]),
        ]).listen();
        const socket = new WebSocket(peer.url, "xmpp");
        try {
          expect(await observe(socket)).toEqual({
            kind: "message",
            data: HEAD + text + TAIL,
          });
          expect(socket.readyState).toBe(WebSocket.OPEN);
          expect(peer.requests).toHaveLength(1);
        } finally {
          socket.close();
          await peer.stop();
        }
      });
    }
  }

  for (const [name, bytes] of invalid) {
    for (let split = 1; split <= bytes.length; split++) {
      test(`RFC 6455 §8.1: rejects ${name}, split ${split}, without replacement delivery`, async () => {
        const peer = await new RawPeer("xmpp", [
          new Uint8Array([TEXT_START, split, ...bytes.slice(0, split)]),
          PING,
          new Uint8Array([
            TEXT_END,
            bytes.length - split,
            ...bytes.slice(split),
          ]),
          // A complete later message cannot rescue a malformed earlier one.
          new Uint8Array([TEXT, 0x01, 0x41]),
        ]).listen();
        const socket = new WebSocket(peer.url, "xmpp");
        const messages: unknown[] = [];
        let opened = false;
        socket.onopen = () => {
          opened = true;
        };
        socket.addEventListener("message", (event) =>
          messages.push(event.data),
        );
        try {
          expect(await observe(socket)).toMatchObject({ kind: "close" });
          expect(opened).toBe(true);
          expect(messages).toEqual([]);
          expect(socket.readyState).toBe(WebSocket.CLOSED);
          expect(peer.requests).toHaveLength(1);
        } finally {
          socket.close();
          await peer.stop();
        }
      });
    }
  }

  for (const bytes of [[0xc2], [0xe0, 0xa0], [0xf0, 0x90, 0x80]]) {
    test(`RFC 6455 §§5.6/8.1: FIN rejects truncated ${bytes.length + 1}-byte scalar`, async () => {
      const peer = await new RawPeer("xmpp", [
        new Uint8Array([TEXT_START, bytes.length, ...bytes]),
        PING,
        new Uint8Array([TEXT_END, 0x00]),
        new Uint8Array([TEXT, 0x01, 0x41]),
      ]).listen();
      const socket = new WebSocket(peer.url, "xmpp");
      const messages: unknown[] = [];
      let opened = false;
      socket.onopen = () => {
        opened = true;
      };
      socket.addEventListener("message", (event) => messages.push(event.data));
      try {
        expect(await observe(socket)).toMatchObject({ kind: "close" });
        expect(opened).toBe(true);
        expect(messages).toEqual([]);
        expect(socket.readyState).toBe(WebSocket.CLOSED);
      } finally {
        socket.close();
        await peer.stop();
      }
    });
  }
});

test("RFC 7395 §3.2: malformed native bytes cannot enter public XML dispatch", async () => {
  const peer = await new RawPeer("xmpp").listen();
  const xmpp = client({ service: peer.url, domain: "example.test" });
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  const received: string[] = [];
  xmpp.on("nonza", (element) => received.push(element.toString()));
  xmpp.on("stanza", (element) => received.push(element.toString()));
  try {
    await xmpp.connect(peer.url);
    const opening = xmpp.open({ domain: "example.test" });
    const open = Buffer.from(OPEN, "ascii");
    peer.send(new Uint8Array([TEXT, open.length, ...open]));
    await opening;

    // Prove ordinary XML dispatch works before testing the fatal byte boundary.
    const control = Promise.withResolvers<void>();
    const controlTimer = setTimeout(
      () => control.reject(new Error("Control XML was not dispatched")),
      DEADLINE_MS,
    );
    xmpp.once("nonza", () => control.resolve());
    const source = Buffer.from(HEAD + "control" + TAIL, "ascii");
    peer.send(new Uint8Array([TEXT, source.length, ...source]));
    try {
      await control.promise;
    } finally {
      clearTimeout(controlTimer);
    }
    expect(received).toEqual([HEAD + "control" + TAIL]);
    received.length = 0;

    const outcome = Promise.withResolvers<string>();
    const timer = setTimeout(
      () => outcome.reject(new Error("Native rejection did not settle XMPP")),
      DEADLINE_MS,
    );
    xmpp.once("disconnect", () => outcome.resolve("disconnect"));
    xmpp.once("nonza", () => outcome.resolve("nonza"));
    xmpp.once("stanza", () => outcome.resolve("stanza"));
    try {
      const first = [...Buffer.from(HEAD, "ascii"), 0xed];
      const last = [0xa0, 0x80, ...Buffer.from(TAIL, "ascii")];
      peer.send(
        new Uint8Array([TEXT_START, first.length, ...first]),
        PING,
        new Uint8Array([TEXT_END, last.length, ...last]),
        new Uint8Array([TEXT, source.length, ...source]),
      );
      expect(await outcome.promise).toBe("disconnect");
      expect(received).toEqual([]);
      expect(xmpp.status).toBe("disconnect");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await peer.stop();
    await xmpp.stop();
  }
});
