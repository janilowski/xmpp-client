import parse from "../../xml/lib/parseDocument.js";

import { compare as compareAltConnections } from "./alt-connections.js";

const NS_XRD = "http://docs.oasis-open.org/ns/xri/xrd-1.0";
const DISCOVERY_TIMEOUT_MS = 5000;
const METHODS = new Map([
  ["urn:xmpp:alt-connections:websocket", new Set(["ws:", "wss:"])],
  ["urn:xmpp:alt-connections:httppoll", new Set(["http:", "https:"])],
  ["urn:xmpp:alt-connections:xbosh", new Set(["http:", "https:"])],
]);

export async function resolve(domain) {
  try {
    // Fail closed rather than letting a redirect change the trusted origin/scheme.
    const res = await fetch(`https://${domain}/.well-known/host-meta`, {
      redirect: "error",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      return [];
    }
    const text = await res.text();
    const document = parse(text);
    if (!document.is("XRD", NS_XRD)) {
      return [];
    }
    return document
      .getChildren("Link", NS_XRD)
      .filter(({ attrs }) => {
        try {
          const uri = new URL(attrs.href);
          return (
            METHODS.get(attrs.rel)?.has(uri.protocol) &&
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
        method: attrs.rel.split(":").pop(),
        uri: attrs.href,
      }))
      .toSorted(compareAltConnections);
  } catch {
    return [];
  }
}
