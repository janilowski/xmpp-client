import Connection from "../connection/index.js";

import _reconnect from "./index.js";
import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";

test("schedules a reconnect when disconnect is emitted", () => {
  const entity = new Connection();
  const reconnect = _reconnect({ entity });
  const spy_scheduleReconnect = jest.spyOn(reconnect, "scheduleReconnect");

  expect(spy_scheduleReconnect).toHaveBeenCalledTimes(0);
  entity.emit("disconnect");
  expect(spy_scheduleReconnect).toHaveBeenCalledTimes(1);
  reconnect.stop();
});

test("#reconnect", async () => {
  const service = "service";
  const lang = "lang";
  const domain = "domain";

  const entity = new Connection({
    service,
    lang,
    domain,
  });
  const reconnect = _reconnect({ entity });

  const spy_connect = jest.spyOn(entity, "connect").mockResolvedValue();
  const spy_open = jest.spyOn(entity, "open").mockResolvedValue();

  await reconnect.reconnect();

  expect(spy_connect).toHaveBeenCalledWith(service);
  expect(spy_open).toHaveBeenCalledWith({
    domain,
    lang,
  });
  reconnect.stop();
});

// RFC 6120 §3.3: retry jitter/backoff. Bounds and reset policy are local.
describe("RFC 6120 §3.3 reconnect policy", () => {
  afterEach(() => jest.restoreAllMocks());

  function fixture(random = 0.5) {
    const timers = [];
    spyOn(Math, "random").mockReturnValue(random);
    spyOn(globalThis, "setTimeout").mockImplementation((callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    });
    spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      if (timer) {
        timer.cancelled = true;
      }
    });
    const entity = new Connection({ service: "ws://example.test" });
    entity.status = "disconnect";
    const connect = spyOn(entity, "connect").mockImplementation(async () => {
      entity.status = "connect";
    });
    const open = spyOn(entity, "open").mockResolvedValue();
    const reconnect = _reconnect({ entity });
    return { entity, reconnect, timers, connect, open };
  }

  test.each([0, 0.5, 0.999])("randomizes the initial delay / %s", (random) => {
    const { entity, reconnect, timers } = fixture(random);
    entity.emit("disconnect");
    expect(timers[0].delay).toBe(500 + 500 * random);
    reconnect.stop();
  });

  test("grows to a cap; only online resets the budget", async () => {
    const { entity, reconnect, timers } = fixture();
    for (let attempt = 0; attempt < 10; attempt++) {
      entity.status = "disconnect";
      entity.emit("disconnect");
      expect(timers[attempt].delay).toBe(
        Math.min(1000 * 2 ** attempt, 60_000) * 0.75,
      );
      await timers[attempt].callback();
      entity.emit("connect");
      entity.emit("open");
    }
    entity._status("online");
    entity.status = "disconnect";
    entity.emit("disconnect");
    expect(timers.at(-1).delay).toBe(750);
    reconnect.stop();
  });

  test("coalesces duplicate events without postponing the retry", () => {
    const { entity, reconnect, timers } = fixture();
    reconnect.start();
    expect(entity.listenerCount("disconnect")).toBe(1);
    entity.emit("disconnect");
    entity.emit("disconnect");
    expect(timers).toHaveLength(1);
    expect(timers[0].cancelled).not.toBe(true);
    reconnect.stop();
    expect(timers[0].cancelled).toBe(true);
    expect(entity.listenerCount("status")).toBe(0);
    expect(entity.listenerCount("disconnect")).toBe(0);
  });

  test.each(["connect", "open"])("retries a rejected %s", async (stage) => {
    const { entity, reconnect, timers, connect, open } = fixture();
    const errors = [];
    entity.on("error", (error) => errors.push(error));
    const failure = new Error("unavailable");
    (stage === "connect" ? connect : open).mockRejectedValue(failure);
    spyOn(entity, "disconnect").mockImplementation(async () => {
      entity.status = "disconnect";
      entity.emit("disconnect");
    });
    entity.emit("disconnect");
    await timers[0].callback();
    expect(timers).toHaveLength(2);
    expect(timers[1].delay).toBe(1500);
    reconnect.stop();
  });

  test("stop invalidates in-flight reconnect before opening the stream", async () => {
    const { entity, reconnect, timers, connect, open } = fixture();
    const pending = Promise.withResolvers();
    connect.mockReturnValue(pending.promise);
    const reconnected = jest.fn();
    reconnect.on("reconnected", reconnected);
    entity.emit("disconnect");
    const attempt = timers[0].callback();
    reconnect.stop();
    pending.resolve();
    await attempt;
    expect(open).not.toHaveBeenCalled();
    expect(reconnected).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
  });

  test("offline cancels the timer without disabling a future session", async () => {
    const { entity, reconnect, timers, connect } = fixture();
    entity.emit("disconnect");
    entity.status = "offline";
    entity.emit("offline");
    expect(timers[0].cancelled).toBe(true);
    await timers[0].callback();
    expect(connect).not.toHaveBeenCalled();
    entity.status = "disconnect";
    entity.emit("disconnect");
    expect(timers.at(-1).delay).toBe(750);
    reconnect.stop();
  });

  test("successful resumption resets backoff without another online event", async () => {
    const { entity, reconnect, timers } = fixture();
    entity.emit("disconnect");
    await timers[0].callback();
    const online = jest.fn();
    entity.on("online", online);
    entity._ready(true);
    entity.status = "disconnect";
    entity.emit("disconnect");
    expect(timers[1].delay).toBe(750);
    expect(online).not.toHaveBeenCalled();
    reconnect.stop();
  });

  test("stop from the reconnecting callback prevents connection", async () => {
    const { entity, reconnect, timers, connect } = fixture();
    reconnect.on("reconnecting", () => reconnect.stop());
    entity.emit("disconnect");
    await timers[0].callback();
    expect(connect).not.toHaveBeenCalled();
  });
});
