import { expect, test } from "bun:test";
import { once } from "node:events";
import { client } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const XML = "http://www.w3.org/XML/1998/namespace";
const ORIGINAL = "urn:test:original";
const REPLACEMENT = "urn:test:replacement";
const TIMEOUT_MS = 1000;

// RFC 6120 §11.3 / Namespaces in XML 1.0 §§3/6.1/6.2: a consumer of
// real received XML must query its declared attribute namespace, not its prefix.
// This tests the public XML boundary, not authentication or extension authority.
// https://www.w3.org/TR/REC-xml-names/#scoping
const scenarios: {
  name: string;
  body: string;
  verify: (stanza: Element) => void;
}[] = [
  {
    name: "legal __proto__ attribute payload",
    body: '<body __proto__="ordinary"/>',
    verify(stanza) {
      const body = stanza.getChild("body")!;
      expect(Object.hasOwn(body.attrs, "__proto__")).toBe(true);
      expect(body.getAttr("__proto__")).toBe("ordinary");
      expect(body.toString()).toBe('<body __proto__="ordinary"/>');
      expect(Object.getPrototypeOf(body.attrs)).toBe(Object.prototype);
    },
  },
  {
    name: "implicit xml binding",
    body: '<body xml:lang="pl"/>',
    verify(stanza) {
      expect(stanza.getChild("body")?.getAttr("lang", XML)).toBe("pl");
    },
  },
  {
    name: "multiple prefixes for the same namespace",
    body: `<body xmlns:p="${ORIGINAL}" xmlns:q="${ORIGINAL}" p:a="value"/>`,
    verify(stanza) {
      expect(stanza.getChild("body")?.getAttr("a", ORIGINAL)).toBe("value");
    },
  },
  {
    name: "prefix rebinding without ancestor namespace confusion",
    body: `<body xmlns:p="${ORIGINAL}"><value xmlns:p="${REPLACEMENT}" p:a="new"/><sibling p:a="old"/></body>`,
    verify(stanza) {
      const body = stanza.getChild("body")!;
      expect(body.getChild("value")?.getAttr("a", REPLACEMENT)).toBe("new");
      expect(body.getChild("value")?.getAttr("a", ORIGINAL)).toBe(null);
      expect(body.getChild("sibling")?.getAttr("a", ORIGINAL)).toBe("old");
    },
  },
  {
    name: "ordinary hasOwnProperty attribute",
    body: `<body xmlns:p="${ORIGINAL}" hasOwnProperty="ordinary" p:a="value"/>`,
    verify(stanza) {
      const body = stanza.getChild("body")!;
      expect(body.getAttr("hasOwnProperty")).toBe("ordinary");
      expect(() => body.getAttr("a", ORIGINAL)).not.toThrow();
      expect(body.getAttr("a", ORIGINAL)).toBe("value");
    },
  },
  {
    name: "default namespace does not qualify attributes",
    body: `<body xmlns="${ORIGINAL}" xmlns:p="${REPLACEMENT}" a="plain" p:a="qualified"/>`,
    verify(stanza) {
      const body = stanza.getChild("body", ORIGINAL)!;
      expect(body.getAttr("a")).toBe("plain");
      expect(body.getAttr("a", ORIGINAL)).toBe(null);
      expect(body.getAttr("a", REPLACEMENT)).toBe("qualified");
      expect(body.getAttr("missing", REPLACEMENT)).toBeUndefined();
      expect(body.getAttr("missing", "urn:test:unknown")).toBe(null);
    },
  },
];

for (const scenario of scenarios) {
  test(`RFC 6120 §11.3: public stanza consumer preserves ${scenario.name}`, async () => {
    const peer = new ScriptedPeer((frame, remote) => {
      const root = readFrame(frame)[0];
      if ("open" in root && root.open === `{${FRAMING}}open`) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="attributes"/>`,
        );
      } else if ("open" in root && root.open === `{${FRAMING}}close`) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      await xmpp.connect(peer.url);
      await xmpp.open({ domain: "example.test" });
      expect(readFrame(await peer.next())[0]).toMatchObject({
        open: `{${FRAMING}}open`,
      });
      const received = once(xmpp, "stanza", {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      peer.send(
        `<message xmlns="${CONTENT}" id="namespaces">${scenario.body}</message>`,
      );
      const [stanza] = (await received) as [Element];
      expect(stanza.attrs.id).toBe("namespaces");
      scenario.verify(stanza);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  });
}
