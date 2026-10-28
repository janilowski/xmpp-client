import { afterEach, expect, test } from "bun:test";
import { mockClient } from "../../test/support/index.js";
import { disconnectClients } from "../../test/support/mockClient.js";
import { xml } from "../client/index.js";
import { sendPolicies } from "../connection/lib/sendPolicy.js";
import operation from "../events/lib/operation.js";
import { setImmediate } from "node:timers/promises";
import { isReported } from "../events/lib/reportedError.js";

const SM = "urn:xmpp:sm:3";

afterEach(disconnectClients);

// Driver callbacks can arrive synchronously, before a send Promise settles.
test("SM owns a stanza before a synchronous driver acknowledgement", async () => {
  const xmpp = mockClient({ streamManagement: { maxStanzas: 1 } });
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  const acks = [];
  const errors = [];
  xmpp._streamError = async (condition) => errors.push(condition);
  sm.on("ack", (stanza) => acks.push(stanza.attrs.id));
  xmpp.socket.write = (_source, callback) => {
    xmpp.mockInput(xml("a", { xmlns: SM, h: "1" }));
    callback();
  };

  await xmpp.send(xml("message", { id: "first" }));
  expect(acks).toEqual(["first"]);
  expect(errors).toEqual([]);
  expect(sm.outbound_q).toEqual([]);
  expect(sm.outbound).toBe(1);
});

test("synchronous write failure cannot steal the next stanza's ACK", async () => {
  const xmpp = mockClient({ streamManagement: { maxStanzas: 1 } });
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  const acks = [];
  const errors = [];
  const failure = new Error("driver rejected before sending");
  xmpp._streamError = async (condition) => errors.push(condition);
  sm.on("ack", (stanza) => acks.push(stanza.attrs.id));
  xmpp.socket.write = (source, callback) => {
    if (source.includes('id="failed"')) {
      throw failure;
    }
    xmpp.mockInput(xml("a", { xmlns: SM, h: "1" }));
    callback();
  };

  const first = xmpp
    .send(xml("message", { id: "failed" }))
    .catch((error) => error);
  const second = xmpp
    .send(xml("message", { id: "sent" }))
    .catch((error) => error);
  expect(await first).toBe(failure);
  expect(await second).toBeUndefined();
  expect(acks).toEqual(["sent"]);
  expect(errors).toEqual([]);
  expect(sm.outbound_q).toEqual([]);
  expect(sm.outbound).toBe(1);
});

test("a throwing send observer cannot roll back a written stanza", async () => {
  const xmpp = mockClient({ streamManagement: { maxStanzas: 1 } });
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  const failure = new Error("application observer failed");
  xmpp.on("send", () => {
    throw failure;
  });

  expect(
    await xmpp.send(xml("message", { id: "sent" })).catch((error) => error),
  ).toBe(failure);
  expect(sm.outbound_q.map(({ stanza }) => stanza.attrs.id)).toEqual(["sent"]);
  expect(
    await xmpp.send(xml("message", { id: "overflow" })).catch((error) => error),
  ).toHaveProperty("code", "ERR_SM_QUEUE_FULL");
});

test("ACK releases bytes before a reentrant observer sends another stanza", async () => {
  const source = '<message id="first" xmlns="jabber:client"/>';
  const xmpp = mockClient({
    streamManagement: { maxStanzas: 1, maxBytes: source.length },
  });
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  let next;
  sm.on("ack", () => {
    next = xmpp.send(xml("message", { id: "other" })).catch((error) => error);
  });
  await xmpp.send(xml("message", { id: "first" }));
  xmpp.mockInput(xml("a", { xmlns: SM, h: "1" }));
  expect(await next).toBeUndefined();
  expect(sm.outbound_q.map(({ stanza }) => stanza.attrs.id)).toEqual(["other"]);
  expect(sm.outbound).toBe(1);
});

test("reentrant ACKs cannot consume a new send from the acknowledged prefix", async () => {
  const xmpp = mockClient({ streamManagement: { maxStanzas: 2 } });
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  const acks = [];
  let next;
  sm.on("ack", (stanza) => {
    acks.push(stanza.attrs.id);
    if (stanza.attrs.id === "first") {
      next = xmpp.send(xml("message", { id: "new" }));
      xmpp.mockInput(xml("a", { xmlns: SM, h: "2" }));
    }
  });
  await xmpp.sendMany([
    xml("message", { id: "first" }),
    xml("message", { id: "second" }),
  ]);
  xmpp.mockInput(xml("a", { xmlns: SM, h: "2" }));
  await next;
  expect(acks).toEqual(["first", "second"]);
  expect(sm.outbound_q.map(({ stanza }) => stanza.attrs.id)).toEqual(["new"]);
  expect(sm.outbound).toBe(2);
});

