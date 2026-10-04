import { expect, test } from "bun:test";
import { once } from "node:events";
import { client, xml } from "../src/client/index.js";
import { Element as XmlElement } from "../src/xml/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CLIENT = "jabber:client";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const FOREIGN = "urn:example:namespace-scope";
const BAD_MECHANISM = "BAD-SCOPE";
const GOOD_MECHANISM = "GOOD-SCOPE";
const TIMEOUT_MS = 500;

// IQs target only the connected server: RFC 6120 §4.3.5 allows this pre-binding.
async function session(
  exercise: (
    xmpp: ReturnType<typeof client>,
    peer: ScriptedPeer,
  ) => Promise<void>,
  reply?: (frame: string, peer: ScriptedPeer) => void,
) {
  const peer = new ScriptedPeer((frame, remote) => {
    if (frame.startsWith("<open")) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="scope" version="1.0"/>`,
      );
    } else if (frame.startsWith("<close")) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    } else {
      reply?.(frame, remote);
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
    await xmpp.open(xmpp.options);
    await peer.next();
    await exercise(xmpp, peer);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
}

test.each([
  [
    "cancelled error",
    "error",
    `<error xmlns="" type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
    "Invalid IQ response",
    "",
  ],
  [
    "cancelled condition",
    "error",
    `<error type="cancel"><forbidden xmlns=""/></error>`,
    "Invalid stanza error",
    CLIENT,
  ],
  [
    "empty-namespace result payload",
    "result",
    `<error xmlns=""><data/></error>`,
    "result",
    "",
  ],
  [
    "foreign result payload",
    "result",
    `<error xmlns="${FOREIGN}"><data/></error>`,
    "result",
    FOREIGN,
  ],
  [
    "client error",
    "error",
    `<error type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
    "forbidden",
    CLIENT,
  ],
  [
    "qualified condition unaffected by default cancellation",
    "error",
    `<error xmlns:s="${STANZAS}" type="cancel"><s:forbidden xmlns=""/><s:text>Denied</s:text></error>`,
    "forbidden",
    CLIENT,
  ],
] as const)(
  "Namespaces in XML §6.2 / RFC 6120 §§4.8,8.3: correlated IQ respects scope / %s",
  async (_name, type, payload, expected, namespace) => {
    const response = `<iq xmlns="${CLIENT}" type="${type}" id="scope-request">${payload}</iq>`;
    const expanded = readFrame(response).filter((event) => "open" in event);
    expect(expanded[1]).toMatchObject({ open: `{${namespace}}error` });
    await session(
      async (xmpp, peer) => {
        const result = await xmpp.iqCaller
          .request(
            xml(
              "iq",
              { type: "get", id: "scope-request" },
              xml("query", { xmlns: FOREIGN }),
            ),
          )
          .catch((error: Error) => error);
        if (expected === "result") {
          expect(result).toBeInstanceOf(XmlElement);
          const stanza = result as Element;
          expect(stanza.attrs.type).toBe("result");
          expect(stanza.getChildElements()[0]?.getNS()).toBe(namespace);
        } else if (expected === "forbidden") {
          expect(result).toMatchObject({
            name: "StanzaError",
            condition: "forbidden",
          });
        } else {
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).message).toBe(expected);
          expect(result.name).not.toBe("StanzaError");
        }
        expect(xmpp.iqCaller.handlers.size).toBe(0);
        await xmpp.send(xml("message", { id: "barrier" }));
        expect(readFrame(await peer.next())[0]).toMatchObject({
          attributes: { "{}id": "scope-request" },
        });
        expect(readFrame(await peer.next())[0]).toMatchObject({
          attributes: { "{}id": "barrier" },
        });
        expect(peer.transcript).toHaveLength(3);
      },
      (frame, peer) => {
        if (frame.includes('id="scope-request"')) {
          peer.send(response);
        }
      },
    );
  },
);

test("Namespaces in XML §6.2 / RFC 6120 §8.2.3: cancelled IQ payload cannot invoke its former namespace handler", async () => {
  await session(async (xmpp, peer) => {
    let calls = 0;
    xmpp.iqCallee.get(CLIENT, "query", () => {
      calls += 1;
      return true;
    });
    for (const [id, declaration, expected] of [
      ["cancelled", ' xmlns=""', "error"],
      ["inherited", "", "result"],
      ["restored", ` xmlns="${CLIENT}"`, "result"],
    ] as const) {
      peer.send(
        `<iq xmlns="${CLIENT}" type="get" from="example.test" id="${id}"><query${declaration}/></iq>`,
      );
      const events = readFrame(await peer.next());
      expect(events[0]).toMatchObject({
        attributes: { "{}id": id, "{}type": expected },
      });
      if (id === "cancelled") {
        expect(calls).toBe(0);
        expect(events).toContainEqual({
          open: `{${STANZAS}}service-unavailable`,
          attributes: {},
        });
        expect(events).toContainEqual({ open: "{}query", attributes: {} });
      }
    }
    expect(calls).toBe(2);
  });
});

test("Namespaces in XML §6.2 / RFC 6120 §4.8: delivered descendants cancel, restore and isolate default namespace scope", async () => {
  await session(async (xmpp, peer) => {
    let stanza: Element | undefined;
    xmpp.once("stanza", (element: Element) => {
      stanza = element;
    });
    const barrier = once(xmpp, "nonza", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    peer.send(
      `<message xmlns="${CLIENT}" xmlns:p="${FOREIGN}"><extra xmlns=""><plain/><restored xmlns="${FOREIGN}"><inside/><cancel xmlns=""><leaf/><p:qualified/></cancel><sibling/></restored><plain/></extra><after/><p:after/></message>`,
    );
    peer.send(`<barrier xmlns="${FOREIGN}"/>`);
    await barrier;
    expect(stanza).toBeInstanceOf(XmlElement);
    const extra = stanza!.getChild("extra")!;
    expect(extra.getNS()).toBe("");
    expect(extra.getChild("plain")?.getNS()).toBe("");
    const restored = extra.getChild("restored", FOREIGN)!;
    expect(restored.getChild("inside")?.getNS()).toBe(FOREIGN);
    const cancelled = restored.getChild("cancel")!;
    expect(cancelled.getNS()).toBe("");
    expect(cancelled.getChild("leaf")?.getNS()).toBe("");
    expect(cancelled.getChild("qualified", FOREIGN)?.getNS()).toBe(FOREIGN);
    expect(restored.getChild("sibling")?.getNS()).toBe(FOREIGN);
    expect(
      extra.getChildren("plain").map((element: Element) => element.getNS()),
    ).toEqual(["", ""]);
    expect(stanza!.getChild("after", CLIENT)?.getNS()).toBe(CLIENT);
    expect(stanza!.getChild("after", FOREIGN)?.getNS()).toBe(FOREIGN);
  });
});

for (const namespace of [SASL, SASL2]) {
  test.each(["cancelled-only", "valid-sibling"] as const)(
    `Namespaces in XML §6.2 / RFC 6120 §6.4.1 / XEP-0388 §2.1: ${namespace} mechanism dispatch honors cancellation / %s`,
    async (offer) => {
      let authenticated = false;
      const peer = new ScriptedPeer((frame, remote) => {
        const root = readFrame(frame)[0];
        if (!root || !("open" in root)) {
          throw new Error("Expected a client element");
        }
        if (root.open === `{${FRAMING}}open`) {
          remote.send(
            `<open xmlns="${FRAMING}" from="example.test" id="scope-auth" version="1.0"/>`,
          );
          remote.send(
            authenticated
              ? `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/></features>`
              : `<features xmlns="${STREAM}"><${namespace === SASL ? "mechanisms" : "authentication"} xmlns="${namespace}"><mechanism xmlns="">${BAD_MECHANISM}</mechanism>${offer === "valid-sibling" ? `<mechanism>${GOOD_MECHANISM}</mechanism>` : ""}</${namespace === SASL ? "mechanisms" : "authentication"}></features>`,
          );
        } else if (
          root.open === `{${namespace}}auth` ||
          root.open === `{${namespace}}authenticate`
        ) {
          if (root.attributes["{}mechanism"] === BAD_MECHANISM) {
            remote.send(
              `<failure xmlns="${namespace}"><not-authorized/></failure>`,
            );
          } else {
            authenticated = true;
            remote.send(
              namespace === SASL
                ? `<success xmlns="${SASL}"/>`
                : `<success xmlns="${SASL2}"><authorization-identifier>user@example.test</authorization-identifier></success>`,
            );
            if (namespace === SASL2) {
              remote.send(
                `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/></features>`,
              );
            }
          }
        } else if (root.open === `{${CLIENT}}iq`) {
          remote.send(
            `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
          );
        } else if (root.open === `{${FRAMING}}close`) {
          remote.send(`<close xmlns="${FRAMING}"/>`);
        }
      });
      let selected: string[] = [];
      let calls = 0;
      const xmpp = client({
        service: peer.url,
        domain: "example.test",
        timeout: TIMEOUT_MS,
        credentials: async (
          authenticate: (
            credentials: object,
            mechanism: string,
          ) => Promise<void>,
          mechanisms: string[],
        ) => {
          calls += 1;
          selected = mechanisms;
          await authenticate({}, mechanisms[0]!);
        },
      });
      xmpp.reconnect.stop();
      for (const name of [BAD_MECHANISM, GOOD_MECHANISM]) {
        xmpp.saslMechanisms.register(name, () => ({
          name,
          clientFirst: true,
          response: () => "",
        }));
      }
      const errors: Error[] = [];
      xmpp.on("error", (error: Error) => errors.push(error));
      try {
        const result = await xmpp.start().catch((error: Error) => error);
        if (offer === "cancelled-only") {
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).message).toBe(
            "SASL: No compatible mechanism available.",
          );
          expect(calls).toBe(0);
          await peer.waitForClose();
        } else {
          expect(result.toString()).toBe("user@example.test/r");
          expect(selected).toEqual([GOOD_MECHANISM]);
          expect(calls).toBe(1);
          expect(errors).toEqual([]);
        }
        expect(
          peer.transcript.some((frame) =>
            frame.includes(`mechanism="${BAD_MECHANISM}"`),
          ),
        ).toBe(false);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}
