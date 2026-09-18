/**
 * References
 * https://xmpp.org/rfcs/rfc6120.html#streams-negotiation Stream Negotiation
 * https://xmpp.org/extensions/xep-0170.html XEP-0170: Recommended Order of Stream Feature Negotiation
 * https://xmpp.org/registrar/stream-features.html XML Stream Features
 */

import operation from "../events/lib/operation.js";

const NS = "http://etherx.jabber.org/streams";

export default function streamFeatures({ middleware, entity }) {
  const handlers = [];
  // SASL stream restarts preserve authentication; a new connection never does.
  const features = {
    use,
    authenticated: false,
    authenticating: false,
    authentication: null,
  };
  const reset = () => {
    features.authenticated = false;
    features.authenticating = false;
    features.authentication = null;
  };
  entity.on("connect", reset);
  entity.on("disconnect", reset);

  middleware.use((ctx, next) => {
    const { stanza } = ctx;
    if (!stanza.is("features", NS)) {
      return next();
    }
    if (
      stanza
        .getChildElements()
        .some(
          (child) =>
            !child.getNS() ||
            child.getNS() === NS ||
            child.getNS() === entity.NS,
        )
    ) {
      entity.disconnect().catch(() => {});
      throw new Error("Invalid stream feature namespace");
    }
    if (handlers.some(([name, xmlns]) => stanza.getChild(name, xmlns))) {
      return next();
    }
    return operation(entity, async (signal) => {
      // SASL2 inline binding may still be verifying its server proof.
      await features.authentication;
      signal.throwIfAborted();
      // A final empty offer can arrive while the application is already closing.
      if (entity.status === "open") {
        entity.disconnect().catch(() => {});
        throw new Error("Unsupported stream features");
      }
      return next();
    });
  });

  function use(name, xmlns, handler) {
    handlers.push([name, xmlns]);
    return middleware.use((ctx, next) => {
      const { stanza } = ctx;
      if (!stanza.is("features", NS)) {
        return next();
      }
      const feature = stanza.getChild(name, xmlns);
      if (!feature) {
        return next();
      }
      return operation(ctx.entity, (signal) =>
        handler(
          ctx,
          () => {
            signal.throwIfAborted();
            return next();
          },
          feature,
          signal,
        ),
      );
    });
  }

  return features;
}
