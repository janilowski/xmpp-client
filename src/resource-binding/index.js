import xml from "../xml/index.js";
import { prepareResource } from "../jid/lib/precis.js";

/*
 * References
 * https://xmpp.org/rfcs/rfc6120.html#bind
 */

const NS = "urn:ietf:params:xml:ns:xmpp-bind";

function makeBindElement(resource) {
  return xml(
    "bind",
    { xmlns: NS },
    resource && xml("resource", {}, prepareResource(resource)),
  );
}

async function bind(entity, iqCaller, resource, signal) {
  const result = await iqCaller.set(
    makeBindElement(resource),
    undefined,
    entity.timeout,
    signal,
  );
  signal.throwIfAborted();
  const jid = result.getChildText("jid");
  entity._jid(jid);
  entity._ready(false);
  return jid;
}

function route({ iqCaller }, resource) {
  return async ({ entity }, next, _feature, signal) => {
    const selected =
      typeof resource === "function" ? await resource() : resource;
    signal.throwIfAborted();
    await bind(entity, iqCaller, selected, signal);
    signal.throwIfAborted();
    return next();
  };
}

export default function resourceBinding(
  { streamFeatures, iqCaller },
  resource,
) {
  streamFeatures.use("bind", NS, route({ iqCaller }, resource));
}
