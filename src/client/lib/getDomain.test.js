import getDomain from "../lib/getDomain.js";
import jid from "../../jid/index.js";

test("getDomain", () => {
  expect(getDomain("ws://foo:123/foobar")).toBe("foo");
  expect(getDomain("ws://123.156.123.5:123/foobar")).toBe("123.156.123.5");
  expect(getDomain("xmpp://foo:123/foobar")).toBe("foo");
  expect(getDomain("foo")).toBe("foo");
  expect(getDomain("foo:123")).toBe("foo");
  expect(getDomain("foo:123/foobar")).toBe("foo");
});

// Raw host extraction is local inference policy. JID preparation runs later.
// RFC 3986 §3.2.2 brackets keep literal colons distinct from the port separator.
test.each([
  ["ws://[::1]", "[::1]"],
  ["wss://[::1]", "[::1]"],
  ["wss://[::1]:/xmpp", "[::1]"],
  ["ws://[::1]:5280/xmpp-websocket", "[::1]"],
  ["wss://[::1]:5281/xmpp-websocket", "[::1]"],
  ["ws://[0:0:0:0:0:0:0:1]/xmpp", "[0:0:0:0:0:0:0:1]"],
  ["wss://[2001:0DB8:0:0:0:0:0:1]:5281/xmpp", "[2001:0DB8:0:0:0:0:0:1]"],
  ["ws://[::ffff:192.0.2.1]:5280/xmpp", "[::ffff:192.0.2.1]"],
  ["[::1]", "[::1]"],
  ["[::1]:5280", "[::1]"],
  ["[::1]:5280/xmpp", "[::1]"],
  ["xmpp://[v1.A:0]:5222/xmpp", "[v1.A:0]"],
  ["wss://EXAMPLE.TEST:5281/xmpp", "EXAMPLE.TEST"],
  ["ws://192.0.2.1:5280/xmpp", "192.0.2.1"],
  ["ws://127.1:5280/xmpp", "127.1"],
  ["xmpp://BÜCHER.example:5222/xmpp", "BÜCHER.example"],
  ["BÜCHER.example:5222/xmpp", "BÜCHER.example"],
  ["example.test:5222", "example.test"],
  ["wss://EXAMPLE.TEST?ticket=a:b", "EXAMPLE.TEST"],
  ["wss://EXAMPLE.TEST?ticket=ws://other.test", "EXAMPLE.TEST"],
  ["ws://[::1]?ticket=a:b", "[::1]"],
])("extracts the raw host from %s", (service, expected) => {
  expect(getDomain(service)).toBe(expected);
});

test.each([
  "ws://[::1/xmpp",
  "wss://[]:5281/xmpp",
  "ws://[not-ip]:5280/xmpp",
  "ws://[::1]]:5280/xmpp",
  "wss://[::1]suffix:5281/xmpp",
  "ws://[::1]:5280extra/xmpp",
  "wss://[::1]:5281:5282/xmpp",
])(
  "does not infer a valid partial JID domain from malformed brackets/suffix %s",
  (service) => {
    // Either extraction or the existing domain validator may reject the input;
    // silently taking a valid literal prefix would change the intended authority.
    expect(() => jid("", getDomain(service))).toThrow(TypeError);
  },
);
