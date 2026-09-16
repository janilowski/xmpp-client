import { promise, delay } from "../src/events/index.js";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { client, xml, jid } from "../src/client/index.js";
import debug from "../src/debug/index.js";
import server from "../server/index.js";

const username = "client";
const password = "foobar";
const credentials = { username, password };
const domain = "localhost";
const service = "ws://localhost:5280/xmpp-websocket";
const JID = jid(username, domain).toString();

let xmpp;

beforeEach(async () => {
  await server.restart();
});

afterEach(async () => {
  try {
    if (xmpp && xmpp.status !== "offline") {
      await xmpp.stop();
    }
  } finally {
    xmpp?.removeAllListeners();
  }
});

test("client", async () => {
  expect.assertions(6);

  xmpp = client({ credentials, service });
  debug(xmpp);

  const connects = [];
  const opens = [];
  const online = [];
  xmpp.on("connect", () => connects.push(true));
  xmpp.once("open", (el) => opens.push(el));
  xmpp.on("online", (address) => online.push(address));

  const address = await xmpp.start();
  expect(connects).toHaveLength(1);
  expect(opens[0]).toBeInstanceOf(xml.Element);
  expect(online[0]).toBeInstanceOf(jid.JID);
  expect(online[0]?.bare().toString()).toBe(JID);
  expect(address instanceof jid.JID).toBe(true);
  expect(address.bare().toString()).toBe(JID);
});

test("bad credentials", async () => {
  expect.assertions(6);

  xmpp = client({
    service,
    credentials: { ...credentials, password: "nope" },
  });
  debug(xmpp);

  const connects = [];
  const opens = [];
  const online = [];
  const errors = [];
  xmpp.on("connect", () => connects.push(true));
  xmpp.once("open", (el) => opens.push(el));
  xmpp.on("online", (address) => online.push(address));
  xmpp.on("error", (error) => errors.push(error));

  await expect(xmpp.start()).rejects.toMatchObject({
    name: "SASLError",
    condition: "not-authorized",
  });
  expect(connects).toHaveLength(1);
  expect(opens).toHaveLength(1);
  expect(online).toHaveLength(0);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(Error);
});

test("reconnects when server restarts gracefully", async () => {
  expect.assertions(2);

  xmpp = client({ credentials, service });
  debug(xmpp);

  xmpp.on("error", () => {});

  expect((await xmpp.start()).bare().toString()).toBe(JID);
  const online = promise(xmpp, "online", null, 5000);
  await server.restart();
  expect((await online).bare().toString()).toBe(JID);
});

test("reconnects when server restarts non-gracefully", async () => {
  expect.assertions(2);

  xmpp = client({ credentials, service });
  debug(xmpp);

  xmpp.on("error", () => {});

  expect((await xmpp.start()).bare().toString()).toBe(JID);
  const online = promise(xmpp, "online", null, 5000);
  await server.restart("SIGKILL");
  expect((await online).bare().toString()).toBe(JID);
});

test("does not reconnect when stop is called", async () => {
  expect.assertions(3);

  xmpp = client({ service, credentials });
  debug(xmpp);
  const RECONNECT_DELAY_MS = 50;
  xmpp.reconnect.delay = RECONNECT_DELAY_MS;
  let reconnects = 0;
  xmpp.reconnect.on("reconnecting", () => {
    reconnects++;
  });

  xmpp.on("close", () => {
    expect().pass();
  });

  xmpp.on("offline", () => {
    expect().pass();
  });

  await xmpp.start();
  await xmpp.stop();
  await server.stop();
  await delay(RECONNECT_DELAY_MS * 2);
  expect(reconnects).toBe(0);
});

test("statuses", async () => {
  xmpp = client({ credentials, service });
  debug(xmpp);

  let statuses = [xmpp.status];

  xmpp.on("status", (status) => {
    statuses.push(status);
  });

  xmpp.on("error", () => {});

  await xmpp.start();

  expect(statuses).toEqual([
    "offline",
    "connecting",
    "connect",
    "opening",
    "open",
    "online",
  ]);

  // trigger reconnect
  await xmpp.disconnect();

  statuses = [xmpp.status];
  await promise(xmpp, "open");

  expect(statuses).toEqual([
    "disconnect",
    "connecting",
    "connect",
    "opening",
    "open",
  ]);
});

test("anonymous authentication", async () => {
  expect.assertions(2);

  xmpp = client({ service, domain: "anon." + domain });
  debug(xmpp);

  xmpp.on("close", () => {
    expect().pass();
  });

  xmpp.on("offline", () => {
    expect().pass();
  });

  await xmpp.start();
  await xmpp.stop();
  await server.stop();
});

test("auto", async () => {
  xmpp = client({ credentials, service });
  debug(xmpp);
  const address = await xmpp.start();
  expect(address.bare().toString()).toBe(JID);
});

test("ws IPv4", async () => {
  xmpp = client({
    credentials,
    service: "ws://127.0.0.1:5280/xmpp-websocket",
    domain,
  });
  debug(xmpp);
  const address = await xmpp.start();
  expect(address.bare().toString()).toBe(JID);
});

test("ws IPv6", async () => {
  xmpp = client({
    credentials,
    service: "ws://[::1]:5280/xmpp-websocket",
    domain,
  });
  debug(xmpp);
  const address = await xmpp.start();
  expect(address.bare().toString()).toBe(JID);
});

test("ws domain", async () => {
  xmpp = client({
    credentials,
    service,
  });
  debug(xmpp);
  const address = await xmpp.start();
  expect(address.bare().toString()).toBe(JID);
});

// Prosody 404 https://prosody.im/issues/issue/932
test("wss IPv4", async () => {
  xmpp = client({
    credentials,
    service: "wss://127.0.0.1:5281/xmpp-websocket",
    domain,
  });
  debug(xmpp);
  const address = await xmpp.start();
  expect(address.bare().toString()).toBe(JID);
});

// Prosody 404 https://prosody.im/issues/issue/932
// Bun 1.3.14 retains IPv6 URL brackets during TLS identity verification:
// https://github.com/oven-sh/bun/pull/30674
test.failingIf(["1.3.14", "1.4.2"].includes(process.versions.bun))(
  "wss IPv6 (Bun upstream TLS identity defect)",
  async () => {
    xmpp = client({
      credentials,
      service: "wss://[::1]:5281/xmpp-websocket",
      domain,
    });
    debug(xmpp);
    const address = await xmpp.start();
    expect(address.bare().toString()).toBe(JID);
  },
);

test("wss domain", async () => {
  xmpp = client({
    credentials,
    service: "wss://localhost:5281/xmpp-websocket",
  });
  debug(xmpp);
  const address = await xmpp.start();
  expect(address.bare().toString()).toBe(JID);
});
