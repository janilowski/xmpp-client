/**
 * References
 * https://xmpp.org/rfcs/rfc6120.html#streams-negotiation Stream Negotiation
 * https://xmpp.org/extensions/xep-0170.html XEP-0170: Recommended Order of Stream Feature Negotiation
 * https://xmpp.org/registrar/stream-features.html XML Stream Features
 */

import operation from "../events/lib/operation.js";

export default function streamFeatures({ middleware, entity }) {
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
  function use(name, xmlns, handler) {
    return middleware.use((ctx, next) => {
      const { stanza } = ctx;
      if (!stanza.is("features", "http://etherx.jabber.org/streams"))
        return next();
      const feature = stanza.getChild(name, xmlns);
      if (!feature) return next();
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
