import { JID } from "../../../test/support/index.js";

import Context from "../lib/IncomingContext.js";
import _Context from "../lib/Context.js";
import Connection from "../../connection/index.js";
import { EventEmitter } from "../../events/index.js";
import {
  confirmIdentity,
  resetConnection,
} from "../../connection/lib/negotiation.js";

test("is instance of Context", () => {
  const entity = { jid: new JID("foo@bar"), options: { domain: "bar" } };
  const ctx = new Context(entity, { attrs: {} });
  expect(ctx instanceof _Context).toBe(true);
});

test("sets the from property", () => {
  const entity = { jid: new JID("foo@bar"), options: { domain: "bar" } };
  const ctx = new Context(entity, { attrs: { from: "foo@bar" } });
  expect(ctx.from).toEqual(new JID("foo@bar"));
});

test("from property defaults to incoming stanza from attribute", () => {
  const entity = { jid: new JID("foo@bar"), options: { domain: "bar" } };
  const ctx = new Context(entity, { attrs: { from: "foo" } });
  expect(ctx.from).toEqual(new JID("foo"));
});

test("absent from does not trust a configured identity or server domain", () => {
  const entity = { jid: new JID("foo@bar"), options: { domain: "bar" } };
  const ctx = new Context(entity, { attrs: {} });
  expect(ctx.from).toBe(null);
});

test("absent from uses the protocol-confirmed bare account", () => {
  const entity = { jid: new JID("hint@bar"), options: { domain: "bar" } };
  resetConnection(entity);
  confirmIdentity(entity, new JID("confirmed@bar/resource"));

  const ctx = new Context(entity, { attrs: {} });
  expect(ctx.from).toEqual(new JID("confirmed@bar"));
  expect(ctx.local).toBe("confirmed");
});

test("a replacement connection cannot reuse the former account", () => {
  const entity = {
    jid: new JID("former@bar/resource"),
    options: { domain: "bar" },
  };
  resetConnection(entity);
  confirmIdentity(entity, entity.jid);
  resetConnection(entity);

  const ctx = new Context(entity, { attrs: {} });
  expect(ctx.from).toBe(null);
});

test("socket closure invalidates the confirmed sender before disconnect", () => {
  const entity = new Connection({ domain: "bar" });
  const socket = new EventEmitter();
  entity._attachSocket(socket);
  entity._jid("confirmed@bar/resource");
  let from;
  entity.on("disconnect", () => {
    from = new Context(entity, { attrs: {} }).from;
  });

  socket.emit("close", false);

  expect(entity.status).toBe("disconnect");
  expect(from).toBe(null);
  expect(entity.jid.toString()).toBe("confirmed@bar/resource");
});

test("confirmed sender remains independent of mutable identity hints", () => {
  const entity = {
    jid: new JID("confirmed@bar/resource"),
    options: { domain: "bar" },
  };
  resetConnection(entity);
  confirmIdentity(entity, entity.jid);
  entity.jid = new JID("changed@other/resource");
  entity.options.domain = "other";

  const ctx = new Context(entity, { attrs: {} });
  expect(ctx.from).toEqual(new JID("confirmed@bar"));
});

test("sets the to property", () => {
  const entity = { jid: new JID("foo@bar"), options: { domain: "bar" } };
  const ctx = new Context(entity, { attrs: { to: "foo@bar" } });
  expect(ctx.to).toEqual(new JID("foo@bar"));
});

test("to property defaults to incoming stanza to attribute", () => {
  const entity = { jid: new JID("foo@bar"), options: { domain: "bar" } };
  const ctx = new Context(entity, { attrs: { to: "hello" } });
  expect(ctx.to).toEqual(new JID("hello"));
});

test("sets the local property to from.local", () => {
  const entity = { jid: new JID("foo@bar"), options: { domain: "bar" } };
  const ctx = new Context(entity, { attrs: { from: "foo@bar" } });
  expect(ctx.local).toEqual("foo");
});

test("local property defaults to empty string", () => {
  const ctx = new Context({}, { attrs: { from: "bar" } });
  expect(ctx.local).toEqual("");
});

test("sets the domain property to from.domain", () => {
  const entity = { jid: new JID("foo@bar") };
  const ctx = new Context(entity, { attrs: { from: "foo@bar" } });
  expect(ctx.domain).toEqual("bar");
});

test("sets the resource property to from.resource", () => {
  const entity = { jid: new JID("foo@bar/test") };
  const ctx = new Context(entity, { attrs: { from: "foo@bar/test" } });
  expect(ctx.resource).toEqual("test");
});

test("resource property defaults to empty string", () => {
  const ctx = new Context({}, { attrs: { from: "foo@bar" } });
  expect(ctx.resource).toEqual("");
});