test("a failed nested raw write cannot cancel its outer stanza", async () => {
  const xmpp = mockClient({ streamManagement: { maxStanzas: 1 } });
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  const failure = new Error("nested raw write failed");
  let nested;
  xmpp.socket.write = (source, callback) => {
    if (source === "<probe/>") {
      throw failure;
    }
    nested = xmpp.write("<probe/>").catch((error) => error);
    callback();
  };
  await xmpp.send(xml("message", { id: "owned" }));
  expect(await nested).toBe(failure);
  expect(sm.outbound_q.map(({ stanza }) => stanza.attrs.id)).toEqual(["owned"]);
});

test("an old failed enable cannot clear a replacement enable reservation", async () => {
  const xmpp = mockClient({ streamManagement: { maxStanzas: 1 } });
  const oldWrite = Promise.withResolvers();
  const newWrite = Promise.withResolvers();
  const failure = new Error("old enable failed late");
  let writes = 0;
  xmpp.write = () => (++writes === 1 ? oldWrite.promise : newWrite.promise);
  const oldSend = xmpp
    .send(xml("enable", { xmlns: SM }))
    .catch((error) => error);
  xmpp.emit("disconnect");
  xmpp._status("connecting");
  xmpp._attachSocket(xmpp.socket);
  const newSend = xmpp.send(xml("enable", { xmlns: SM }));
  try {
    expect(xmpp.streamManagement.enableSent).toBe(true);
    oldWrite.reject(failure);
    expect(await oldSend).toBe(failure);
    expect(xmpp.streamManagement.enableSent).toBe(true);
  } finally {
    newWrite.resolve();
    await newSend;
  }
});

test("terminal queue failure cannot retain old ownership in a replacement", async () => {
  const xmpp = mockClient({ streamManagement: { maxStanzas: 1 } });
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  const failures = [];
  let replacement;
  sm.on("fail", (stanza) => failures.push(stanza.attrs.id));
  await xmpp.send(xml("message", { id: "old" }));
  xmpp.on("send", (stanza) => {
    if (!stanza.is("error", "http://etherx.jabber.org/streams")) {
      return;
    }
    xmpp._status("connecting");
    xmpp._attachSocket(xmpp.socket);
    sm.enabled = true;
    replacement = xmpp
      .send(xml("message", { id: "new" }))
      .catch((error) => error);
  });
  await sendPolicies.get(xmpp).fail();
  expect(await replacement).toBeUndefined();
  expect(failures).toEqual(["old"]);
  expect(sm.outbound_q.map(({ stanza }) => stanza.attrs.id)).toEqual(["new"]);
  expect(sm.enabled).toBe(true);
});

test("a terminal queue error is reported once across pending middleware operations", async () => {
  const xmpp = mockClient({ streamManagement: { maxStanzas: 1 } });
  xmpp.streamManagement.enabled = true;
  xmpp._streamError = async () => {};
  const errors = [];
  xmpp.on("error", (error) => errors.push(error));
  xmpp.middleware.use(async ({ stanza }, next) => {
    if (stanza.attrs.id?.startsWith("waiting")) {
      await operation(xmpp, () => new Promise(() => {}), 0);
    }
    return next();
  });
  await xmpp.send(xml("message", { id: "held" }));
  xmpp.mockInput(xml("message", { id: "waiting-one" }));
  xmpp.mockInput(xml("message", { id: "waiting-two" }));
  xmpp.mockInput(
    xml("iq", { id: "ping", type: "get" }, xml("ping", "urn:xmpp:ping")),
  );
  await setImmediate();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toHaveProperty("code", "ERR_SM_QUEUE_FULL");
});

test("a terminal queue error without listeners still rejects the pipeline", async () => {
  const xmpp = mockClient({ streamManagement: { maxStanzas: 1 } });
  xmpp.streamManagement.enabled = true;
  xmpp._streamError = async () => {};
  xmpp.removeAllListeners("error");
  await xmpp.send(xml("message", { id: "held" }));
  const incoming = xmpp.listeners("element")[0];
  const result = await incoming(
    xml(
      "iq",
      { xmlns: "jabber:client", id: "ping", type: "get" },
      xml("ping", "urn:xmpp:ping"),
    ),
  ).catch((error) => error);
  expect(result).toHaveProperty("code", "ERR_SM_QUEUE_FULL");
  expect(xmpp.listenerCount("error")).toBe(0);
  expect(isReported(xmpp, result)).toBe(false);
});
