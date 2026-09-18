import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import xml from "../src/xml/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const CONTENT = "jabber:client";
const PING = '<ping xmlns="urn:xmpp:ping"/>';
const ERROR = `<error type="cancel"><service-unavailable xmlns="${STANZAS}"/></error>`;

// IQ-layer wire tests. Authentication/binding are covered separately; these
// requests target the connected server, allowed during negotiation (§4.3.5).
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
        `<open xmlns="${FRAMING}" from="example.test" id="iq" version="1.0"/>`,
      );
    } else if (frame.startsWith("<close")) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    } else {
      reply?.(frame, remote);
    }
  });
  const xmpp = client({ service: peer.url, domain: "example.test" });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    await xmpp.connect(peer.url);
    await xmpp.open({ domain: "example.test" });
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
  ["get", 'id="ping"', PING, "result", undefined],
  ["set", 'id="set"', '<query xmlns="urn:test:known"/>', "result", undefined],
  [
    "get",
    'id="unknown"',
    '<query xmlns="urn:test:unknown"/>',
    "error",
    "service-unavailable",
  ],
  ["invalid", 'id="type"', PING, "error", "bad-request"],
  [undefined, 'id="type"', PING, "error", "bad-request"],
  ["get", 'id="empty"', "", "error", "bad-request"],
  ["get", 'id="many"', PING + PING, "error", "bad-request"],
  ["get", "", PING, "error", "bad-request"],
  ["get", 'id="error-child"', ERROR, "error", "bad-request"],
] as const)(
  "RFC 6120 §§8.2.3/8.3: request %s %s",
  async (type, id, payload, expectedType, condition) => {
    await session(async (xmpp, peer) => {
      xmpp.iqCallee.set("urn:test:known", "query", () => true);
      peer.send(
        `<iq xmlns="${CONTENT}" from="example.test" to="user@example.test/r" ${id} ${type ? `type="${type}"` : ""}>${payload}</iq>`,
      );
      const events = readFrame(await peer.next());
      expect(events[0]).toEqual({
        open: `{${CONTENT}}iq`,
        attributes: {
          "{}type": expectedType,
          "{}id": id ? id.slice(4, -1) : "",
          "{}to": "example.test",
          "{}from": "user@example.test/r",
        },
      });
      if (condition) {
        expect(events).toContainEqual({
          open: `{${STANZAS}}${condition}`,
          attributes: {},
        });
        expect(
          events.filter(
            (event) => "open" in event && event.open === `{${CONTENT}}error`,
          ),
        ).toHaveLength(1);
      } else {
        expect(events).toHaveLength(2);
      }
    });
  },
);

test.each(["result", "error"])(
  "RFC 6120 §§8.2.3/8.3.1: no response loop for %s",
  async (type) => {
    await session(async (_xmpp, peer) => {
      for (const kind of ["iq", "message", "presence"]) {
        peer.send(
          `<${kind} xmlns="${CONTENT}" type="${type}" id="unsolicited">${ERROR}</${kind}>`,
        );
      }
      // A following ping is an ordering barrier, not a timing-based absence test.
      peer.send(`<iq xmlns="${CONTENT}" type="get" id="barrier">${PING}</iq>`);
      expect(readFrame(await peer.next())[0]).toEqual({
        open: `{${CONTENT}}iq`,
        attributes: { "{}type": "result", "{}id": "barrier" },
      });
      expect(
        peer.transcript.filter((frame) => !frame.startsWith("<open")),
      ).toHaveLength(1);
    });
  },
);

test.each(["", '<value xmlns="urn:test:value"/>'])(
  "RFC 6120 §8.2.3: accept result payload %s",
  async (payload) => {
    await session(
      async (xmpp) => {
        const result = await xmpp.iqCaller.request(
          xml(
            "iq",
            { type: "get", id: "request" },
            xml("query", "urn:test:query"),
          ),
        );
        expect(result.attrs.id).toBe("request");
        expect(result.getChildElements()).toHaveLength(payload ? 1 : 0);
      },
      (_frame, peer) =>
        peer.send(
          `<iq xmlns="${CONTENT}" type="result" id="request">${payload}</iq>`,
        ),
    );
  },
);

test.each([
  ["two result payloads", "result", PING + PING],
  ["error in result", "result", ERROR],
  ["missing error", "error", ""],
  [
    "wrong error namespace",
    "error",
    `<error xmlns="urn:wrong" type="cancel"><service-unavailable xmlns="${STANZAS}"/></error>`,
  ],
  ["duplicate error", "error", ERROR + ERROR],
  ["missing condition", "error", '<error type="cancel"/>'],
  [
    "foreign condition",
    "error",
    '<error type="cancel"><forbidden xmlns="urn:wrong"/></error>',
  ],
  [
    "two conditions",
    "error",
    `<error type="cancel"><forbidden xmlns="${STANZAS}"/><conflict xmlns="${STANZAS}"/></error>`,
  ],
  [
    "invalid error type",
    "error",
    `<error type="unknown"><forbidden xmlns="${STANZAS}"/></error>`,
  ],
] as const)(
  "RFC 6120 §§8.2.3/8.3: reject malformed correlated reply / %s",
  async (_name, type, payload) => {
    await session(
      async (xmpp, peer) => {
        const result = await xmpp.iqCaller
          .request(
            xml(
              "iq",
              { type: "get", id: "request" },
              xml("query", "urn:test:query"),
            ),
            200,
          )
          .catch((error: Error) => error);
        // Local fail-closed policy: malformed replies reject, never succeed, time
        // out, throw parser TypeErrors, or elicit a reply to an error/result.
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toMatch(/^Invalid (IQ response|stanza error)$/);
        expect(xmpp.iqCaller.handlers.size).toBe(0);
        peer.send(
          `<iq xmlns="${CONTENT}" type="get" id="after-error">${PING}</iq>`,
        );
        await peer.next(); // original request
        expect(readFrame(await peer.next())[0]).toEqual({
          open: `{${CONTENT}}iq`,
          attributes: { "{}id": "after-error", "{}type": "result" },
        });
      },
      (frame, peer) => {
        if (frame.includes('id="request"')) {
          peer.send(
            `<iq xmlns="${CONTENT}" type="${type}" id="request">${payload}</iq>`,
          );
        }
      },
    );
  },
);

test.each(["forbidden", "future-condition"])(
  "RFC 6120 §8.3.2: namespaced stanza error / %s",
  async (condition) => {
    await session(
      async (xmpp) => {
        const result = await xmpp.iqCaller
          .request(
            xml(
              "iq",
              { type: "set", id: "request" },
              xml("query", "urn:test:query"),
            ),
          )
          .catch((error: Error) => error);
        expect(result.name).toBe("StanzaError");
        expect(result.condition).toBe(
          condition === "forbidden" ? condition : "undefined-condition",
        );
        expect(result.type).toBe("auth");
        expect(result.text).toBe("Explanation");
        expect(result.application.getNS()).toBe("urn:test:application");
      },
      (_frame, peer) =>
        peer.send(
          `<iq xmlns="${CONTENT}" type="error" id="request"><error type="auth"><text xmlns="${STANZAS}" xml:lang="en">Explanation</text><text xmlns="urn:test:application"/><${condition} xmlns="${STANZAS}"/></error></iq>`,
        ),
    );
  },
);
