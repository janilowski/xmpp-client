import xml from "../xml/index.js";
import { prepareResource } from "../jid/lib/precis.js";
import parseJID from "../jid/index.js";
import StreamError from "../connection/lib/StreamError.js";
import { setReplyMatcher } from "../iq/lib/replyMatcher.js";

/*
 * References
 * https://xmpp.org/rfcs/rfc6120.html#bind
 */

const NS = "urn:ietf:params:xml:ns:xmpp-bind";

function makeBindElement(resource) {
  return xml(
    "bind",
    { xmlns: NS },
    resource && xml("resource", {}, resource),
  );
}

function parseBinding(result) {
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
  return jid;
}

async function bind(entity, iqCaller, resource, signal) {
  const request = xml("iq", { type: "set" }, makeBindElement(resource));
  // RFC 6120 §§4.3.6/8.1.2.1: binding discovers the canonical account.
  setReplyMatcher(request, (stanza) => {
    const sender = parseJID(stanza.attrs.from);
    if (!sender.local || sender.resource) {
      return false;
    }
    // An account-bare error rejects binding but never establishes identity.
    return (
      stanza.attrs.type === "error" ||
      sender.equals(parseBinding(stanza).bare())
    );
  });
  const result = await iqCaller.request(request, entity.timeout, signal);
  signal.throwIfAborted();
  const jid = parseBinding(result);
  entity._jid(jid.toString());
  entity._ready(false);
  return jid;
}

function route({ iqCaller, streamFeatures, entity }, resource) {
  let conflictedResource;
  entity.on("error", (error) => {
    if (error instanceof StreamError && error.condition === "conflict") {
      conflictedResource = entity.jid?.resource;
    }
  });
  return async ({ entity }, next, _feature, signal) => {
    await streamFeatures.authentication;
    signal.throwIfAborted();
    if (!streamFeatures.authenticated) {
      throw new Error("Resource binding requires authentication");
    }
    const requested =
      typeof resource === "function" ? await resource() : resource;
    signal.throwIfAborted();
    let selected = requested && prepareResource(requested);
    // RFC 6120 §4.9.3.3: do not reclaim the former resource after conflict.
    if (conflictedResource && (!selected || selected === conflictedResource)) {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      selected = globalThis.crypto.randomUUID();
      if (selected === conflictedResource) {
        selected += "-retry";
      }
    }
    await bind(entity, iqCaller, selected, signal);
    signal.throwIfAborted();
    return next();
  };
}

export default function resourceBinding(
  { streamFeatures, iqCaller, entity },
  resource,
) {
  streamFeatures.use(
    "bind",
    NS,
    route({ iqCaller, streamFeatures, entity }, resource),
  );
}
