import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

// RFC 6120 §§4.8.4/8.2.3 / Namespaces 1.0 §§2.1/2.3: extension payload
// identity is its expanded name, independent of a chosen prefix. The public
// get/set helpers project a matching child from a normally correlated IQ;
// no match and an empty result retain the existing undefined return contract.
// https://www.rfc-editor.org/rfc/rfc6120.html#section-8.2.3
// https://www.w3.org/TR/REC-xml-names/#dt-expname
const CLIENT = "jabber:client";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const PAYLOAD = "urn:test:iq-payload";
const FOREIGN = "urn:test:other-payload";
const TIMEOUT_MS = 1000;
const NEGOTIATION_FRAME_BUDGET = 8;

async function session(reply: (frame: string, peer: ScriptedPeer) => void) {
  let authenticated = false;
  const requests: string[] = [];
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!(root && "open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="iq-payloads"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CLIENT}}iq` && frame.includes(BIND)) {
      remote.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (root.open === `{${CLIENT}}iq`) {
      requests.push(frame);
      reply(frame, remote);
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
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    expect((await xmpp.start()).toString()).toBe("user@example.test/r");
    const queued = peer.transcript.length;
    expect(queued).toBeLessThanOrEqual(NEGOTIATION_FRAME_BUDGET);
    for (let index = 0; index < queued; index++) {
      await peer.next();
    }
    return { xmpp, peer, requests, errors };
  } catch (error) {
    await xmpp.stop();
    await peer.stop();
    throw error;
  }
}

for (const method of ["get", "set"] as const) {
  for (const requestShape of ["default", "prefixed"] as const) {
    for (const replyShape of ["default", "other prefix"] as const) {
      test(`RFC 6120 §§4.8.4/8.2.3: IQ ${method} ${requestShape} payload accepts ${replyShape} reply`, async () => {
        const { xmpp, peer, requests, errors } = await session(
          (frame, remote) => {
            const [root, query] = readFrame(frame);
            expect(root).toMatchObject({
              open: `{${CLIENT}}iq`,
              attributes: { "{}type": method },
            });
            expect(query).toMatchObject({ open: `{${PAYLOAD}}query` });
            if (!("open" in root)) {
              throw new Error("Expected IQ");
            }
            const body =
              replyShape === "default"
                ? `<query xmlns="${PAYLOAD}" marker="reply"/>`
                : `<q:query xmlns:q="${PAYLOAD}" marker="reply"/>`;
            remote.send(
              `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}">${body}</iq>`,
            );
          },
        );
        try {
          const payload =
            requestShape === "default"
              ? xml("query", { xmlns: PAYLOAD })
              : xml("p:query", { "xmlns:p": PAYLOAD });
          const result = await xmpp.iqCaller[method](
            payload,
            undefined,
            TIMEOUT_MS,
          );
          expect(result).toBeDefined();
          expect(result?.getName()).toBe("query");
          expect(result?.getNS()).toBe(PAYLOAD);
          expect(result?.attrs.marker).toBe("reply");
          expect(requests).toHaveLength(1);
          expect(xmpp.iqCaller.handlers.size).toBe(0);
          expect(errors).toEqual([]);
          expect(peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await peer.stop();
        }
      });
    }

    test(`RFC 6120 §4.8.4: IQ ${method} ${requestShape} helper does not return a foreign same-local-name payload`, async () => {
      const { xmpp, peer, requests, errors } = await session(
        (frame, remote) => {
          const root = readFrame(frame)[0];
          if (!("open" in root)) {
            throw new Error("Expected IQ");
          }
          remote.send(
            `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><q:query xmlns:q="${FOREIGN}"/></iq>`,
          );
        },
      );
      try {
        const payload =
          requestShape === "default"
            ? xml("query", { xmlns: PAYLOAD })
            : xml("p:query", { "xmlns:p": PAYLOAD });
        expect(
          await xmpp.iqCaller[method](payload, undefined, TIMEOUT_MS),
        ).toBeUndefined();
        expect(requests).toHaveLength(1);
        expect(xmpp.iqCaller.handlers.size).toBe(0);
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    });

    for (const response of ["original", "changed"] as const) {
      test(`IQ ${method} ${requestShape} helper snapshots the request expanded name before async send / ${response} response`, async () => {
        const payload =
          requestShape === "default"
            ? xml("query", { xmlns: PAYLOAD })
            : xml("p:query", { "xmlns:p": PAYLOAD });
        const { xmpp, peer, requests, errors } = await session(
          (frame, remote) => {
            const [root, query] = readFrame(frame);
            expect(query).toMatchObject({ open: `{${PAYLOAD}}query` });
            if (!("open" in root)) {
              throw new Error("Expected IQ");
            }
            // The real request bytes precede this caller-owned mutation. Reading
            // the Element again after awaiting the IQ would change its meaning.
            payload.name = "mutated:changed";
            payload.attrs["xmlns:mutated"] = FOREIGN;
            const body =
              response === "original"
                ? `<q:query xmlns:q="${PAYLOAD}" marker="original"/>`
                : `<q:changed xmlns:q="${FOREIGN}" marker="changed"/>`;
            remote.send(
              `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}">${body}</iq>`,
            );
          },
        );
        try {
          const result = await xmpp.iqCaller[method](
            payload,
            undefined,
            TIMEOUT_MS,
          );
          if (response === "original") {
            expect(result).toBeDefined();
            expect(result?.getName()).toBe("query");
            expect(result?.getNS()).toBe(PAYLOAD);
            expect(result?.attrs.marker).toBe("original");
          } else {
            expect(result).toBeUndefined();
          }
          expect(payload.getName()).toBe("changed");
          expect(payload.getNS()).toBe(FOREIGN);
          expect(requests).toHaveLength(1);
          expect(xmpp.iqCaller.handlers.size).toBe(0);
          expect(errors).toEqual([]);
          expect(peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await peer.stop();
        }
      });
    }
  }
}

test.each(["default", "prefixed"])(
  "RFC 6120 §8.2.3: empty IQ set result remains undefined for %s payload",
  async (shape) => {
    const { xmpp, peer, requests, errors } = await session((frame, remote) => {
      const root = readFrame(frame)[0];
      if (!("open" in root)) {
        throw new Error("Expected IQ");
      }
      remote.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"/>`,
      );
    });
    try {
      const payload =
        shape === "default"
          ? xml("query", { xmlns: PAYLOAD })
          : xml("p:query", { "xmlns:p": PAYLOAD });
      expect(
        await xmpp.iqCaller.set(payload, undefined, TIMEOUT_MS),
      ).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(xmpp.iqCaller.handlers.size).toBe(0);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
