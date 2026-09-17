import { expect, test } from "bun:test";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { client } from "../src/client/index.js";
import parse from "../src/xml/lib/parse.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";

const OPEN =
  '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="example.test" version="1.0" id="scram"/>';
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";

// RFC 5802 §§3, 5: independent Node crypto peer; production uses Web Crypto.
// RFC 6120 §6 / XEP-0388: never restart, bind or go online without server proof.
for (const ns of [SASL, SASL2]) {
  for (const name of ["SCRAM-SHA-1", "SCRAM-SHA-256"]) {
    test.each([
      "valid",
      "extensions",
      "challenge-final",
      "missing",
      "forged",
      "early",
    ])(`${ns} / ${name}: %s server proof`, async (outcome) => {
      let authenticated = false;
      let serverFirst = "";
      let clientFirst = "";
      let success = "";
      let verifiedClientProof = false;
      let restarts = 0;
      let binds = 0;
      let selected = "";
      const advertised =
        outcome === "extensions"
          ? `<mechanism>PLAIN</mechanism><mechanism>SCRAM-SHA-1</mechanism><mechanism>${name}</mechanism>`
          : `<mechanism>${name}</mechanism>`;
      const hash = name === "SCRAM-SHA-1" ? "sha1" : "sha256";
      const hmac = (key: Uint8Array, value: string) =>
        createHmac(hash, key).update(value).digest();
      const salted = pbkdf2Sync(
        "pencil",
        Buffer.from("independent-salt"),
        4096,
        hash === "sha1" ? 20 : 32,
        hash,
      );
      const peer = new ScriptedPeer((frame, remote) => {
        const el = parse(frame) as Element | undefined;
        if (!el) {
          throw new Error("Expected one XML element from client");
        }
        if (el.is("open")) {
          remote.send(OPEN);
          if (authenticated) {
            restarts++;
            remote.send(
              `<features xmlns="http://etherx.jabber.org/streams"><bind xmlns="${BIND}"/></features>`,
            );
          } else {
            remote.send(
              ns === SASL
                ? `<features xmlns="http://etherx.jabber.org/streams"><mechanisms xmlns="${ns}">${advertised}</mechanisms></features>`
                : `<features xmlns="http://etherx.jabber.org/streams"><authentication xmlns="${ns}">${advertised}<inline><bind xmlns="urn:xmpp:bind:0"/></inline></authentication></features>`,
            );
          }
        } else if (el.is("auth") || el.is("authenticate")) {
          selected = el.attrs.mechanism;
          const data =
            ns === SASL ? el.getText() : el.getChildText("initial-response");
          if (data === null) {
            throw new Error("Missing SCRAM initial response");
          }
          clientFirst = Buffer.from(data, "base64").toString();
          const nonce = clientFirst.split(",r=")[1];
          serverFirst = `r=${nonce}server,s=aW5kZXBlbmRlbnQtc2FsdA==,i=4096`;
          if (outcome === "extensions") {
            serverFirst += ",x=optional,z=extra";
          }
          remote.send(
            outcome === "early"
              ? `<success xmlns="${ns}"/>`
              : `<challenge xmlns="${ns}">${Buffer.from(serverFirst).toString("base64")}</challenge>`,
          );
        } else if (el.is("response")) {
          if (outcome === "challenge-final" && el.text() === "") {
            remote.send(success);
            return;
          }
          const response = Buffer.from(el.getText(), "base64").toString();
          const [withoutProof, proof] = response.split(",p=");
          const auth = [clientFirst.slice(3), serverFirst, withoutProof].join(
            ",",
          );
          const key = hmac(salted, "Client Key");
          const signature = hmac(createHash(hash).update(key).digest(), auth);
          const expected = Buffer.from(
            key.map((byte, i) => byte ^ signature[i]),
          ).toString("base64");
          verifiedClientProof = proof === expected;
          let final =
            "v=" + hmac(hmac(salted, "Server Key"), auth).toString("base64");
          if (outcome === "forged") {
            final = "v=AAAA";
          }
          if (outcome === "missing") {
            final = "";
          }
          const encoded = Buffer.from(final).toString("base64");
          authenticated = true;
          success =
            ns === SASL
              ? `<success xmlns="${ns}">${encoded}</success>`
              : `<success xmlns="${ns}"><additional-data>${encoded}</additional-data><authorization-identifier>user@example.test/test</authorization-identifier><bound xmlns="urn:xmpp:bind:0"/></success>`;
          if (outcome === "challenge-final") {
            success = success.replace(encoded, "");
            remote.send(`<challenge xmlns="${ns}">${encoded}</challenge>`);
          } else {
            remote.send(success);
          }
        } else if (el.is("iq")) {
          binds++;
          remote.send(
            `<iq xmlns="jabber:client" type="result" id="${el.attrs.id}"><bind xmlns="${BIND}"><jid>user@example.test/test</jid></bind></iq>`,
          );
        } else if (el.is("close")) {
          remote.send(CLOSE);
        }
      });
      const xmpp = client({
        service: peer.url,
        domain: "example.test",
        username: "user",
        password: "pencil",
      });
      xmpp.reconnect.stop();
      let online = 0;
      xmpp.on("online", () => online++);
      xmpp.on("error", () => {});
      try {
        const result = await xmpp.start().then(
          (jid) => jid.toString(),
          (error) => error,
        );
        expect(peer.errors).toEqual([]);
        expect(selected).toBe(name);
        if (["valid", "extensions", "challenge-final"].includes(outcome)) {
          expect(result).toBe("user@example.test/test");
          expect(verifiedClientProof).toBe(true);
          expect(online).toBe(1);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(result.message).toContain("SCRAM");
          expect(online).toBe(0);
          expect(restarts).toBe(0);
          expect(binds).toBe(0);
        }
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    });
  }
}
