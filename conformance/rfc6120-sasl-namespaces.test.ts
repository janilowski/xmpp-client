import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const CONTENT = "jabber:client";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const FOREIGN = "urn:test:foreign-sasl";
const MECHANISM = "TEST-NAMESPACES";
const TIMEOUT_MS = 500;
const ADAPTERS = [SASL, SASL2];
type Style = "default" | "prefix" | "rebound";
const STYLES: Style[] = ["default", "prefix", "rebound"];

// RFC 6120 §§4.8.5/6.4/6.5 and Namespaces §6.1 identify SASL elements
// by namespace and local name. Content-prefix bans do not prohibit SASL prefixes.
// XEP-0388 v1.0.4 §§2.4–2.6 retains these exchange semantics for SASL2.
// https://www.w3.org/TR/REC-xml-names/#scoping
// https://www.rfc-editor.org/rfc/rfc6120.html#section-6.5
// https://xmpp.org/extensions/xep-0388.html
function frame(name: string, namespace: string, style: Style, body = "") {
  if (style === "default") {
    return `<${name} xmlns="${namespace}">${body}</${name}>`;
  }
  // A foreign default or inherited-looking prefix must not change the expanded name.
  const declarations = style === "rebound" ? ` xmlns="${FOREIGN}"` : "";
  return `<s:${name} xmlns:s="${namespace}"${declarations}>${body}</s:${name}>`;
}

