import { afterEach, expect, test } from "bun:test";
import { mockClient, mockInput } from "../../../test/support/index.js";
import { disconnectClients } from "../../../test/support/mockClient.js";
import xml from "../../xml/index.js";
import { client } from "../../client/index.js";
import ConnectionWebSocket from "../../websocket/lib/Connection.js";

afterEach(disconnectClients);

test("batch sends prepare addresses without bypassing validation", async () => {
  const conn = new ConnectionWebSocket();
  const frames = [];
  conn.write = async (frame) => frames.push(frame);
  await conn.sendMany([
    xml("message", { to: "E\u0301@xn--bcher-kva.example" }),
  ]);
  expect(frames).toEqual([
    '<message to="é@bücher.example" xmlns="jabber:client"/>',
  ]);
  await expect(
    conn.sendMany([xml("message", { to: "@remote" })]),
  ).rejects.toThrow(TypeError);
  expect(frames.length).toBe(1);
});

test("prepares the stream domain without changing SASL credentials", () => {
  const xmpp = client({ domain: "XN--BCHER-KVA.example.", username: "É" });
  expect(xmpp.options.domain).toBe("bücher.example");
  expect(xmpp.jid.toString()).toBe("é@bücher.example");
});

test("prepares stanza addresses before writing and rejects malformed destinations", async () => {
  const xmpp = mockClient();
  const frames = [];
  xmpp.write = async (frame) => frames.push(frame);
  await xmpp.send(
    xml("message", { to: "E\u0301@xn--bcher-kva.example/R\u00a0X" }),
  );
  expect(frames).toEqual(['<message to="é@bücher.example/R X"/>']);
  await expect(xmpp.send(xml("message", { to: "@remote" }))).rejects.toThrow(
    TypeError,
  );
  expect(frames.length).toBe(1);
});

test("prepares the requested resource before resource binding", async () => {
  const xmpp = mockClient({ resource: async () => "Re\u0301s\u00a0X" });
  xmpp.streamFeatures.authenticated = true;
  const outgoing = xmpp.catchOutgoingSet();
  mockInput(
    xmpp,
    xml(
      "features",
      { xmlns: "http://etherx.jabber.org/streams" },
      xml("bind", { xmlns: "urn:ietf:params:xml:ns:xmpp-bind" }),
    ),
  );
  expect((await outgoing).getChildText("resource")).toBe("Rés X");
});

test("IQ accepts a canonically equivalent Unicode sender", async () => {
  const xmpp = mockClient();
  const pending = xmpp.iqCaller
    .request(
      xml("iq", { type: "get", id: "unicode", to: "é@bücher.example/Rés" }),
      30,
    )
    .catch((error) => error);
  const reply = xml("iq", {
    type: "result",
    id: "unicode",
    from: "e\u0301@xn--bcher-kva.example/Re\u0301s",
  });
  mockInput(xmpp, reply);
  expect(await pending).toBe(reply);
});

test("malformed incoming address does not abort processing of a valid reply", async () => {
  const xmpp = mockClient();
  const pending = xmpp.iqCaller
    .request(xml("iq", { type: "get", id: "invalid", to: "peer@remote" }), 30)
    .catch((error) => error);
  expect(() =>
    mockInput(
      xmpp,
      xml("iq", { type: "result", id: "invalid", from: "@remote" }),
    ),
  ).not.toThrow();
  const reply = xml("iq", {
    type: "result",
    id: "invalid",
    from: "peer@remote",
  });
  mockInput(xmpp, reply);
  expect(await pending).toBe(reply);
});
