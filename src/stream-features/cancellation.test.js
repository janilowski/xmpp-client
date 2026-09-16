import { afterEach } from "bun:test";
import { disconnectClients } from "../../test/support/mockClient.js";

afterEach(disconnectClients);

import { expect, test } from "bun:test";
import { mockClient, xml } from "../../test/support/index.js";

const STREAMS = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";

test("an application AbortError remains observable rather than being mistaken for disconnect", async () => {
  const error = new DOMException("Credentials unavailable", "AbortError");
  const entity = mockClient({
    credentials: async () => {
      throw error;
    },
  });
  const errors = [];
  entity.on("error", (value) => errors.push(value));
  entity.mockInput(
    xml(
      "features",
      { xmlns: STREAMS },
      xml("mechanisms", { xmlns: SASL }, xml("mechanism", {}, "PLAIN")),
    ),
  );
  await Bun.sleep(10);
  expect(errors).toEqual([error]);
});

test.each([SM, SASL2])(
  "resumption interrupted during replay cannot mark the next connection ready: %s",
  async (ns) => {
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const entity = mockClient({ username: "foo", password: "bar" });
    const errors = [];
    entity.on("error", (error) => errors.push(error));
    entity.streamManagement.id = "old-session";
    entity.streamManagement.outbound_q.push({
      stanza: xml("presence"),
      stamp: "stamp",
    });
    entity.streamManagement.outbound_q.push({
      stanza: xml("message", { id: "not-replayed" }),
      stamp: "stamp",
    });
    let ready = 0;
    entity._ready = () => {
      ready++;
    };
    const feature =
      ns === SM
        ? xml("sm", { xmlns: SM })
        : xml(
            "authentication",
            { xmlns: SASL2 },
            xml("mechanism", {}, "PLAIN"),
            xml("inline", {}, xml("sm", { xmlns: SM })),
          );
    entity.mockInput(xml("features", { xmlns: STREAMS }, feature));
    await entity.catchOutgoing();
    entity.send = async () => {
      entered.resolve();
      await gate.promise;
    };
    const resumed = xml("resumed", {
      xmlns: SM,
      h: "0",
      previd: "old-session",
    });
    entity.mockInput(
      ns === SM ? resumed : xml("success", { xmlns: SASL2 }, resumed),
    );
    await entered.promise;
    entity.emit("disconnect");
    entity.emit("connect");
    gate.resolve();
    await Bun.sleep(10);
    expect(ready).toBe(0);
    expect(
      entity.streamManagement.outbound_q.map(({ stanza }) => stanza.name),
    ).toEqual(["presence", "message"]);
    expect(errors).toEqual([]);
  },
);

test.each([SASL, SASL2])(
  "an interrupted asynchronous challenge cannot send into the next session: %s",
  async (ns) => {
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const entity = mockClient({
      credentials: async (authenticate) => {
        await authenticate({}, "TEST");
      },
    });
    entity.saslMechanisms.register("TEST", () => ({
      name: "TEST",
      clientFirst: true,
      response: async () => "response",
      challenge: async () => {
        entered.resolve();
        await gate.promise;
      },
    }));
    const errors = [];
    entity.on("error", (error) => errors.push(error));
    entity.mockInput(
      xml(
        "features",
        { xmlns: STREAMS },
        xml(
          ns === SASL ? "mechanisms" : "authentication",
          { xmlns: ns },
          xml("mechanism", {}, "TEST"),
        ),
      ),
    );
    await entity.catchOutgoing();
    entity.mockInput(xml("challenge", { xmlns: ns }, "eA=="));
    await entered.promise;
    entity.emit("disconnect");
    entity.emit("connect");
    const sent = [];
    entity.send = async (stanza) => {
      sent.push(stanza);
    };
    gate.resolve();
    await Bun.sleep(10);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
  },
);

test("SASL2 final verification cannot bind a replacement session", async () => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const entity = mockClient({
    credentials: async (authenticate) => {
      await authenticate({}, "TEST");
    },
  });
  entity.saslMechanisms.register("TEST", () => ({
    name: "TEST",
    clientFirst: true,
    response: async () => "response",
    final: async () => {
      entered.resolve();
      await gate.promise;
    },
  }));
  const errors = [];
  entity.on("error", (error) => errors.push(error));
  const original = entity.jid.toString();
  let ready = 0;
  entity._ready = () => {
    ready++;
  };
  entity.mockInput(
    xml(
      "features",
      { xmlns: STREAMS },
      xml("authentication", { xmlns: SASL2 }, xml("mechanism", {}, "TEST")),
    ),
  );
  await entity.catchOutgoing();
  entity.mockInput(
    xml(
      "success",
      { xmlns: SASL2 },
      xml("additional-data", {}, "eA=="),
      xml("authorization-identifier", {}, "old@session/resource"),
      xml("bound", { xmlns: "urn:xmpp:bind:0" }),
    ),
  );
  await entered.promise;
  entity.emit("disconnect");
  entity.emit("connect");
  gate.resolve();
  await Bun.sleep(10);
  expect(entity.jid.toString()).toBe(original);
  expect(ready).toBe(0);
  expect(errors).toEqual([]);
});

