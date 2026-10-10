import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CLIENT = "jabber:client";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const PING = "urn:xmpp:ping";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const FOREIGN = "urn:test:unknown-extension";
const MAX_NEGOTIATION_FRAMES = 8;
const MAX_OUTCOME_FRAMES = 2;
const ERROR_TYPES = ["auth", "cancel", "continue", "modify", "wait"];
// Independent RFC 6120 §8.3.3 oracle, not the production validator's allowlist.
const ERROR_CONDITIONS = [
  "bad-request",
  "conflict",
  "feature-not-implemented",
  "forbidden",
  "gone",
  "internal-server-error",
  "item-not-found",
  "jid-malformed",
  "not-acceptable",
  "not-allowed",
  "not-authorized",
  "policy-violation",
  "recipient-unavailable",
  "redirect",
  "registration-required",
  "remote-server-not-found",
  "remote-server-timeout",
  "resource-constraint",
  "service-unavailable",
  "subscription-required",
  "undefined-condition",
  "unexpected-request",
].map((condition) => `{${STANZAS}}${condition}`);

async function session() {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!(root && "open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="extended-content"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CLIENT}}iq` && frame.includes(BIND)) {
      remote.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}" id="sm-session" resume="true"/>`);
    } else if (
      root.open === `{${CLIENT}}iq` &&
      root.attributes["{}id"] === "ready"
    ) {
      remote.send(`<iq xmlns="${CLIENT}" type="result" id="ready"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  const disconnects: unknown[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("disconnect", (event: unknown) => disconnects.push(event));
  const enabled = Promise.withResolvers<void>();
  xmpp.on("nonza", (element: { is(name: string, ns: string): boolean }) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    }
  });
  try {
    await xmpp.start();
    await enabled.promise;
    await xmpp.iqCaller.request(
      xml("iq", { id: "ready", type: "get" }, xml("ping", { xmlns: PING })),
    );
    expect(xmpp.streamManagement.enabled).toBe(true);

    const queued = peer.transcript.length;
    expect(queued).toBeLessThanOrEqual(MAX_NEGOTIATION_FRAMES);
    for (let index = 0; index < queued; index += 1) {
      await peer.next();
    }
  } catch (error) {
    await xmpp.stop();
    await peer.stop();
    throw error;
  }
  return { xmpp, peer, errors, disconnects };
}

async function waitForBarrier(peer: ScriptedPeer) {
  for (let index = 0; index < MAX_OUTCOME_FRAMES; index += 1) {
    const frame = await peer.next();
    const root = readFrame(frame)[0];
    if (
      root &&
      "open" in root &&
      root.open === `{${CLIENT}}iq` &&
      root.attributes["{}id"] === "barrier"
    ) {
      return;
    }
  }

  throw new Error("Outcome exceeded the bounded frame allowance");
}

// Stanza errors and conditions are defined by direct-child position, not name alone.
function directChildTrees(
  events: ReturnType<typeof readFrame>,
  parent: string,
) {
  const children: ReturnType<typeof readFrame>[] = [];
  let depth = 0;
  let parentDepth = -1;
  let childStart = -1;
  for (const [index, event] of events.entries()) {
    if ("open" in event) {
      if (parentDepth >= 0 && depth === parentDepth + 1) {
        childStart = index;
      }
      if (parentDepth < 0 && event.open === parent) {
        parentDepth = depth;
      }
      depth += 1;
      continue;
    }
    if ("close" in event) {
      depth -= 1;
      if (childStart >= 0 && depth === parentDepth + 1) {
        children.push(events.slice(childStart, index + 1));
        childStart = -1;
      }
      if (parentDepth >= 0 && depth === parentDepth) {
        break;
      }
    }
  }
  return children;
}

const scenarios = [
  {
    name: "mixed message ignores unknown content",
    id: "mixed-message",
    source: `<message xmlns="${CLIENT}" xmlns:u="${FOREIGN}" u:flag="kept" id="mixed-message" from="romeo@example.net"><body>Hello</body><u:success><u:bind/></u:success></message>`,
    outcome: "none",
  },
  {
    name: "mixed presence ignores unknown content",
    id: "mixed-presence",
    source: `<presence xmlns="${CLIENT}" xmlns:u="${FOREIGN}" u:flag="kept" id="mixed-presence" from="romeo@example.net"><show>away</show><u:enabled><u:a/></u:enabled></presence>`,
    outcome: "none",
  },
  {
    name: "presence treats an unknown-only child as absent",
    id: "unknown-presence",
    source: `<presence xmlns="${CLIENT}" xmlns:u="${FOREIGN}" u:flag="kept" id="unknown-presence"><u:enabled><u:a/></u:enabled></presence>`,
    outcome: "none",
  },
  {
    name: "unknown-only message uses an allowed outcome",
    id: "unknown-message",
    source: `<message xmlns="${CLIENT}" xmlns:u="${FOREIGN}" u:flag="kept" id="unknown-message" from="romeo@example.net"><u:bind><u:success/></u:bind></message>`,
    outcome: "optional-error",
  },
  {
    name: "delayed policy can omit the payload and use modify",
    id: "unknown-message-delayed-policy",
    source: `<message xmlns="${CLIENT}" xmlns:u="${FOREIGN}" u:flag="kept" id="unknown-message-delayed-policy" from="romeo@example.net"><u:bind><u:success/></u:bind></message>`,
    outcome: "application-error",
    error: { type: "modify", echoPayload: false, delayed: true },
  },
  {
    name: "policy can echo the payload and add diagnostics",
    id: "unknown-message-echo-policy",
    source: `<message xmlns="${CLIENT}" xmlns:u="${FOREIGN}" u:flag="kept" id="unknown-message-echo-policy" from="romeo@example.net"><u:bind><u:success/></u:bind></message>`,
    outcome: "application-error",
    error: { type: "cancel", echoPayload: true, delayed: false },
  },
] as const;

for (const scenario of scenarios) {
  test(`RFC 6120 §8.4: ${scenario.name}`, async () => {
    const { id, source } = scenario;
    const { xmpp, peer, errors, disconnects } = await session();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    let handlerCompleted = false;
    xmpp.middleware.use(
      async (context: { id: string }, next: () => Promise<unknown>) => {
        if (context.id !== id) {
          return next();
        }

        const outcome = await next();
        completed.resolve();
        return outcome;
      },
    );
    xmpp.middleware.use(
      async (context: { id: string }, next: () => Promise<unknown>) => {
        if (context.id !== id) {
          return next();
        }

        started.resolve();
        if ("error" in scenario && scenario.error.delayed) {
          await release.promise;
        }

        handlerCompleted = true;
        if (!("error" in scenario)) {
          return next();
        }

        const children = [];
        if (scenario.error.echoPayload) {
          children.push(
            xml("bind", { xmlns: FOREIGN }, xml("success", { xmlns: FOREIGN })),
          );
        }
        children.push(
          xml("error", { type: scenario.error.type }, [
            xml("service-unavailable", { xmlns: STANZAS }),
            xml("text", { xmlns: STANZAS }, "Unsupported extension"),
            xml("detail", { xmlns: FOREIGN }),
          ]),
        );
        return xml(
          "message",
          { to: "romeo@example.net", id, type: "error" },
          children,
        );
      },
    );
    let observed: string | undefined;
    const replySent = Promise.withResolvers<void>();
    xmpp.on(
      "stanza",
      (stanza: { attrs: { id?: string }; toString(): string }) => {
        if (stanza.attrs.id === id) {
          observed = stanza.toString();
        }
      },
    );
    xmpp.on("send", (stanza: { attrs: { id?: string; type?: string } }) => {
      if (stanza.attrs.id === id && stanza.attrs.type === "error") {
        replySent.resolve();
      }
    });
    const before = peer.transcript.length;
    const state = {
      jid: xmpp.jid?.toString(),
      authenticated: xmpp.streamFeatures.authenticated,
      smId: xmpp.streamManagement.id,
      inbound: xmpp.streamManagement.inbound,
    };
    try {
      peer.send(source);
      await started.promise;
      if ("error" in scenario && scenario.error.delayed) {
        expect(handlerCompleted).toBe(false);
        release.resolve();
      }
      await completed.promise;
      if (scenario.outcome === "application-error") {
        await replySent.promise;
      }

      peer.send(
        `<iq xmlns="${CLIENT}" type="get" id="barrier"><ping xmlns="${PING}"/></iq>`,
      );
      await waitForBarrier(peer);

      // The public event can expose raw data without giving it protocol meaning.
      expect(readFrame(observed ?? "")).toEqual(readFrame(source));
      const output = peer.transcript.slice(before).map(readFrame);
      const barrierReply = output.pop();
      expect(barrierReply).toEqual(
        readFrame(`<iq xmlns="${CLIENT}" type="result" id="barrier"/>`),
      );
      if (scenario.outcome === "none") {
        expect(output).toEqual([]);
      } else {
        if (scenario.outcome === "application-error") {
          expect(output).toHaveLength(1);
        }
        if (output.length > 0) {
          expect(output).toHaveLength(1);
          const [errorReply] = output;
          expect(errorReply[0]).toMatchObject({
            open: `{${CLIENT}}message`,
            attributes: {
              "{}type": "error",
              "{}id": id,
              "{}to": "romeo@example.net",
            },
          });

          const stanzaChildren = directChildTrees(
            errorReply,
            `{${CLIENT}}message`,
          );
          const errorChildren = stanzaChildren.filter((child) => {
            const root = child[0];
            return root && "open" in root && root.open === `{${CLIENT}}error`;
          });
          expect(errorChildren).toHaveLength(1);

          const copiedPayload = stanzaChildren.filter((child) => {
            const root = child[0];
            return !(
              root &&
              "open" in root &&
              root.open === `{${CLIENT}}error`
            );
          });
          expect(copiedPayload.length).toBeLessThanOrEqual(1);
          if (copiedPayload.length === 1) {
            expect(copiedPayload[0]).toEqual(
              directChildTrees(readFrame(source), `{${CLIENT}}message`)[0],
            );
          }

          const errorRoot = errorChildren[0][0];
          expect(errorRoot).toMatchObject({
            open: `{${CLIENT}}error`,
          });
          if (!("open" in errorRoot)) {
            throw new Error("Expected a stanza error element");
          }
          expect(ERROR_TYPES).toContain(errorRoot.attributes["{}type"]);

          const detailChildren = directChildTrees(
            errorChildren[0],
            `{${CLIENT}}error`,
          );
          const conditions = detailChildren.filter((child) => {
            const root = child[0];
            return (
              root &&
              "open" in root &&
              root.open.startsWith(`{${STANZAS}}`) &&
              root.open !== `{${STANZAS}}text`
            );
          });
          expect(conditions).toHaveLength(1);
          const condition = conditions[0][0];
          if (!("open" in condition)) {
            throw new Error("Expected a stanza error condition");
          }
          expect(ERROR_CONDITIONS).toContain(condition.open);

          if (scenario.outcome === "application-error") {
            expect(condition.open).toBe(`{${STANZAS}}service-unavailable`);
            expect(errorRoot.attributes["{}type"]).toBe(scenario.error.type);
            expect(copiedPayload).toHaveLength(
              scenario.error.echoPayload ? 1 : 0,
            );
          }
        }
      }

      expect(xmpp.jid?.toString()).toBe(state.jid);
      expect(xmpp.streamFeatures.authenticated).toBe(state.authenticated);
      expect(xmpp.streamFeatures.authenticating).toBe(false);
      expect(xmpp.streamManagement.enabled).toBe(true);
      expect(xmpp.streamManagement.id).toBe(state.smId);
      // The extension is ignored, but both valid stanza roots are handled.
      expect(xmpp.streamManagement.inbound).toBe(state.inbound + 2);
      expect(xmpp.status).toBe("online");
      expect(errors).toEqual([]);
      expect(disconnects).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  });
}
