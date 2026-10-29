import { afterEach, beforeEach, expect, test } from "bun:test";
import { client } from "../src/index.ts";
import server from "../server/index.js";

const INFO = "http://jabber.org/protocol/disco#info";
const ITEMS = "http://jabber.org/protocol/disco#items";
const PING = "urn:xmpp:ping";
const clients: ReturnType<typeof client>[] = [];

beforeEach(() => server.restart());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((xmpp) => xmpp.stop()));
});

test("XEP-0030 §§3–4: discover Prosody information and public items", async () => {
  const xmpp = client({
    service: "ws://localhost:5280/xmpp-websocket",
    username: "client",
    password: "foobar",
  });
  clients.push(xmpp);
  expect(xmpp.disco).toBeDefined();
  await xmpp.start();

  const info = await xmpp.disco.info("localhost");
  expect(
    info.identities.some((identity) => identity.category === "server"),
  ).toBe(true);
  expect(info.features).toContain(INFO);
  expect(info.features).toContain(ITEMS);
  expect(info.query.is("query", INFO)).toBe(true);
  const items = await xmpp.disco.items("localhost");
  expect(items.query.is("query", ITEMS)).toBe(true);
  expect(Array.isArray(items.items)).toBe(true);
});

test("XEP-0030 §§3–4/7: Prosody routes client discovery, nodes and refusal", async () => {
  const requester = client({
    service: "ws://localhost:5280/xmpp-websocket",
    username: "client",
    password: "foobar",
    resource: "disco-requester",
  });
  const responder = client({
    service: "ws://localhost:5280/xmpp-websocket",
    username: "client",
    password: "foobar",
    resource: "disco-responder",
    disco: {
      identities: [
        { category: "client", type: "bot", name: "Integration peer" },
      ],
      authorize: ({ node }) => node !== "private",
    },
  });
  clients.push(requester, responder);
  expect(requester.disco).toBeDefined();
  expect(responder.disco).toBeDefined();
  responder.disco.setNode("commands", {
    identities: [{ category: "automation", type: "command-list" }],
  });
  await requester.start();
  const address = await responder.start();
  responder.disco.setItems([{ jid: address.toString(), node: "commands" }]);

  const info = await requester.disco.info(address);
  expect(info.identities).toEqual([
    { category: "client", type: "bot", name: "Integration peer" },
  ]);
  expect(info.features).toEqual([INFO, ITEMS, PING]);
  expect((await requester.disco.items(address)).items).toEqual([
    { jid: address.toString(), node: "commands" },
  ]);
  expect((await requester.disco.info(address, { node: "commands" })).node).toBe(
    "commands",
  );
  expect(
    (await requester.disco.items(address, { node: "commands" })).items,
  ).toEqual([]);
  await expect(
    requester.disco.info(address, { node: "missing" }),
  ).rejects.toMatchObject({
    name: "StanzaError",
    condition: "item-not-found",
  });
  await expect(
    requester.disco.info(address, { node: "private" }),
  ).rejects.toMatchObject({
    name: "StanzaError",
    condition: "service-unavailable",
  });
});
