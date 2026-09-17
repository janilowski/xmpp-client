import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import parse from "../src/xml/lib/parse.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const MECHANISM = "TEST-WIRE";
const TIMEOUT_MS = 500;

// RFC 6120 §§6.4.2–6.4.6: test the SASL transport, not a particular mechanism.
// Independent wire expectations include non-UTF-8 octets and explicit empty data.
test.each([
  "server-first",
  "empty-initial",
  "binary",
  "empty-final",
  "failure",
])("RFC 6120 §6.4: %s exchange and restart ordering", async (mode) => {
  const transcript: Element[] = [];
  let succeeded = false;
  let opens = 0;
  const peer = new ScriptedPeer((frame, remote) => {
    const el = parse(frame) as Element | undefined;
    if (!el) {
      throw new Error("Expected one XML element from client");
    }
    transcript.push(el);
    if (el.is("open", FRAMING)) {
      opens++;
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="session-${opens}"/>`,
      );
      remote.send(
        succeeded
          ? `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/></features>`
          : `<features xmlns="${STREAM}"><mechanisms xmlns="${SASL}"><mechanism>${MECHANISM}</mechanism></mechanisms></features>`,
      );
    } else if (el.is("auth", SASL)) {
      remote.send(`<challenge xmlns="${SASL}">AP8=</challenge>`);
    } else if (el.is("response", SASL)) {
      succeeded = mode !== "failure";
      remote.send(
        succeeded
          ? `<success xmlns="${SASL}">${mode === "empty-final" ? "=" : ""}</success>`
          : `<failure xmlns="${SASL}"><not-authorized/></failure>`,
      );
    } else if (el.is("iq")) {
      remote.send(
        `<iq xmlns="jabber:client" type="result" id="${el.attrs.id}"><bind xmlns="${BIND}"><jid>user@example.test/resource</jid></bind></iq>`,
      );
    } else if (el.is("close", FRAMING)) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    timeout: TIMEOUT_MS,
    credentials: async (
      authenticate: (credentials: object, mechanism: string) => Promise<void>,
    ) => {
      await authenticate({}, MECHANISM);
    },
  });
  const challenges: Uint8Array[] = [];
  const finals: Uint8Array[] = [];
  xmpp.saslMechanisms.register(MECHANISM, () => ({
    name: MECHANISM,
    clientFirst: mode !== "server-first",
    binary: true,
    response: () => (mode === "binary" ? new Uint8Array([0, 255]) : ""),
    challenge: (data: Uint8Array) => {
      challenges.push(data);
    },
    final: (data: Uint8Array) => {
      finals.push(data);
    },
  }));
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  try {
    const result = await xmpp.start().then(
      () => "online",
      (error: Error) => error,
    );
    const auth = transcript.filter((el) => el.is("auth", SASL));
    expect(auth).toHaveLength(1);
    expect(auth[0].attrs.mechanism).toBe(MECHANISM);
    expect(auth[0].text()).toBe(
      mode === "server-first" ? "" : mode === "binary" ? "AP8=" : "=",
    );
    expect(challenges).toEqual([new Uint8Array([0, 255])]);
    const responses = transcript.filter((el) => el.is("response", SASL));
    expect(responses).toHaveLength(1);
    expect(responses[0].text()).toBe(mode === "binary" ? "AP8=" : "");
    if (mode === "failure") {
      expect(result).toMatchObject({
        name: "SASLError",
        condition: "not-authorized",
      });
      expect(finals).toEqual([]);
      expect(opens).toBe(1);
      expect(transcript.some((el) => el.is("iq"))).toBe(false);
    } else {
      expect(finals).toEqual([new Uint8Array()]);
      expect(result).toBe("online");
      expect(transcript.map((el) => el.name)).toEqual([
        "open",
        "auth",
        "response",
        "open",
        "iq",
      ]);
      expect(peer.requests).toHaveLength(1);
    }
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});
