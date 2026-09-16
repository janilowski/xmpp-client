import { encode, decode, decodeBytes } from "../util/base64.js";
import SASLError from "../sasl/lib/SASLError.js";
import xml from "../xml/index.js";
import { procedure } from "../events/index.js";
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
    xml("authenticate", { xmlns: NS, mechanism: mech.name }, [
      mech.clientFirst &&
        xml("initial-response", {}, response),
      userAgent,
      ...streamFeatures,
    ]),
    async (element, done, exchange) => {
      if (element.getNS() !== NS) return;

      if (element.name === "challenge") {
        const challenge = mech.binary
          ? decodeBytes(element.text())
          : decode(element.text());
        await mech.challenge(challenge);
        exchange.throwIfAborted();
        const resp = await mech.response(creds);
        exchange.throwIfAborted();
        await entity.send(
          xml(
            "response",
            { xmlns: NS, mechanism: mech.name },
            resp == null ? "" : encode(resp),
          ),
        );
        return;
      }

      if (element.name === "failure") {
        throw SASLError.fromElement(element);
      }

      if (element.name === "continue") {
        throw new Error("SASL continue is not supported yet");
      }

      if (element.name === "success") {
        const additionalData = element.getChild("additional-data")?.text();
        if (additionalData && mech.final) {
          await mech.final(
            mech.binary ? decodeBytes(additionalData) : decode(additionalData),
          );
          exchange.throwIfAborted();
        }

        // https://xmpp.org/extensions/xep-0388.html#success
        // this is a bare JID, unless resource binding or stream resumption has occurred, in which case it is a full JID.
        const aid = element.getChildText("authorization-identifier");
        if (aid) {
          entity._jid(aid);
        }

        for (const child of element.getChildElements()) {
          exchange.throwIfAborted();
          const feature = features.get(child.getNS());
          await feature?.[1]?.(child, exchange);
        }

        return done();
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
      const mechanisms = getAvailableMechanisms(element, NS, saslMechanisms);
      const streamFeatures = await getStreamFeatures({ element, features });
      signal.throwIfAborted();
      const fast_available = !!fast?.mechanism;

      if (mechanisms.length === 0 && !fast_available) {
        throw new SASLError("SASL: No compatible mechanism available.");
      }

      await onAuthenticate(
        done,
        mechanisms,
        fast_available ? fast : null,
        entity,
      );

      async function done(credentials, mechanism, userAgent) {
        signal.throwIfAborted();
        // Try fast
        const success = await fast.auth({
          authenticate: (options) => authenticate({ ...options, signal }),
          entity,
          userAgent,
          streamFeatures,
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
          streamFeatures,
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