function session(namespace: string, challenge: Style, success: Style) {
  const state = { failure: "", attempts: 0, authenticated: false };
  const challenges: string[] = [];
  const finals: string[] = [];
  const createPeer = () =>
    new ScriptedPeer((source, remote) => {
      const root = readFrame(source)[0];
      if (!("open" in root)) {
        throw new Error("Expected client element");
      }
      if (root.open === `{${FRAMING}}open`) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="sasl-namespaces"/>`,
        );
        const offer =
          namespace === SASL
            ? `<mechanisms xmlns="${SASL}"><mechanism>${MECHANISM}</mechanism></mechanisms>`
            : `<authentication xmlns="${SASL2}"><mechanism>${MECHANISM}</mechanism></authentication>`;
        remote.send(
          `<features xmlns="${STREAM}">${state.authenticated ? `<bind xmlns="${BIND}"/>` : offer}</features>`,
        );
      } else if (
        root.open ===
        `{${namespace}}${namespace === SASL ? "auth" : "authenticate"}`
      ) {
        state.attempts += 1;
        if (state.failure) {
          remote.send(state.failure);
          return;
        }
        // Foreign namesakes must not invoke mechanism hooks or finish authentication.
        for (const name of ["challenge", "success", "failure"]) {
          remote.send(frame(name, FOREIGN, "prefix", "aG9zdGlsZQ=="));
        }
        remote.send(frame("challenge", namespace, challenge, "Y2hhbGxlbmdl"));
      } else if (root.open === `{${namespace}}response`) {
        state.authenticated = true;
        remote.send(
          frame(
            "success",
            namespace,
            success,
            namespace === SASL
              ? "cHJvb2Y="
              : `<a:additional-data xmlns:a="${SASL2}">cHJvb2Y=</a:additional-data><a:authorization-identifier xmlns:a="${SASL2}">user@example.test</a:authorization-identifier>`,
          ),
        );
        if (namespace === SASL2) {
          remote.send(
            `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/></features>`,
          );
        }
      } else if (root.open === `{${CONTENT}}iq`) {
        remote.send(
          `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
        );
      } else if (root.open === `{${FRAMING}}close`) {
        state.authenticated = false;
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
  const peer = createPeer();
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.saslMechanisms.register(MECHANISM, () => ({
    name: MECHANISM,
    clientFirst: false,
    challenge(value: string) {
      challenges.push(value);
    },
    response() {
      return "reply";
    },
    final(value: string) {
      finals.push(value);
    },
  }));
  return { xmpp, peer, createPeer, state, challenges, finals, errors };
}

for (const namespace of ADAPTERS) {
  test(`RFC 6120 §6.5 / XEP-0388: ${namespace} ignores a foreign condition namesake`, async () => {
    const { xmpp, peer, state } = session(namespace, "prefix", "prefix");
    state.failure = frame(
      "failure",
      namespace,
      "prefix",
      `<c:account-disabled xmlns:c="${FOREIGN}"/><c:credentials-expired xmlns:c="${SASL}"/>`,
    );
    try {
      const result = await xmpp.start().catch((error: Error) => error);
      expect(result).toMatchObject({
        name: "SASLError",
        condition: "credentials-expired",
      });
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  });

  test(`RFC 6120 §6.4.3 / XEP-0388: ${namespace} still rejects children in a prefixed challenge`, async () => {
    const { xmpp, peer, state, challenges, finals } = session(
      namespace,
      "prefix",
      "prefix",
    );
    state.failure = frame(
      "challenge",
      namespace,
      "prefix",
      `<payload xmlns="${FOREIGN}"/>`,
    );
    try {
      const result = await xmpp.start().catch((error: Error) => error);
      expect(result).toMatchObject({
        name: "SASLError",
        condition: "SASL: Unexpected child in mechanism data",
      });
      expect(challenges).toEqual([]);
      expect(finals).toEqual([]);
      expect(
        peer.transcript.some((source) => source.startsWith("<response")),
      ).toBe(false);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  });

  for (const [challenge, success] of [
    ["default", "prefix"],
    ["prefix", "default"],
    ["prefix", "prefix"],
    ["rebound", "rebound"],
  ] as [Style, Style][]) {
    test(`RFC 6120 §6.4 / XEP-0388: ${namespace} accepts ${challenge} challenge and ${success} success`, async () => {
      const { xmpp, peer, state, challenges, finals, errors } = session(
        namespace,
        challenge,
        success,
      );
      try {
        const result = await xmpp.start().catch((error: Error) => error);
        expect(result.toString()).toBe("user@example.test/r");
        expect(challenges).toEqual(["challenge"]);
        expect(finals).toEqual(["proof"]);
        expect(state.attempts).toBe(1);
        expect(
          peer.transcript.filter((source) => source.startsWith("<response")),
        ).toEqual([`<response xmlns="${namespace}">cmVwbHk=</response>`]);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    });
  }

  for (const style of STYLES) {
    for (const condition of ["account-disabled", "future-condition"]) {
      test(`RFC 6120 §6.5 / XEP-0388: ${namespace} preserves ${style} failure ${condition}`, async () => {
        const { xmpp, peer, state, challenges, finals } = session(
          namespace,
          "prefix",
          "prefix",
        );
        state.failure = frame(
          "failure",
          namespace,
          style,
          `<s:text xmlns:s="${namespace}" xml:lang="pl">diagnostic</s:text><s:${condition} xmlns:s="${SASL}"/>`,
        );
        try {
          const result = await xmpp.start().catch((error: Error) => error);
          expect(result).toMatchObject({
            name: "SASLError",
            condition:
              condition === "future-condition" ? "not-authorized" : condition,
            text: "diagnostic",
          });
          expect(challenges).toEqual([]);
          expect(finals).toEqual([]);
          expect(xmpp.status).not.toBe("online");
          expect(peer.transcript.some((source) => source.includes(BIND))).toBe(
            false,
          );
          expect(peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await peer.stop();
        }
      });
    }
  }

  test(`RFC 6120 §6.4.5 / XEP-0388: ${namespace} failure does not poison a fresh exchange`, async () => {
    const { xmpp, peer, createPeer, state, challenges, finals, errors } =
      session(namespace, "rebound", "prefix");
    state.failure = frame(
      "failure",
      namespace,
      "prefix",
      `<c:credentials-expired xmlns:c="${SASL}"/>`,
    );
    let replacement: ScriptedPeer | undefined;
    try {
      const failed = await xmpp.start().catch((error: Error) => error);
      expect(failed).toMatchObject({
        name: "SASLError",
        condition: "credentials-expired",
      });
      await xmpp.stop();
      expect(errors).toEqual([failed]);
      replacement = createPeer();
      Object.assign(xmpp.options, { service: replacement.url });
      state.failure = "";
      errors.length = 0;
      expect((await xmpp.start()).toString()).toBe("user@example.test/r");
      expect(challenges).toEqual(["challenge"]);
      expect(finals).toEqual(["proof"]);
      expect(state.attempts).toBe(2);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
      expect(replacement.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
      await replacement?.stop();
    }
  });
}
