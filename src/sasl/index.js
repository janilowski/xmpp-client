import { encode } from "../util/base64.js";
import xml from "../xml/index.js";
import exchange from "./exchange.js";
import prepareCredentials from "./credentials.js";

import SASLError from "./lib/SASLError.js";

// https://xmpp.org/rfcs/rfc6120.html#sasl

const NS = "urn:ietf:params:xml:ns:xmpp-sasl";

export function getAvailableMechanisms(element, NS, saslMechanisms) {
  const offered = new Set(
    element
      .getChildren("mechanism", NS)
      .filter((m) => m.getChildElements().length === 0)
      .map((m) => m.text()),
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

  const creds = prepareCredentials(entity, credentials);

  // RFC 6120 §6.4.2 distinguishes an empty response from no initial response.
  const response = mech.clientFirst
    ? encode(await mech.response(creds)) || "="
    : "";
  signal.throwIfAborted();
  await exchange(
    entity,
    xml("auth", { xmlns: NS, mechanism: mech.name }, response),
    mech,
    creds,
    null,
    signal,
  );
}

export default function sasl(
  { streamFeatures, saslMechanisms },
  onAuthenticate,
) {
  streamFeatures.use(
    "mechanisms",
    NS,
    async ({ entity }, _next, element, signal) => {
      if (streamFeatures.authenticating || streamFeatures.authenticated) {
        throw new SASLError("SASL: Unexpected authentication features");
      }
      streamFeatures.authenticating = true;
      const mechanisms = getAvailableMechanisms(element, NS, saslMechanisms);
      if (mechanisms.length === 0) {
        // RFC 6120 §6.4.2: no acceptable mechanism leaves no exchange to retry.
        entity.disconnect().catch(() => {});
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
      streamFeatures.authenticated = true;
      streamFeatures.authenticating = false;
      await entity.restart();
    },
  );
}
