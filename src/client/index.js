import { xml, jid, Client } from "../client-core/index.js";
import _reconnect from "../reconnect/index.js";
import _websocket from "../websocket/index.js";
import _middleware from "../middleware/index.js";
import _streamFeatures from "../stream-features/index.js";
import _iqCaller from "../iq/caller.js";
import _iqCallee from "../iq/callee.js";
import _resolve from "../resolve/index.js";
import _sasl2 from "../sasl2/index.js";
import _sasl from "../sasl/index.js";
import _resourceBinding from "../resource-binding/index.js";
import _streamManagement from "../stream-management/index.js";
import _bind2 from "../client-core/src/bind2/bind2.js";
import _fast from "../client-core/src/fast/fast.js";
import SASLFactory from "../sasl/factory.js";
import plain from "../sasl-plain/index.js";
import anonymous from "../sasl-anonymous/index.js";
import htsha256none from "../sasl-ht-sha-256-none/index.js";

import createOnAuthenticate from "./lib/createOnAuthenticate.js";
import getDomain from "./lib/getDomain.js";

function client(options = {}) {
  let { resource, credentials, username, password, userAgent, ...params } =
    options;

  const { domain, service } = params;
  if (!domain && service) {
    params.domain = getDomain(service);
  }

  const entity = new Client(params);
  if (username && params.domain) {
    entity.jid = jid(username, params.domain);
  }

  const reconnect = _reconnect({ entity });
  const websocket = _websocket({ entity });

  const middleware = _middleware({ entity });
  const streamFeatures = _streamFeatures({ middleware });
  const iqCaller = _iqCaller({ middleware, entity });
  const iqCallee = _iqCallee({ middleware, entity });
  const resolve = _resolve({ entity });

  // SASL mechanisms - order matters and define priority
  const saslFactory = new SASLFactory();
  const mechanisms = Object.entries({
    plain,
    anonymous,
  }).map(([k, v]) => ({ [k]: v(saslFactory) }));

  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  userAgent ??= xml("user-agent", { id: globalThis.crypto.randomUUID() });

  // Stream features - order matters and define priority
  const sasl2 = _sasl2(
    { streamFeatures, saslFactory },
    createOnAuthenticate(credentials ?? { username, password }, userAgent),
  );

  const fast = _fast({
    sasl2,
    entity,
  });
  sasl2.setup({ fast });

  // SASL2 inline features
  const bind2 = _bind2({ sasl2, entity }, resource);

  // FAST mechanisms - order matters and define priority
  htsha256none(fast.saslFactory);

  // Stream features - order matters and define priority
  const sasl = _sasl(
    { streamFeatures, saslFactory },
    createOnAuthenticate(credentials ?? { username, password }, userAgent),
  );
  const streamManagement = _streamManagement({
    streamFeatures,
    entity,
    middleware,
    bind2,
    sasl2,
  });
  const resourceBinding = _resourceBinding(
    { iqCaller, streamFeatures },
    resource,
  );

  iqCallee?.get("urn:xmpp:ping", "ping", () => {
    return {};
  });

  return Object.assign(entity, {
    entity,
    reconnect,
    websocket,
    middleware,
    streamFeatures,
    iqCaller,
    iqCallee,
    resolve,
    saslFactory,
    sasl2,
    sasl,
    resourceBinding,
    streamManagement,
    mechanisms,
    bind2,
    fast,
  });
}

export { xml, jid, client };
