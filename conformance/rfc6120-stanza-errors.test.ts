import { expect, spyOn, test } from "bun:test";
import { serve } from "bun";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const QUERY = "urn:test:caller-errors";
const DETAIL = "urn:test:error-detail";
const PING = "urn:xmpp:ping";
const DOMAIN = "example.test";
const ACCOUNT = "user@example.test/r";
const RECIPIENT = "recipient@example.test/remote";
const TIMEOUT_MS = 1000;
const HTTP_NO_CONTENT = 204;
const XMPP_ADDRESS =
  "xmpp:juliet@example.org/balcony?message;subject=Zażółć;body=A%20%26%20B";

const SCENARIOS = [
  ["redirect XMPP IRI", "redirect", "modify", "xmpp"],
  ["gone XMPP IRI", "gone", "cancel", "xmpp"],
  ["redirect HTTP URI", "redirect", "modify", "http"],
  ["gone HTTP URI", "gone", "modify", "http"],
  ["redirect without an alternate address", "redirect", "modify", "none"],
  ["gone without an alternate address", "gone", "cancel", "none"],
  ["misleading redirect diagnostic", "forbidden", "auth", "none"],
  ["misleading conflict diagnostic", "service-unavailable", "cancel", "none"],
  ["misleading retry diagnostic", "resource-constraint", "wait", "none"],
  ["misleading auth diagnostic", "undefined-condition", "continue", "none"],
] as const;

