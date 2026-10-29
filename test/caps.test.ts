import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { client, xml } from "../src/index.ts";
import type { CapsResult, Element } from "../types/index.js";
import server from "../server/index.js";

const INFO = "http://jabber.org/protocol/disco#info";
const ITEMS = "http://jabber.org/protocol/disco#items";
const CAPS = "http://jabber.org/protocol/caps";
const PING = "urn:xmpp:ping";
const EXTRA = "urn:example:extra";
const NODE = "https://example.test/app";
const WAIT_MS = 3000;
const IDENTITY = { category: "client", type: "web", name: "Example" };
// Independent SHA-1 oracle over literal XEP-0115 §5.1 canonical inputs.
const PREFIX =
  "client/web//Example<http://jabber.org/protocol/caps<http://jabber.org/protocol/disco#info<http://jabber.org/protocol/disco#items<";
const INITIAL_VER = createHash("sha1")
  .update(`${PREFIX}urn:xmpp:ping<`, "utf8")
  .digest("base64");
const UPDATED_VER = createHash("sha1")
  .update(`${PREFIX}urn:example:extra<urn:xmpp:ping<`, "utf8")
  .digest("base64");
const clients: ReturnType<typeof client>[] = [];

beforeEach(() => server.restart());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((xmpp) => xmpp.stop()));
});

async function verified(
  xmpp: ReturnType<typeof client>,
  address: string,
  ver: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observe: (value: CapsResult) => void;
  const value = await new Promise<CapsResult | undefined>((resolve) => {
    observe = (value) => {
      if (
        value.jid === address &&
        value.ver === ver &&
        value.status === "verified"
      ) {
        resolve(value);
      }
    };
    xmpp.on("capabilities", observe);
    const current = xmpp.caps.get(address);
    if (current?.ver === ver && current.status === "verified") {
      resolve(current);
    }
    // Expiry returns observed state for an assertion, not a timeout-only failure.
    timer = setTimeout(() => resolve(xmpp.caps.get(address)), WAIT_MS);
  }).finally(() => {
    clearTimeout(timer);
    xmpp.off("capabilities", observe);
  });
  expect(value).toMatchObject({ jid: address, ver, status: "verified" });
  expect(value?.error).toBeUndefined();
  return value!;
}

async function pair() {
  const make = (resource: string) =>
    client({
      service: "wss://localhost:5281/xmpp-websocket",
      username: "client",
      password: "foobar",
      resource,
      disco: { identities: [IDENTITY] },
      caps: { node: NODE },
    });
  const receiver = make("caps-receiver");
  const sender = make("caps-sender");
  clients.push(receiver, sender);
  const errors: Error[] = [];
  const presences: Element[] = [];
  const queries: Element[] = [];
  for (const xmpp of [receiver, sender]) {
    xmpp.on("error", (error: Error) => errors.push(error));
    xmpp.on("send", (element: Element) => {
      if (element.is("presence")) {
        presences.push(element);
      }
    });
  }
  const receiverAddress = String(await receiver.start());
  const senderAddress = String(await sender.start());
  receiver.on("send", (element: Element) => {
    if (
      element.is("iq") &&
      element.attrs.type === "get" &&
      element.attrs.to === senderAddress &&
      element.getChild("query", INFO)
    ) {
      queries.push(element);
    }
  });
  expect(receiverAddress).not.toBe(senderAddress);
  expect(presences).toEqual([]);
  return {
    receiver,
    sender,
    receiverAddress,
    senderAddress,
    errors,
    presences,
    queries,
  };
}

test("XEP-0115 §§5–7: Prosody routes directed caps and exact full-JID node discovery", async () => {
  const {
    receiver,
    sender,
    receiverAddress,
    senderAddress,
    errors,
    presences,
    queries,
  } = await pair();
  const delivered: Element[] = [];
  sender.on("stanza", (element: Element) => {
    if (
      element.is("iq") &&
      element.attrs.type === "get" &&
      element.getChild("query", INFO)
    ) {
      delivered.push(element);
    }
  });
  expect(INITIAL_VER).toBe("tjB+cZ9oy2RdUNdIjVGv8mClG6Y=");
  await sender.send(
    xml(
      "presence",
      { to: receiverAddress },
      xml("status", {}, "Directed availability"),
    ),
  );
  const value = await verified(receiver, senderAddress, INITIAL_VER);
  expect(value.node).toBe(NODE);
  expect(value.hash).toBe("sha-1");
  expect(value.info?.identities).toEqual([IDENTITY]);
  expect(value.info?.features).toEqual([INFO, ITEMS, PING, CAPS]);
  expect(value.info?.node).toBe(`${NODE}#${INITIAL_VER}`);
  expect(queries).toHaveLength(1);
  expect(queries[0].attrs.to).toBe(senderAddress);
  expect(queries[0].getChild("query", INFO)?.attrs.node).toBe(
    `${NODE}#${INITIAL_VER}`,
  );
  expect(delivered).toHaveLength(1);
  expect(delivered[0].attrs.from).toBe(receiverAddress);
  expect(delivered[0].attrs.to).toBe(senderAddress);
  expect(delivered[0].getChild("query", INFO)?.attrs.node).toBe(
    `${NODE}#${INITIAL_VER}`,
  );
  expect(presences).toHaveLength(1);
  expect(presences[0].attrs.to).toBe(receiverAddress);
  expect(errors).toEqual([]);
});

test("XEP-0115 §§6.1/8.2: directed updates verify, unavailable clears hint, renewed presence reuses cache", async () => {
  const {
    receiver,
    sender,
    receiverAddress,
    senderAddress,
    errors,
    presences,
    queries,
  } = await pair();
  await sender.send(xml("presence", { to: receiverAddress }));
  await verified(receiver, senderAddress, INITIAL_VER);
  sender.disco.addFeature(EXTRA);
  await sender.send(xml("presence", { to: receiverAddress }));
  expect(UPDATED_VER).toBe("LWgoB96IFB1lkIr5uunevzQzdGg=");
  expect(
    (await verified(receiver, senderAddress, UPDATED_VER)).info?.features,
  ).toEqual([INFO, ITEMS, PING, CAPS, EXTRA]);
  expect(queries).toHaveLength(2);
  expect(presences).toHaveLength(2);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let observe: (element: Element) => void;
  const unavailable = new Promise<Element | undefined>((resolve) => {
    observe = (element) => {
      if (
        element.is("presence") &&
        element.attrs.from === senderAddress &&
        element.attrs.type === "unavailable"
      ) {
        resolve(element);
      }
    };
    receiver.on("stanza", observe);
    timer = setTimeout(() => resolve(undefined), WAIT_MS);
  });
  try {
    await sender.send(
      xml("presence", { to: receiverAddress, type: "unavailable" }),
    );
    expect(await unavailable).toBeDefined();
  } finally {
    clearTimeout(timer);
    receiver.off("stanza", observe!);
  }
  expect(receiver.caps.get(senderAddress)).toBeUndefined();
  await sender.send(xml("presence", { to: receiverAddress }));
  const reused = await verified(receiver, senderAddress, UPDATED_VER);
  expect(reused.info?.features).toContain(EXTRA);
  expect(queries).toHaveLength(2);
  expect(presences).toHaveLength(4);
  expect(
    presences.every((presence) => presence.attrs.to === receiverAddress),
  ).toBe(true);
  expect(errors).toEqual([]);
});
