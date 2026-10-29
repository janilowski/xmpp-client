import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { waitForDisconnect } from "./peer.ts";

const EVENT_TIMEOUT_MS = 50;

// Harness observations, not protocol requirements or active client shutdown.
test("disconnect observation accepts an already completed disconnect", async () => {
  const client = Object.assign(new EventEmitter(), { status: "disconnect" });
  const result = waitForDisconnect(client, 0);

  expect(client.listenerCount("disconnect")).toBe(0);
  expect(await result).toBe(true);
  expect(client.status).toBe("disconnect");
});

test("disconnect observation does not accept offline as disconnect", async () => {
  const client = Object.assign(new EventEmitter(), { status: "offline" });
  const result = waitForDisconnect(client, 0);

  expect(client.listenerCount("disconnect")).toBe(1);
  expect(await result).toBe(false);
  expect(client.listenerCount("disconnect")).toBe(0);
  expect(client.status).toBe("offline");
});

test("disconnect observation waits for its event without consuming errors", async () => {
  const client = Object.assign(new EventEmitter(), { status: "disconnecting" });
  const errors: Error[] = [];
  const expected = new Error("expected stream failure");
  const onError = (error: Error) => errors.push(error);
  client.on("error", onError);
  const result = waitForDisconnect(client, EVENT_TIMEOUT_MS);

  expect(client.listenerCount("disconnect")).toBe(1);
  queueMicrotask(() => {
    client.emit("error", expected);
    client.status = "disconnect";
    client.emit("disconnect");
  });

  expect(await result).toBe(true);
  expect(errors).toEqual([expected]);
  expect(client.listeners("error")).toEqual([onError]);
  expect(client.listenerCount("disconnect")).toBe(0);
  expect(client.status).toBe("disconnect");
});

test("disconnect observation deadline removes only its own listener", async () => {
  const client = Object.assign(new EventEmitter(), { status: "disconnecting" });
  let observed = 0;
  const onDisconnect = () => observed++;
  client.on("disconnect", onDisconnect);
  const result = waitForDisconnect(client, 0);

  expect(client.listenerCount("disconnect")).toBe(2);
  expect(await result).toBe(false);
  expect(client.listeners("disconnect")).toEqual([onDisconnect]);
  expect(observed).toBe(0);
  expect(client.status).toBe("disconnecting");
  client.emit("disconnect");
  expect(observed).toBe(1);
  expect(client.listeners("disconnect")).toEqual([onDisconnect]);
});
