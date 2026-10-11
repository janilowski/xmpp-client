import { expect, test } from "bun:test";
import { once } from "node:events";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const CONTENT = "jabber:client";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const EXTENSION = "urn:test:sm-inbound";
const PING = "urn:xmpp:ping";
const TIMEOUT_MS = 1000;

// XEP-0198 1.6.3 §4: every handled stanza contributes once, independent of
// middleware consumption. These expected h values are independent literals.
test.each([
  "correlated IQ result",
  "correlated IQ error",
  "correlated malformed IQ result",
  "correlated malformed IQ error",
  "correlated IQ after spoofed sender",
  "message",
  "presence",
  "handled IQ get",
  "malformed IQ get",
  "foreign IQ nonza",
  "public sendMany",
] as const)("XEP-0198 §4: accounts for %s", async (kind) => {
  let authenticated = false;
  let batchSent = 0;
  const ready = Promise.withResolvers<void>();
  const batchAcked = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<string>();
  const ack = Promise.withResolvers<string>();
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected a document element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="stream"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${
          authenticated
            ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>`
            : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`
        }</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}" id="session" resume="true"/>`);
    } else if (root.open === `{${EXTENSION}}ready`) {
      remote.send(`<ready xmlns="${EXTENSION}"/>`);
    } else if (
      kind === "public sendMany" &&
      ["message", "presence"].some(
        (name) => root.open === `{${CONTENT}}${name}`,
      )
    ) {
      batchSent += 1;
      if (batchSent === 2) {
        remote.send(`<a xmlns="${SM}" h="2"/>`);
        remote.send(`<batch-acked xmlns="${EXTENSION}"/>`);
      }
    } else if (root.open === `{${CONTENT}}iq`) {
      const id = root.attributes["{}id"];
      if (id === "request") {
        if (kind === "correlated IQ after spoofed sender") {
          remote.send(
            `<iq xmlns="${CONTENT}" id="request" from="attacker@evil.test" type="result"/>`,
          );
        }
        if (kind === "correlated malformed IQ result") {
          remote.send(
            `<iq xmlns="${CONTENT}" id="request" type="result"><query xmlns="${EXTENSION}"/><extra xmlns="${EXTENSION}"/></iq>`,
          );
          return;
        }
        if (kind === "correlated malformed IQ error") {
          remote.send(`<iq xmlns="${CONTENT}" id="request" type="error"/>`);
          return;
        }
        remote.send(
          kind === "correlated IQ result" ||
            kind === "correlated IQ after spoofed sender"
            ? `<iq xmlns="${CONTENT}" id="request" type="result"/>`
            : `<iq xmlns="${CONTENT}" id="request" type="error"><error type="cancel"><service-unavailable xmlns="${STANZAS}"/></error></iq>`,
        );
      } else if (id === "incoming") {
        reply.resolve(frame);
      } else {
        remote.send(
          `<iq xmlns="${CONTENT}" id="${id}" type="result"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
        );
      }
    } else if (root.open === `{${SM}}a`) {
      ack.resolve(frame);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  const applicationIds: string[] = [];
  xmpp.middleware.use((context: { id: string }, next: () => unknown) => {
    if (typeof context.id === "string") {
      applicationIds.push(context.id);
    }
    return next();
  });
  xmpp.on("error", (error: Error) => errors.push(error));
  const enabled = Promise.withResolvers<void>();
  xmpp.on("nonza", (element) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    } else if (element.is("ready", EXTENSION)) {
      ready.resolve();
    } else if (element.is("batch-acked", EXTENSION)) {
      batchAcked.resolve();
    }
  });
  try {
    expect(String(await xmpp.start())).toBe("user@example.test/r");
    await enabled.promise;
    // A real document round trip lets SM's asynchronous enable continuation
    // finish without a sleep, polling a private field or counting a stanza.
    await xmpp.send(xml("ready", EXTENSION));
    await ready.promise;
    expect(xmpp.streamManagement.enabled).toBe(true);
    if (kind.startsWith("correlated")) {
      const result = await xmpp.iqCaller
        .request(
          xml("iq", { type: "get", id: "request" }, xml("query", EXTENSION)),
          TIMEOUT_MS,
        )
        .catch((error: Error) => error);
      if (kind.includes("malformed")) {
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe("Invalid IQ response");
      } else if (kind !== "correlated IQ error") {
        expect(result.attrs).toMatchObject({ id: "request", type: "result" });
        expect(result.attrs.from).toBe(undefined);
      } else {
        expect(result.condition).toBe("service-unavailable");
      }
    } else if (kind === "public sendMany") {
      await xmpp.sendMany([
        xml("message", { id: "first" }),
        xml("presence", { id: "second" }),
      ]);
      await batchAcked.promise;
      expect(batchSent).toBe(2);
      expect(xmpp.streamManagement.outbound).toBe(2);
      expect(xmpp.streamManagement.outbound_q).toEqual([]);
    } else if (kind === "message" || kind === "presence") {
      const handled = once(xmpp, "stanza", {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      peer.send(`<${kind} xmlns="${CONTENT}" id="incoming"/>`);
      await handled;
    } else if (kind === "foreign IQ nonza") {
      const observed = once(xmpp, "nonza", {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      peer.send(`<iq xmlns="${EXTENSION}" id="incoming" type="get"/>`);
      await observed;
    } else {
      peer.send(
        `<iq xmlns="${CONTENT}" id="incoming" from="example.test" type="get">${kind === "handled IQ get" ? `<ping xmlns="${PING}"/>` : ""}</iq>`,
      );
      const response = readFrame(await reply.promise)[0];
      expect(response).toMatchObject({
        attributes: {
          "{}id": "incoming",
          "{}type": kind === "handled IQ get" ? "result" : "error",
        },
      });
    }
    peer.send(`<r xmlns="${SM}"/>`);
    const response = readFrame(await ack.promise)[0];
    expect(response).toMatchObject({
      open: `{${SM}}a`,
      attributes: {
        "{}h":
          kind === "correlated IQ after spoofed sender"
            ? "2"
            : kind === "public sendMany" || kind === "foreign IQ nonza"
              ? "0"
              : "1",
      },
    });
    if (kind === "correlated IQ after spoofed sender") {
      expect(applicationIds.filter((id) => id === "request")).toEqual([
        "request",
      ]);
    } else if (kind.startsWith("correlated")) {
      expect(applicationIds).not.toContain("request");
    }
    expect(xmpp.status).toBe("online");
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});
