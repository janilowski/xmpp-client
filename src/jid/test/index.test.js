import { test, expect, spyOn } from "bun:test";

import jid, { equal, jid as namedJid, JID } from "../index.js";

const factories = [
  ["default", jid],
  ["named", namedJid],
  ["default .jid", jid.jid],
];

test("equal calls equals on the first argument with the second argument", () => {
  const A = jid("foo");
  const B = jid("bar");
  const spy_equals = spyOn(A, "equals");
  equal(A, B);
  expect(spy_equals).toHaveBeenCalledWith(B);
});

test("JID exports lib/JID", () => {
  expect(jid.JID).toBe(JID);
});

test("calls parse if only first argument provided", () => {
  const addr = jid("foo@bar");
  expect(addr instanceof JID).toBe(true);
  expect(addr.toString()).toBe("foo@bar");
});

test("calls JID with passed arguments", () => {
  const addr = jid("foo", "bar", "baz");
  expect(addr instanceof JID).toBe(true);
  expect(addr.toString()).toBe("foo@bar/baz");
});

test("works as expected with new operator", () => {
  const addr = new jid("foo", "bar", "baz");
  expect(addr instanceof JID).toBe(true);
  expect(addr.toString()).toBe("foo@bar/baz");
});

for (const [name, factory] of factories) {
  test(`${name} export dispatches by overload arity`, () => {
    expect(factory("example.com").toString()).toBe("example.com");
    expect(factory("user@example.com/r").toString()).toBe(
      "user@example.com/r",
    );
    expect(new factory("user@example.com/r").toString()).toBe(
      "user@example.com/r",
    );
    expect(factory(null, "example.com", "r").toString()).toBe("example.com/r");
    expect(factory("user", "example.com").toString()).toBe("user@example.com");
    expect(factory("user", "example.com", null).toString()).toBe(
      "user@example.com",
    );
    expect(factory("user", "example.com", undefined).toString()).toBe(
      "user@example.com",
    );
    expect(factory("user", "example.com", "r").toString()).toBe(
      "user@example.com/r",
    );
    expect(new factory("user", "example.com").toString()).toBe(
      "user@example.com",
    );

    // RFC 7622 §3.2: an explicit domainpart cannot be empty or absent.
    for (const args of [
      ["user", ""],
      ["user", "", undefined],
      ["user", null],
      ["user", undefined],
    ]) {
      expect(() => factory(...args)).toThrow(TypeError);
      expect(() => new factory(...args)).toThrow(TypeError);
    }
  });
}
