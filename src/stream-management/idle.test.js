import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { mockClient } from "../../test/support/index.js";
import { disconnectClients } from "../../test/support/mockClient.js";
import { tick } from "../events/index.js";
import xml from "../xml/index.js";

const SM = "urn:xmpp:sm:3";
const STREAM = "http://etherx.jabber.org/streams";
// Independent RFC 6120 §4.6.4 recommendation; this is our default policy.
const IDLE_INTERVAL_MS = 300_000;
const ACK_DEBOUNCE_MS = 250;
const RESPONSE_TIMEOUT_MS = 60_000;

describe("RFC 6120 §4.6.4 / XEP-0198 §4 — idle checks", () => {
  afterEach(async () => {
    try {
      await disconnectClients();
    } finally {
      jest.restoreAllMocks();
    }
  });

  // Capture only this fixture's timers, restoring globals even after failure.
  async function session(interval) {
    const { entity } = mockClient();
    entity.reconnect.stop();
    entity.status = "online";
    entity.streamFeatures.authenticated = true;
    const sm = entity.streamManagement;
    if (interval !== undefined) {
      sm.requestAckInterval = interval;
    }
    let now = 0;
    const timers = [];
    const sent = [];
    spyOn(globalThis, "setTimeout").mockImplementation((callback, delay) => {
      const timer = { callback, delay, due: now + delay, cancelled: false };
      timers.push(timer);
      return timer;
    });
    spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      if (timer) {
        timer.cancelled = true;
      }
    });
    entity.on("send", (element) => sent.push(element.toString()));
    const enabling = entity.catchOutgoing();
    entity.mockInput(
      xml("features", { xmlns: STREAM }, xml("sm", { xmlns: SM })),
    );
    expect((await enabling).is("enable", SM)).toBe(true);
    entity.mockInput(xml("enabled", { xmlns: SM }));
    await tick();
    expect(sm.enabled).toBe(true);
    sent.length = 0;

    async function advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const timer = timers
          .filter((entry) => !entry.cancelled && entry.due <= end)
          .sort((left, right) => left.due - right.due)[0];
        if (!timer) {
          break;
        }
        now = timer.due;
        timer.cancelled = true;
        timer.callback();
        await tick();
      }
      now = end;
    }
    return { entity, sm, timers, sent, advance };
  }

  test("default idle probe waits five minutes after enabling", async () => {
    const { sm, timers, sent, advance } = await session();
    expect(sm.requestAckInterval).toBe(IDLE_INTERVAL_MS);
    expect(
      timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay),
    ).toEqual([IDLE_INTERVAL_MS]);
    await advance(IDLE_INTERVAL_MS - 1);
    expect(sent).toEqual([]);
    await advance(1);
    expect(sent).toEqual([`<r xmlns="${SM}"/>`]);
    expect(
      timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay),
    ).toEqual([RESPONSE_TIMEOUT_MS, IDLE_INTERVAL_MS]);
  });

  test("incoming traffic resets idle checking without an extra probe", async () => {
    const { entity, sent, advance } = await session();
    await advance(IDLE_INTERVAL_MS - 1);
    entity.mockInput(xml("message", { id: "incoming" }));
    await tick();
    await advance(1);
    expect(sent).toEqual([]);
    await advance(IDLE_INTERVAL_MS - 1);
    expect(sent).toEqual([`<r xmlns="${SM}"/>`]);
  });

  test("delivery ACK debounce stays fast; response restores idle checking", async () => {
    const { entity, sm, timers, sent, advance } = await session();
    expect(sm.requestAckDebounce).toBe(ACK_DEBOUNCE_MS);
    expect(sm.timeout).toBe(RESPONSE_TIMEOUT_MS);
    await entity.send(xml("message", { id: "outgoing" }));
    expect(sent).toHaveLength(1);
    await advance(ACK_DEBOUNCE_MS - 1);
    expect(sent).toHaveLength(1);
    await advance(1);
    expect(sent.at(-1)).toBe(`<r xmlns="${SM}"/>`);
    entity.mockInput(xml("a", { xmlns: SM, h: "1" }));
    await tick();
    expect(sm.outbound_q).toHaveLength(0);
    expect(
      timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay),
    ).toEqual([IDLE_INTERVAL_MS]);
    await advance(IDLE_INTERVAL_MS - 1);
    expect(sent).toHaveLength(2);
    await advance(1);
    expect(sent).toHaveLength(3);
  });

  test.each(["idle", "waiting for response"])(
    "disconnect cancels all checks / %s",
    async (phase) => {
      const { entity, timers, sent, advance } = await session();
      if (phase === "waiting for response") {
        await advance(IDLE_INTERVAL_MS);
      }
      const before = [...sent];
      entity.emit("disconnect");
      expect(timers.filter((timer) => !timer.cancelled)).toEqual([]);
      await advance(IDLE_INTERVAL_MS + RESPONSE_TIMEOUT_MS);
      expect(sent).toEqual(before);
    },
  );

  test("a silent probe keeps the existing response deadline", async () => {
    const { entity, advance } = await session();
    const disconnect = spyOn(entity, "disconnect").mockResolvedValue();
    await advance(IDLE_INTERVAL_MS);
    await advance(RESPONSE_TIMEOUT_MS - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test("explicit shorter interval remains a deployment override", async () => {
    const interval = 400;
    const { sent, advance } = await session(interval);
    await advance(interval - 1);
    expect(sent).toEqual([]);
    await advance(1);
    expect(sent).toEqual([`<r xmlns="${SM}"/>`]);
  });

  test("zero interval disables periodic idle probes", async () => {
    const { entity, sent, timers, advance } = await session(0);
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([]);
    await advance(IDLE_INTERVAL_MS * 2);
    expect(sent).toEqual([]);
    await entity.send(xml("message", { id: "outgoing" }));
    await advance(ACK_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
    expect(sent.at(-1)).toBe(`<r xmlns="${SM}"/>`);
  });
});
