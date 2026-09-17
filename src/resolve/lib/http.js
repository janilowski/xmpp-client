import parse, { MAX_XML_BYTES } from "../../xml/lib/parseDocument.js";

import { compare as compareAltConnections } from "./alt-connections.js";
import isUnexpired from "./xrdExpiry.js";

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
    if (!res.body) {
      return [];
    }
    // Bound decompressed bytes while reading, not after allocating the body.
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > MAX_XML_BYTES) {
          return [];
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const document = parse(text);
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
          const uri = new URL(attrs.href);
          return (
            METHODS.get(attrs.rel?.toLowerCase())?.has(uri.protocol) &&
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
        method: attrs.rel.toLowerCase().split(":").pop(),
        uri: new URL(attrs.href).href,
      }))
      .toSorted(compareAltConnections);
  } catch {
    return [];
  }
}