test("a delayed resource callback cannot send binding on a replacement stream", async () => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const entity = mockClient({
    resource: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const sent = [];
  entity.send = async (stanza) => {
    sent.push(stanza);
  };
  entity.mockInput(
    xml("features", { xmlns: STREAMS }, xml("bind", { xmlns: BIND })),
  );
  await entered.promise;
  entity.emit("disconnect");
  entity.emit("connect");
  gate.resolve("old-resource");
  await Bun.sleep(10);
  expect(sent).toEqual([]);
});

test.each([SASL, SASL2, BIND, SM])(
  "silent negotiation has a deadline and releases listeners: %s",
  async (ns) => {
    const entity = mockClient({
      timeout: 15,
      username: "foo",
      password: "bar",
    });
    const errors = [];
    entity.on("error", (error) => errors.push(error));
    const listeners = entity.listenerCount("nonza");
    const feature =
      ns === SASL
        ? "mechanisms"
        : ns === SASL2
          ? "authentication"
          : ns === BIND
            ? "bind"
            : "sm";
    entity.mockInput(
      xml(
        "features",
        { xmlns: STREAMS },
        xml(
          feature,
          { xmlns: ns },
          [SASL, SASL2].includes(ns)
            ? xml("mechanism", {}, "PLAIN")
            : undefined,
        ),
      ),
    );
    await entity.catchOutgoing();
    await Bun.sleep(40);
    expect(errors.some((error) => error.name === "TimeoutError")).toBe(true);
    expect(entity.listenerCount("nonza")).toBe(listeners);
    expect(entity.iqCaller.handlers.size).toBe(0);
  },
);

// RFC 6120 §§4.4, 6, 7; XEP-0388 and XEP-0198: a terminated exchange
// cannot send or complete negotiation on a replacement connection.
test.each([SASL, SASL2])(
  "late credentials cannot authenticate after disconnect: %s",
  async (ns) => {
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const entity = mockClient({
      credentials: async (authenticate) => {
        entered.resolve();
        await gate.promise;
        await authenticate({ username: "foo", password: "bar" }, "PLAIN");
      },
    });
    const sent = [];
    entity.send = async (stanza) => {
      sent.push(stanza);
    };
    entity.on("error", () => {});
    entity.mockInput(
      xml(
        "features",
        { xmlns: STREAMS },
        xml(
          ns === SASL ? "mechanisms" : "authentication",
          { xmlns: ns },
          xml("mechanism", {}, "PLAIN"),
        ),
      ),
    );
    await entered.promise;
    entity.emit("disconnect");
    entity.emit("connect");
    gate.resolve();
    await Bun.sleep(10);
    expect(sent).toEqual([]);
    entity.emit("disconnect");
  },
);

test("binding abandons its pending IQ on disconnect", async () => {
  const entity = mockClient();
  entity.on("error", () => {});
  entity.mockInput(
    xml("features", { xmlns: STREAMS }, xml("bind", { xmlns: BIND })),
  );
  await entity.catchOutgoingSet();
  expect(entity.iqCaller.handlers.size).toBe(1);
  entity.emit("disconnect");
  await Bun.sleep(10);
  expect(entity.iqCaller.handlers.size).toBe(0);
});

test("SM does not fall back to enabling after disconnected resumption", async () => {
  const entity = mockClient();
  entity.on("error", () => {});
  entity.streamManagement.id = "old-session";
  entity.mockInput(
    xml("features", { xmlns: STREAMS }, xml("sm", { xmlns: SM })),
  );
  expect((await entity.catchOutgoing()).name).toBe("resume");
  const sent = [];
  entity.send = async (stanza) => {
    sent.push(stanza);
  };
  entity.emit("disconnect");
  entity.emit("connect");
  await Bun.sleep(10);
  expect(sent).toEqual([]);
  entity.emit("disconnect");
});
