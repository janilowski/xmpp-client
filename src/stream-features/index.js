/**
 * References
 * https://xmpp.org/rfcs/rfc6120.html#streams-negotiation Stream Negotiation
 * https://xmpp.org/extensions/xep-0170.html XEP-0170: Recommended Order of Stream Feature Negotiation
 * https://xmpp.org/registrar/stream-features.html XML Stream Features
 */

import operation from "../events/lib/operation.js";
import TimeoutError from "../events/lib/TimeoutError.js";

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

  // Each stream opening owes us features, including SASL restarts/reconnects.
  // The duration is client policy; RFC 6120 §4.3 specifies no fixed deadline.
  let featureTimer;
  const clearFeatureTimer = () => clearTimeout(featureTimer);
  entity.on("open", () => {
    clearFeatureTimer();
    featureTimer = setTimeout(() => {
      entity.disconnect().catch(() => {});
      entity.emit(
        "error",
        new TimeoutError("Timed out waiting for stream features"),
      );
    }, entity.timeout);
  });
  entity.on("closing", clearFeatureTimer);
  entity.on("close", clearFeatureTimer);
  entity.on("disconnect", clearFeatureTimer);
  entity.on("error", clearFeatureTimer);

  middleware.use((ctx, next) => {
    const { stanza } = ctx;
    if (!stanza.is("features", NS)) {
      return next();
    }
    clearFeatureTimer();
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
