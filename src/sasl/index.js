import { encode, decode } from "../util/base64.js";
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

async function authenticate({ saslMechanisms, entity, mechanism, credentials }) {
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

  await procedure(
    entity,
    mech.clientFirst &&
      xml(
        "auth",
        { xmlns: NS, mechanism: mech.name },
        encode(await mech.response(creds)),
      ),
    async (element, done) => {
      if (element.getNS() !== NS) return;

      if (element.name === "challenge") {
        await mech.challenge(decode(element.text()));
        const resp = await mech.response(creds);
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
        return done();
      }
    },
  );
}

export default function sasl(
  { streamFeatures, saslMechanisms },
  onAuthenticate,
) {
  streamFeatures.use("mechanisms", NS, async ({ entity }, _next, element) => {
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
      });
    }

    await onAuthenticate(done, mechanisms, null, entity);

    await entity.restart();
  });
}