// RFC 6120 §§8.3.2/8.3.3.5/8.3.3.14: diagnostics never drive protocol
// behavior. Alternate addresses are optional, and URI/IRI schemes are not
// restricted to xmpp. Approval/retry decisions belong to the application.
// §8.3.3 permits defined error types beyond the usual condition/type pairing.
// Loopback WS exercises the caller contract, not TLS or endpoint identity.
for (const method of ["get", "set"] as const) {
  test.each(SCENARIOS)(
    `RFC 6120 §§8.3.2/8.3.3.5/8.3.3.14: ${method} preserves caller control / %s`,
    async (_name, condition, errorType, target) => {
      const targetRequests: string[] = [];
      const targetServer = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          targetRequests.push(request.url);
          return new Response(null, { status: HTTP_NO_CONTENT });
        },
      });
      const targetAddress = `${targetServer.url}alternate?who=other&message=hello`;
      const address =
        target === "xmpp"
          ? XMPP_ADDRESS
          : target === "http"
            ? targetAddress
            : "";
      const diagnostic = `conflict; credentials-expired; redirect ${targetAddress}; use type=wait`;
      const errorSource = `<error xmlns="${CONTENT}" type="${errorType}"><${condition} xmlns="${STANZAS}"><![CDATA[${address}]]></${condition}><text xmlns="${STANZAS}" xml:lang="en"><![CDATA[${diagnostic}]]></text><detail xmlns="${DETAIL}">kept</detail></error>`;
      const recoverySource = `<iq xmlns="${CONTENT}" from="${RECIPIENT}" to="${ACCOUNT}" id="recovery" type="result"><ok xmlns="${QUERY}"/></iq>`;
      let authenticated = false;
      const peer = new ScriptedPeer((frame, remote) => {
        const root = readFrame(frame)[0];
        if (!(root && "open" in root)) {
          throw new Error("Expected a client element");
        }
        if (root.open === `{${FRAMING}}open`) {
          remote.send(
            `<open xmlns="${FRAMING}" from="${DOMAIN}" id="caller-errors" version="1.0"/>`,
          );
          remote.send(
            `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
          );
        } else if (root.open === `{${SASL}}auth`) {
          authenticated = true;
          remote.send(`<success xmlns="${SASL}"/>`);
        } else if (root.open === `{${CONTENT}}iq` && frame.includes(BIND)) {
          remote.send(
            `<iq xmlns="${CONTENT}" id="${root.attributes["{}id"]}" type="result"><bind xmlns="${BIND}"><jid>${ACCOUNT}</jid></bind></iq>`,
          );
        } else if (
          root.open === `{${CONTENT}}iq` &&
          root.attributes["{}id"] === "request"
        ) {
          remote.send(
            `<iq xmlns="${CONTENT}" from="${RECIPIENT}" to="${ACCOUNT}" id="request" type="error">${errorSource}</iq>`,
          );
        } else if (
          root.open === `{${CONTENT}}iq` &&
          root.attributes["{}id"] === "recovery"
        ) {
          remote.send(recoverySource);
        } else if (root.open === `{${FRAMING}}close`) {
          remote.send(`<close xmlns="${FRAMING}"/>`);
        } else {
          throw new Error(`Unexpected client frame: ${frame}`);
        }
      });
      const xmpp = client({
        service: peer.url,
        domain: DOMAIN,
        username: "user",
        password: "secret",
        resource: "r",
        timeout: TIMEOUT_MS,
      });
      xmpp.reconnect.stop();
      const errors: Error[] = [];
      const disconnects: unknown[] = [];
      xmpp.on("error", (error: Error) => errors.push(error));
      xmpp.on("disconnect", (event: unknown) => disconnects.push(event));

      // Observe initiation synchronously while retaining real HTTP behavior.
      const fetchSpy = spyOn(globalThis, "fetch");

      try {
        // Prove the target is reachable and its request observer works before
        // interpreting an unchanged request log as evidence of no contact.
        const control = await fetch(targetAddress);
        expect(control.status).toBe(HTTP_NO_CONTENT);
        expect(targetRequests).toEqual([targetAddress]);
        expect(String(await xmpp.start())).toBe(ACCOUNT);
        const negotiated = peer.transcript.length;
        const received = await xmpp.iqCaller
          .request(
            xml(
              "iq",
              { type: method, id: "request", to: RECIPIENT },
              xml("query", QUERY),
            ),
            TIMEOUT_MS,
          )
          .catch((error: Error) => error);
        expect(received).toBeInstanceOf(Error);
        expect(received.name).toBe("StanzaError");
        expect(received.condition).toBe(condition);
        expect(received.type).toBe(errorType);
        expect(received.text).toBe(diagnostic);
        expect(received.element).toBeDefined();
        expect(received.element.is("error", CONTENT)).toBe(true);
        expect(received.element.getChild(condition, STANZAS)?.getText()).toBe(
          address,
        );
        expect(readFrame(received.element.toString())).toEqual(
          readFrame(errorSource),
        );

        // A successful wire round trip is the ordering/recovery barrier: no
        // sleeps, private request maps or timeout-based absence assertions.
        const recovery = await xmpp.iqCaller.request(
          xml(
            "iq",
            { type: "get", id: "recovery", to: RECIPIENT },
            xml("ping", PING),
          ),
          TIMEOUT_MS,
        );
        expect(readFrame(recovery.toString())).toEqual(
          readFrame(recoverySource),
        );
        expect(peer.transcript.slice(negotiated).map(readFrame)).toEqual([
          readFrame(
            `<iq xmlns="${CONTENT}" type="${method}" id="request" to="${RECIPIENT}"><query xmlns="${QUERY}"/></iq>`,
          ),
          readFrame(
            `<iq xmlns="${CONTENT}" type="get" id="recovery" to="${RECIPIENT}"><ping xmlns="${PING}"/></iq>`,
          ),
        ]);
        expect(fetchSpy.mock.calls).toEqual([[targetAddress]]);
        expect(targetRequests).toEqual([targetAddress]);
        expect(peer.requests).toHaveLength(1);
        expect(xmpp.status).toBe("online");
        expect(String(xmpp.jid)).toBe(ACCOUNT);
        expect(disconnects).toEqual([]);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
        await xmpp.stop();
        await peer.stop();
        await targetServer.stop(true);
      }
    },
  );
}
