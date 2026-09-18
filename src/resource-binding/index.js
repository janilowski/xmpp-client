import xml from "../xml/index.js";
import { prepareResource } from "../jid/lib/precis.js";
import parseJID from "../jid/index.js";

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
  const result = await iqCaller.request(
    xml("iq", { type: "set" }, makeBindElement(resource)),
    entity.timeout,
    signal,
  );
  signal.throwIfAborted();
  // RFC 6120 §7: only an unambiguous full JID completes resource binding.
  const children = result.getChildElements();
  const binding = result.getChild("bind", NS);
  const identities = binding?.getChildren("jid", NS) ?? [];
  if (children.length !== 1 || identities.length !== 1 ||
      binding.getChildElements().length !== 1 ||
      identities[0].getChildElements().length !== 0) {
    throw new Error("Invalid resource binding result");
  }
  const jid = parseJID(identities[0].text());
  if (!jid.local || !jid.resource) {
    throw new Error("Resource binding requires a full JID");
  }
  entity._jid(jid.toString());
  entity._ready(false);
  return jid;
}

function route({ iqCaller, streamFeatures }, resource) {
  return async ({ entity }, next, _feature, signal) => {
    if (!streamFeatures.authenticated) {
      throw new Error("Resource binding requires authentication");
    }
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
  streamFeatures.use("bind", NS, route({ iqCaller, streamFeatures }, resource));
}
