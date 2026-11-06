import { compare as compareAltConnections } from "./alt-connections.js";
import isUnexpired from "./xrdExpiry.js";
import readXML from "./readXML.ts";
import prepareURI from "./xrdURI.ts";
import getBunTLSOptions from "../../util/bun-tls.ts";

const NS_XRD = "http://docs.oasis-open.org/ns/xri/xrd-1.0";
const DISCOVERY_TIMEOUT_MS = 5000;
const METHODS = new Map([
  ["urn:xmpp:alt-connections:websocket", new Set(["ws:", "wss:"])],
  ["urn:xmpp:alt-connections:httppoll", new Set(["http:", "https:"])],
  ["urn:xmpp:alt-connections:xbosh", new Set(["http:", "https:"])],
]);

export async function resolve(domain, { signal } = {}) {
  try {
    const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    const url = `https://${domain}/.well-known/host-meta`;
    const tls = getBunTLSOptions(url);
    // Fail closed rather than letting a redirect change the trusted origin/scheme.
    const res = await fetch(url, {
      redirect: "error",
      signal: requestSignal,
      ...(tls ? { tls } : {}),
    });
    if (!res.ok) {
      return [];
    }
    if (!res.body) {
      return [];
    }
    const document = await readXML(res, requestSignal);
    if (!document.is("XRD", NS_XRD)) {
      return [];
    }
    const expires = document.getChildren("Expires", NS_XRD);
    if (
      expires.length > 1 ||
      (expires.length === 1 && !isUnexpired(expires[0]))
    ) {
      return [];
    }
    return document
      .getChildren("Link", NS_XRD)
      .filter(({ attrs }) => {
        // RFC 6415 §4.1: templates describe resources, not the whole host.
        if (attrs.template !== undefined) {
          return false;
        }
        try {
          const uri = new URL(prepareURI(attrs.href));
          return (
            METHODS.get(prepareURI(attrs.rel).toLowerCase())?.has(uri.protocol) &&
            !uri.username &&
            !uri.password
          );
        } catch {
          return false;
        }
      })
      .map(({ attrs }) => ({
        rel: attrs.rel,
        href: attrs.href,
        method: prepareURI(attrs.rel).toLowerCase().split(":").pop(),
        uri: new URL(prepareURI(attrs.href)).href,
      }))
      .toSorted(compareAltConnections);
  } catch {
    return [];
  }
}
