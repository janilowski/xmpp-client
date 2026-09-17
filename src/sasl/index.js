import { encode, decode, decodeBytes } from "../util/base64.js";
import xml from "../xml/index.js";
import { procedure } from "../events/index.js";

import SASLError from "./lib/SASLError.js";

// https://xmpp.org/rfcs/rfc6120.html#sasl

const NS = "urn:ietf:params:xml:ns:xmpp-sasl";

export function getAvailableMechanisms(element, NS, saslMechanisms) {
  const offered = new Set(
    element.getChildren("mechanism", NS).map((m) => m.text()),
  );
  const supported = saslMechanisms.names;
  return supported.filter((mech) => offered.has(mech));
}

async function authenticate({
  saslMechanisms,
  entity,
  mechanism,
  credentials,
  signal,
}) {
  signal.throwIfAborted();
  const mech = saslMechanisms.create(mechanism);
  if (!mech) {
    throw new Error(`SASL: Mechanism ${mechanism} not found.`);
  }

  const { domain } = entity.options;
  const creds = {
    username: null,
    password: null,
    server: domain,
    host: domain,
    realm: domain,
    serviceType: "xmpp",
    serviceName: domain,
    ...credentials,
  };

  const response = mech.clientFirst && encode(await mech.response(creds));
  signal.throwIfAborted();
  await procedure(
    entity,
    mech.clientFirst &&
      xml(
        "auth",
        { xmlns: NS, mechanism: mech.name },
        response,
      ),
    async (element, done, exchange) => {
      if (element.getNS() !== NS) return;

      if (element.name === "challenge") {
        await mech.challenge(
          mech.binary ? decodeBytes(element.text()) : decode(element.text()),
        );
        exchange.throwIfAborted();
        const resp = await mech.response(creds);
        exchange.throwIfAborted();
        await entity.send(
          xml(
            "response",
            { xmlns: NS, mechanism: mech.name },
            typeof resp === "string" ? encode(resp) : "",
          ),
        );
        return;
      }

      if (element.name === "failure") {
        throw SASLError.fromElement(element);
      }

      if (element.name === "success") {
        if (mech.final) {
          await mech.final(
            mech.binary ? decodeBytes(element.text()) : decode(element.text()),
          );
          exchange.throwIfAborted();
        }
        return done();
      }
    },
    signal,
  );
}

export default function sasl(
  { streamFeatures, saslMechanisms },
  onAuthenticate,
) {
  streamFeatures.use("mechanisms", NS, async ({ entity }, _next, element, signal) => {
    const mechanisms = getAvailableMechanisms(element, NS, saslMechanisms);
    if (mechanisms.length === 0) {
      throw new SASLError("SASL: No compatible mechanism available.");
    }

    async function done(credentials, mechanism) {
      await authenticate({
        saslMechanisms,
        entity,
        mechanism,
        credentials,
        signal,
      });
    }

    await onAuthenticate(done, mechanisms, null, entity);

    signal.throwIfAborted();
    await entity.restart();
  });
}
