import { expect, spyOn, test } from "bun:test";
import { serve, type ServerWebSocket } from "bun";
import { once } from "node:events";
import { client, xml } from "../src/client/index.js";
import { waitForDisconnect } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const CONTENT = "jabber:client";
const PING = "urn:xmpp:ping";
const ACCOUNT = "user@example.test/r";
const HTTP_BAD_REQUEST = 400;
const TIMEOUT_MS = 1000;
const RETRY_BASE_MS = 1379;
const RETRY_RANDOM = 0.5;
const RETRY_DELAYS = [1034.25, 2068.5, 4137];
const PARKED_TIMER_MS = 60_000;

type Session = { attempt: number; authenticated: boolean; frames: string[] };
type Retry = {
  delay: number;
  timer: ReturnType<typeof setTimeout>;
  run(): Promise<void>;
};

// RFC 6120 §3.3, initiating client: choosing to reconnect brings SHOULDs for
// randomized initial delay and increasing backoff. The exact windows/reset are
// local policy, not RFC durations. Only scheduler timers/random are controlled;
// WebSocket establishment, failed openings, SASL and binding remain real.
// Loopback WS does not test TLS-session resumption or endpoint identity.
test("RFC 6120 §3.3: real failed openings back off, recover and cancel stale retries", async () => {
  const sessions: Session[] = [];
  const sockets = new Set<ServerWebSocket<Session>>();
  const peerErrors: Error[] = [];
  const server = serve<Session>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const session = {
        attempt: sessions.length,
        authenticated: false,
        frames: [],
      };
      sessions.push(session);
      if (
        server.upgrade(request, {
          data: session,
          headers: { "Sec-WebSocket-Protocol": "xmpp" },
        })
      ) {
        return;
      }
      return new Response("Expected WebSocket upgrade", {
        status: HTTP_BAD_REQUEST,
      });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(socket, data) {
        try {
          if (typeof data !== "string") {
            throw new Error("Expected a text WebSocket frame");
          }
          const { attempt, authenticated, frames } = socket.data;
          frames.push(data);
          const events = readFrame(data);
          const root = events[0];
          if (!root || !("open" in root)) {
            throw new Error("Expected a client element");
          }
          if (root.open === `{${FRAMING}}open`) {
            if (attempt === 1 || attempt === 2) {
              socket.terminate();
              return;
            }
            socket.send(
              `<open xmlns="${FRAMING}" from="example.test" id="retry-${attempt}" version="1.0"/>`,
            );
            socket.send(
              `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
            );
          } else if (root.open === `{${SASL}}auth`) {
            socket.data.authenticated = true;
            socket.send(`<success xmlns="${SASL}"/>`);
          } else if (
            root.open === `{${CONTENT}}iq` &&
            events.some(
              (event) => "open" in event && event.open === `{${BIND}}bind`,
            )
          ) {
            socket.send(
              `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${ACCOUNT}</jid></bind></iq>`,
            );
          } else if (
            root.open === `{${CONTENT}}iq` &&
            root.attributes["{}id"] === "recovered"
          ) {
            socket.send(
              `<iq xmlns="${CONTENT}" type="result" id="recovered"/>`,
            );
          } else if (root.open === `{${FRAMING}}close`) {
            socket.send(`<close xmlns="${FRAMING}"/>`);
          } else {
            throw new Error(`Unexpected client frame: ${data}`);
          }
        } catch (error) {
          peerErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          );
          socket.terminate();
        }
      },
    },
  });
  const xmpp = client({
    service: `ws://127.0.0.1:${server.port}/xmpp`,
    domain: "example.test",
    username: "user",
    password: "secret",
    resource: "r",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.delay = RETRY_BASE_MS;
  const errors: Error[] = [];
  const online: string[] = [];
  let reconnecting = 0;
  let reconnected = 0;
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("online", (address) => online.push(String(address)));
  xmpp.reconnect.on("reconnecting", () => reconnecting++);
  xmpp.reconnect.on("reconnected", () => reconnected++);

  const retries: Retry[] = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign((...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...parameters] = args;
      if (typeof callback !== "function" || !RETRY_DELAYS.includes(delay!)) {
        return nativeSetTimeout(...args);
      }

      // A parked native handle retains ordinary cancellation semantics. All
      // operation deadlines and wire events use their unchanged native timers.
      const timer = nativeSetTimeout(() => {}, PARKED_TIMER_MS);
      retries.push({
        delay: delay!,
        timer,
        async run() {
          nativeClearTimeout(timer);
          await callback(...parameters);
        },
      });
      return timer;
    }, nativeSetTimeout),
  );
  const clearSpy = spyOn(globalThis, "clearTimeout");
  const randomSpy = spyOn(Math, "random");

  try {
    expect(String(await xmpp.start())).toBe(ACCOUNT);
    expect(sessions).toHaveLength(1);
    expect(online).toEqual([ACCOUNT]);

    // Each next random value belongs to scheduling, before any binding IQ can
    // request an ID. Other randomness, including successful binding, stays real.
    randomSpy.mockReturnValueOnce(RETRY_RANDOM);
    for (const socket of sockets) {
      socket.terminate();
    }
    expect(await waitForDisconnect(xmpp, TIMEOUT_MS)).toBe(true);
    expect(retries).toHaveLength(1);

    for (const attempt of [0, 1]) {
      expect(retries[attempt].delay).toBe(RETRY_DELAYS[attempt]);
      randomSpy.mockReturnValueOnce(RETRY_RANDOM);
      await retries[attempt].run();
      expect(sessions).toHaveLength(attempt + 2);
      expect(retries).toHaveLength(attempt + 2);
      expect(xmpp.status).toBe("disconnect");
      expect(online).toEqual([ACCOUNT]);
      expect(reconnected).toBe(0);
    }
    for (const session of sessions.slice(1)) {
      expect(session.frames).toHaveLength(1);
      expect(readFrame(session.frames[0])).toMatchObject([
        {
          open: `{${FRAMING}}open`,
          attributes: { "{}to": "example.test", "{}version": "1.0" },
        },
        { close: `{${FRAMING}}open` },
      ]);
      expect(session.authenticated).toBe(false);
    }

    expect(retries[2].delay).toBe(RETRY_DELAYS[2]);
    const recovered = once(xmpp, "online", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await retries[2].run();
    expect(String((await recovered)[0])).toBe(ACCOUNT);
    const response = await xmpp.iqCaller.request(
      xml("iq", { type: "get", id: "recovered" }, xml("ping", PING)),
      TIMEOUT_MS,
    );
    expect(response.attrs.type).toBe("result");
    expect(sessions).toHaveLength(4);
    expect(sessions[3].authenticated).toBe(true);
    expect(
      sessions[3].frames.map((frame) => readFrame(frame)[0]),
    ).toMatchObject([
      { open: `{${FRAMING}}open` },
      { open: `{${SASL}}auth`, attributes: { "{}mechanism": "PLAIN" } },
      { open: `{${FRAMING}}open` },
      { open: `{${CONTENT}}iq`, attributes: { "{}type": "set" } },
      { open: `{${CONTENT}}iq`, attributes: { "{}id": "recovered" } },
    ]);
    expect(online).toEqual([ACCOUNT, ACCOUNT]);
    expect(reconnecting).toBe(3);
    expect(reconnected).toBe(1);
    expect(retries).toHaveLength(3);

    randomSpy.mockReturnValueOnce(RETRY_RANDOM);
    for (const socket of sockets) {
      socket.terminate();
    }
    expect(await waitForDisconnect(xmpp, TIMEOUT_MS)).toBe(true);
    expect(retries).toHaveLength(4);
    expect(retries[3].delay).toBe(RETRY_DELAYS[0]);
    xmpp.reconnect.stop();
    expect(clearSpy).toHaveBeenCalledWith(retries[3].timer);

    // Even an already-queued callback cannot enter a later enabled generation.
    xmpp.reconnect.start();
    await retries[3].run();
    expect(sessions).toHaveLength(4);
    expect(reconnecting).toBe(3);
    expect(reconnected).toBe(1);
    expect(retries).toHaveLength(4);
    expect(errors).toEqual([]);
    expect(peerErrors).toEqual([]);
  } finally {
    xmpp.reconnect.stop();
    for (const retry of retries) {
      nativeClearTimeout(retry.timer);
    }
    timerSpy.mockRestore();
    clearSpy.mockRestore();
    randomSpy.mockRestore();
    try {
      await xmpp.stop();
    } finally {
      await server.stop(true);
    }
  }
});
