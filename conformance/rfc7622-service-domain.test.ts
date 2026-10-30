import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { ClientOptions } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const FOREIGN = "urn:example:service-inference";
const TIMEOUT_MS = 500;

// Inference is library policy; RFC 7622 §3.2 preparation follows raw host
// extraction. IPvFuture remains a JID-domain syntax, not a supported URL claim.
test.each([
  ["ws://[::1]", "[::1]"],
  ["wss://[::1]", "[::1]"],
  ["wss://[::1]:/xmpp", "[::1]"],
  ["ws://[::1]:5280/xmpp-websocket", "[::1]"],
  ["wss://[::1]:5281/xmpp-websocket", "[::1]"],
  ["ws://[0:0:0:0:0:0:0:1]/xmpp", "[::1]"],
  ["wss://[2001:0DB8:0:0:0:0:0:1]:5281/xmpp", "[2001:db8::1]"],
  ["ws://[::ffff:192.0.2.1]:5280/xmpp", "[::ffff:c000:201]"],
  ["[::1]:5280", "[::1]"],
  ["xmpp://[v1.A:0]:5222/xmpp", "[v1.a:0]"],
  ["wss://EXAMPLE.TEST:5281/xmpp", "example.test"],
  ["ws://192.0.2.1:5280/xmpp", "192.0.2.1"],
  ["xmpp://BÜCHER.example:5222/xmpp", "bücher.example"],
  ["BÜCHER.example:5222/xmpp", "bücher.example"],
  ["wss://EXAMPLE.TEST?ticket=a:b", "example.test"],
  ["wss://EXAMPLE.TEST?ticket=ws://other.test", "example.test"],
] as const)(
  "RFC 3986 §3.2.2 / RFC 7622 §3.2 local inference: public factory accepts %s",
  (service, domain) => {
    let xmpp: ReturnType<typeof client> | undefined;
    expect(() => {
      xmpp = client({ service });
    }).not.toThrow();
    expect((xmpp!.options as ClientOptions).domain).toBe(domain);
    xmpp!.reconnect.stop();
  },
);

test.each([
  "ws://[::1/xmpp",
  "wss://[]:5281/xmpp",
  "ws://[not-ip]:5280/xmpp",
  "ws://[::1]]:5280/xmpp",
  "wss://[::1]suffix:5281/xmpp",
  "ws://[::1]:5280extra/xmpp",
  "wss://[::1]:5281:5282/xmpp",
])(
  "local inference: malformed bracket authority cannot become a valid factory domain / %s",
  (service) => {
    expect(() => client({ service })).toThrow(TypeError);
  },
);

test("local inference: an explicit prepared domain overrides an IPv6 endpoint host", () => {
  const xmpp = client({
    service: "wss://[::1]:5281/xmpp",
    domain: "XN--BCHER-KVA.example.",
  });
  xmpp.reconnect.stop();
  expect((xmpp.options as ClientOptions).domain).toBe("bücher.example");
});

// The endpoint under test supplies only the original inference input. Actual
// traffic uses a local IPv4 peer: this does not certify IPv6 connectivity/TLS.
test.each([
  ["ws://[::1]:5280/xmpp", "[::1]"],
  ["wss://[2001:0DB8:0:0:0:0:0:1]:5281/xmpp", "[2001:db8::1]"],
  ["ws://[::ffff:192.0.2.1]:5280/xmpp", "[::ffff:c000:201]"],
] as const)(
  "RFC 7622 §3.2 local inference: prepared target reaches the wire after rejected local opening / %s",
  async (service, domain) => {
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open")) {
        remote.send(
          `<open xmlns="${FRAMING}" from="${domain}" version="1.0" id="service-domain"/>`,
        );
      } else if (frame.startsWith("<close")) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
    const errors: Error[] = [];
    let xmpp: ReturnType<typeof client> | undefined;
    try {
      expect(() => {
        xmpp = client({ service, timeout: TIMEOUT_MS });
      }).not.toThrow();
      xmpp!.reconnect.stop();
      xmpp!.on("error", (error: Error) => errors.push(error));
      await xmpp!.connect(peer.url);
      await expect(xmpp!.open({ domain: "[" })).rejects.toThrow(TypeError);
      expect(peer.transcript).toEqual([]);
      expect((xmpp!.options as ClientOptions).domain).toBe(domain);
      await xmpp!.open(xmpp!.options);
      expect(readFrame(await peer.next())[0]).toEqual({
        open: `{${FRAMING}}open`,
        attributes: { "{}to": domain, "{}version": "1.0" },
      });
      await xmpp!.send(xml("notice", { xmlns: FOREIGN, id: "recovered" }));
      expect(readFrame(await peer.next())[0]).toEqual({
        open: `{${FOREIGN}}notice`,
        attributes: { "{}id": "recovered" },
      });
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp?.stop();
      await peer.stop();
    }
  },
);
