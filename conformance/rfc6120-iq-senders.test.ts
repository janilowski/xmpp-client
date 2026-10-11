import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const CLIENT = "jabber:client";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const SERVER = "example.test";
const ACCOUNT = "real@example.test";
const FULL_JID = `${ACCOUNT}/device`;
const FORGED_SERVER = "attacker.test";
const FORGED_ACCOUNT = `forged@${FORGED_SERVER}`;
const PING = '<ping xmlns="urn:xmpp:ping"/>';
const TIMEOUT_MS = 1000;

type Phase = "bound" | "pre-auth";
type Reply = "result" | "error";

async function nextIQ(peer: ScriptedPeer, id: string) {
  while (true) {
    const events = readFrame(await peer.next());
    const root = events[0];
    if (
      root &&
      "open" in root &&
      root.open === `{${CLIENT}}iq` &&
      root.attributes["{}id"] === id
    ) {
      return events;
    }
  }
}

// RFC 6120 §§4.3.6/8.1.2.1: the opened server and assigned account are distinct.
async function session(
  phase: Phase,
  exercise: (
    xmpp: ReturnType<typeof client>,
    peer: ScriptedPeer,
  ) => Promise<void>,
  fullJID = FULL_JID,
) {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const events = readFrame(frame);
    const root = events[0];
    if (!root || !("open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="${SERVER}" id="iq-senders" version="1.0"/>`,
      );
      if (phase === "bound") {
        remote.send(
          `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
        );
      }
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (
      root.open === `{${CLIENT}}iq` &&
      events.some((event) => "open" in event && event.open === `{${BIND}}bind`)
    ) {
      remote.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${fullJID}</jid></bind></iq>`,
      );
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: SERVER,
    ...(phase === "bound"
      ? { username: "configured", password: "secret" }
      : {}),
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    if (phase === "bound") {
      expect((await xmpp.start()).toString()).toBe(fullJID);
    } else {
      await xmpp.connect(peer.url);
      await xmpp.open({ domain: SERVER });
      expect(xmpp.status).toBe("open");
    }
    await exercise(xmpp, peer);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
}

function reply(type: Reply, from?: string) {
  return `<iq xmlns="${CLIENT}" type="${type}" id="request"${from === undefined ? "" : ` from="${from}"`}>${type === "error" ? `<error type="cancel"><service-unavailable xmlns="${STANZAS}"/></error>` : '<verified xmlns="urn:test:reply"/>'}</iq>`;
}

// A reply to a following ping proves the forged IQ reached the preceding route.
async function barrier(peer: ScriptedPeer) {
  peer.send(
    `<iq xmlns="${CLIENT}" type="get" id="barrier" from="${SERVER}">${PING}</iq>`,
  );
  expect((await nextIQ(peer, "barrier"))[0]).toEqual({
    open: `{${CLIENT}}iq`,
    attributes: { "{}id": "barrier", "{}type": "result", "{}to": SERVER },
  });
  await setImmediate();
}

// Sender correlation is local security policy derived from §§8.1.2.1/8.2.3/8.3.1,
// not an RFC-defined matching algorithm. Public JID/options do not grant authority.
for (const type of ["result", "error"] as const) {
  for (const timing of ["before request", "after request"] as const) {
    for (const forged of [FORGED_ACCOUNT, FORGED_SERVER]) {
      test.each(["account", "server", "absent"] as const)(
        `RFC 6120 §§4.3.6/8.1.2.1/8.2.3: ignore forged ${type} from ${forged} after public JID mutation ${timing}; accept %s`,
        async (source) => {
          await session("bound", async (xmpp, peer) => {
            if (timing === "before request") {
              xmpp.jid!.setLocal("forged");
              xmpp.jid!.setDomain(FORGED_SERVER);
              xmpp.jid!.setResource("public-hint");
            }
            let settled = false;
            const outcome = xmpp.iqCaller
              .request(
                xml(
                  "iq",
                  { type: "get", id: "request" },
                  xml("query", "urn:test:request"),
                ),
                TIMEOUT_MS,
              )
              .then(
                (stanza) => {
                  settled = true;
                  return { kind: "result", stanza } as const;
                },
                (error: Error & { condition?: string }) => {
                  settled = true;
                  return { kind: "error", error } as const;
                },
              );
            if (timing === "after request") {
              xmpp.jid!.setLocal("forged");
              xmpp.jid!.setDomain(FORGED_SERVER);
              xmpp.jid!.setResource("public-hint");
              Object.assign(xmpp.options, { domain: FORGED_SERVER });
            }
            expect((await nextIQ(peer, "request"))[0]).toEqual({
              open: `{${CLIENT}}iq`,
              attributes: { "{}type": "get", "{}id": "request" },
            });
            peer.send(reply(type, forged));
            await barrier(peer);
            expect(settled).toBe(false);
            const from =
              source === "account"
                ? ACCOUNT
                : source === "server"
                  ? SERVER
                  : undefined;
            peer.send(reply(type, from));
            await barrier(peer);
            // Assert actual settlement before awaiting, so a broken identity fails by assertion.
            expect(settled).toBe(true);
            const result = await outcome;
            expect(result.kind).toBe(type);
            if (result.kind === "result") {
              expect(result.stanza.attrs.from).toBe(from);
              expect(
                result.stanza.getChild("verified", "urn:test:reply"),
              ).toBeDefined();
            } else {
              expect(result.error.name).toBe("StanzaError");
              expect(result.error.condition).toBe("service-unavailable");
            }
            expect(xmpp.status).toBe("online");
          });
        },
      );
    }
  }
}

for (const type of ["result", "error"] as const) {
  test.each(["before request", "after request"] as const)(
    `RFC 6120 §§4.3.5/8.1.2.1/8.2.3: pre-auth no-to ${type} uses the opened server after options mutation %s`,
    async (timing) => {
      await session("pre-auth", async (xmpp, peer) => {
        if (timing === "before request") {
          Object.assign(xmpp.options, { domain: FORGED_SERVER });
        }
        let settled = false;
        const outcome = xmpp.iqCaller
          .request(
            xml(
              "iq",
              { type: "get", id: "request" },
              xml("query", "urn:test:request"),
            ),
            TIMEOUT_MS,
          )
          .then(
            (stanza) => {
              settled = true;
              return { kind: "result", stanza } as const;
            },
            (error: Error & { condition?: string }) => {
              settled = true;
              return { kind: "error", error } as const;
            },
          );
        if (timing === "after request") {
          Object.assign(xmpp.options, { domain: FORGED_SERVER });
        }
        expect((await nextIQ(peer, "request"))[0]).toEqual({
          open: `{${CLIENT}}iq`,
          attributes: { "{}type": "get", "{}id": "request" },
        });
        peer.send(reply(type, FORGED_SERVER));
        await barrier(peer);
        expect(settled).toBe(false);
        peer.send(reply(type, SERVER));
        await barrier(peer);
        expect(settled).toBe(true);
        const result = await outcome;
        expect(result.kind).toBe(type);
        if (result.kind === "result") {
          expect(result.stanza.attrs.from).toBe(SERVER);
        } else {
          expect(result.error.name).toBe("StanzaError");
          expect(result.error.condition).toBe("service-unavailable");
        }
        expect(xmpp.status).toBe("open");
      });
    },
  );
}

test.each([
  ["result", SERVER],
  ["result", "real@assigned.test"],
  ["error", SERVER],
  ["error", "real@assigned.test"],
] as const)(
  "RFC 6120 §8.1.2.1: assigned account domain does not replace the connected IQ server / %s from %s",
  async (type, from) => {
    await session(
      "bound",
      async (xmpp, peer) => {
        let settled = false;
        const outcome = xmpp.iqCaller
          .request(
            xml(
              "iq",
              { type: "get", id: "request" },
              xml("query", "urn:test:request"),
            ),
            TIMEOUT_MS,
          )
          .then(
            (stanza) => {
              settled = true;
              return { kind: "result", stanza } as const;
            },
            (error: Error & { condition?: string }) => {
              settled = true;
              return { kind: "error", error } as const;
            },
          );
        await nextIQ(peer, "request");
        peer.send(reply(type, "assigned.test"));
        await barrier(peer);
        expect(settled).toBe(false);
        peer.send(reply(type, from));
        await barrier(peer);
        expect(settled).toBe(true);
        const result = await outcome;
        expect(result.kind).toBe(type);
        if (result.kind === "result") {
          expect(result.stanza.attrs.from).toBe(from);
        } else {
          expect(result.error.name).toBe("StanzaError");
          expect(result.error.condition).toBe("service-unavailable");
        }
        expect(xmpp.jid?.toString()).toBe("real@assigned.test/device");
      },
      "real@assigned.test/device",
    );
  },
);

for (const type of ["result", "error"] as const) {
  test.each([
    [SERVER, true],
    [ACCOUNT, true],
    [FORGED_SERVER, false],
    [FORGED_ACCOUNT, false],
  ] as const)(
    `RFC 6120 §8.1.2.1: missing-from ${type} after public JID mutation / to=%s`,
    async (to, accepted) => {
      await session("bound", async (xmpp, peer) => {
        xmpp.jid!.setLocal("forged");
        xmpp.jid!.setDomain(FORGED_SERVER);
        xmpp.jid!.setResource("public-hint");
        let settled = false;
        const outcome = xmpp.iqCaller
          .request(
            xml(
              "iq",
              { type: "get", id: "request", to },
              xml("query", "urn:test:request"),
            ),
            TIMEOUT_MS,
          )
          .then(
            (stanza) => {
              settled = true;
              return { kind: "result", stanza } as const;
            },
            (error: Error & { condition?: string }) => {
              settled = true;
              return { kind: "error", error } as const;
            },
          );
        expect((await nextIQ(peer, "request"))[0]).toEqual({
          open: `{${CLIENT}}iq`,
          attributes: { "{}type": "get", "{}id": "request", "{}to": to },
        });
        peer.send(reply(type));
        await barrier(peer);
        expect(settled).toBe(accepted);
        if (!accepted) {
          // A remote request needs its explicit peer, not the connected account default.
          peer.send(reply(type, to));
          await barrier(peer);
          expect(settled).toBe(true);
        }
        const result = await outcome;
        expect(result.kind).toBe(type);
        if (result.kind === "result") {
          expect(result.stanza.attrs.from).toBe(accepted ? undefined : to);
          expect(
            result.stanza.getChild("verified", "urn:test:reply"),
          ).toBeDefined();
        } else {
          expect(result.error.name).toBe("StanzaError");
          expect(result.error.condition).toBe("service-unavailable");
        }
        expect(xmpp.status).toBe("online");
      });
    },
  );
}
