import { EventEmitter } from "../../events/index.js";
import xml from "../../xml/index.js";

import Connection from "../index.js";

const NS_JABBER_CLIENT = "jabber:client";

test("new Connection()", () => {
  const conn = new Connection();
  expect(conn.jid).toBe(null);
  expect(conn.timeout).toBe(2000);
  expect(conn instanceof EventEmitter).toBe(true);
});

test("new Connection() with custom timeout", () => {
  const conn = new Connection({timeout:1234});
  expect(conn.jid).toBe(null);
  expect(conn.timeout).toBe(1234);
  expect(conn instanceof EventEmitter).toBe(true);
});

test("new Connection() with unexpected input", () => {
  const conn = new Connection(1234);
  expect(conn.jid).toBe(null);
  expect(conn.timeout).toBe(2000);
  expect(conn instanceof EventEmitter).toBe(true);
});

test("isStanza()", () => {
  const conn = new Connection();
  conn.NS = NS_JABBER_CLIENT;

  expect(conn.isStanza(xml("foo"))).toBe(false);

  for (const name of ["presence", "iq", "message"]) {
    expect(conn.isStanza(xml(name, { xmlns: NS_JABBER_CLIENT }))).toBe(true);
    expect(conn.isStanza(xml(name))).toBe(false);
    expect(conn.isStanza(xml(name, { xmlns: "urn:test:extension" }))).toBe(
      false,
    );
  }
});

test("isNonza()", () => {
  const conn = new Connection();
  conn.NS = NS_JABBER_CLIENT;

  expect(conn.isNonza(xml("foo"))).toBe(true);

  for (const name of ["presence", "iq", "message"]) {
    expect(conn.isNonza(xml(name, { xmlns: NS_JABBER_CLIENT }))).toBe(false);
    expect(conn.isNonza(xml(name))).toBe(true);
    expect(conn.isNonza(xml(name, { xmlns: "urn:test:extension" }))).toBe(true);
  }
});
