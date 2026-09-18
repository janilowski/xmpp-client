import { encode } from "../util/base64.js";
import SASLError from "../sasl/lib/SASLError.js";
import xml from "../xml/index.js";
import exchange from "../sasl/exchange.js";
import prepareCredentials from "../sasl/credentials.js";
import { getAvailableMechanisms } from "../sasl/index.js";

// https://xmpp.org/extensions/xep-0388.html

const NS = "urn:xmpp:sasl:2";

async function authenticate({
  saslMechanisms,
  entity,
  mechanism,
  credentials,
  userAgent,
  streamFeatures,
  features,
  signal,
}) {
  signal.throwIfAborted();
  const mech = saslMechanisms.create(mechanism);
  if (!mech) {
    throw new Error(`SASL: Mechanism ${mechanism} not found.`);
  }

  const creds = prepareCredentials(entity, credentials);

  const response = mech.clientFirst && encode(await mech.response(creds));
  signal.throwIfAborted();
  await exchange(
    entity,
    xml("authenticate", { xmlns: NS, mechanism: mech.name }, [
      mech.clientFirst && xml("initial-response", {}, response),
      userAgent,
      ...streamFeatures,
    ]),
    mech,
    creds,
    async (element, signal) => {
      // https://xmpp.org/extensions/xep-0388.html#success
      // this is a bare JID, unless resource binding or stream resumption has occurred, in which case it is a full JID.
      const aid = element.getChildText("authorization-identifier");
      if (aid) {
        entity._jid(aid);
      }

      for (const child of element.getChildElements()) {
        signal.throwIfAborted();
        const feature = features.get(child.getNS());
        await feature?.[1]?.(child, signal);
      }
    },
    signal,
  );
}

export default function sasl2(
  { streamFeatures, saslMechanisms },
  onAuthenticate,
) {
  const features = new Map();
  let fast;

  streamFeatures.use(
    "authentication",
    NS,
    async ({ entity }, _next, element, signal) => {
      if (streamFeatures.authenticating || streamFeatures.authenticated) {
        throw new SASLError("SASL: Unexpected authentication features");
      }
      streamFeatures.authenticating = true;
      const mechanisms = getAvailableMechanisms(element, NS, saslMechanisms);
      const inlineFeatures = await getStreamFeatures({ element, features });
      signal.throwIfAborted();
      const fast_available = !!fast?.mechanism;

      if (mechanisms.length === 0 && !fast_available) {
        entity.disconnect().catch(() => {});
        throw new SASLError("SASL: No compatible mechanism available.");
      }

      // SASL2 sends features immediately after success, while proof verification
      // can still be asynchronous. Binding must await the completed exchange.
      streamFeatures.authentication = onAuthenticate(
        done,
        mechanisms,
        fast_available ? fast : null,
        entity,
      ).then(() => {
        signal.throwIfAborted();
        streamFeatures.authenticated = true;
        streamFeatures.authenticating = false;
        return undefined;
      });
      await streamFeatures.authentication;

      async function done(credentials, mechanism, userAgent) {
        signal.throwIfAborted();
        // Try fast
        const success = await fast.auth({
          authenticate: (options) => authenticate({ ...options, signal }),
          entity,
          userAgent,
          streamFeatures: inlineFeatures,
          features,
          credentials,
        });
        signal.throwIfAborted();
        if (success) return;

        // fast.auth may mutate streamFeatures to request a token

        // If fast authentication fails, continue and try without
        await authenticate({
          entity,
          userAgent,
          streamFeatures: inlineFeatures,
          features,
          saslMechanisms,
          mechanism,
          credentials,
          signal,
        });
      }
    },
  );

  return {
    use(ns, req, res) {
      features.set(ns, [req, res]);
    },
    setup({ fast: _fast }) {
      fast = _fast;
    },
  };
}

async function getStreamFeatures({ element, features }) {
  const promises = [];

  const inline = element.getChild("inline");
  if (!inline) return promises;

  for (const element of inline.getChildElements()) {
    const xmlns = element.getNS();
    const feature = features.get(xmlns);
    if (!feature) continue;
    promises.push(feature[0](element));
  }

  return Promise.all(promises);
}
