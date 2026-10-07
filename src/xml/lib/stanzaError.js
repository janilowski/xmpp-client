import isIRI from "./isIRI.js";

export const NS_STANZA = "urn:ietf:params:xml:ns:xmpp-stanzas";
export const TYPES = new Set(["auth", "cancel", "continue", "modify", "wait"]);
export const CONDITIONS = new Set([
  "bad-request",
  "conflict",
  "feature-not-implemented",
  "forbidden",
  "gone",
  "internal-server-error",
  "item-not-found",
  "jid-malformed",
  "not-acceptable",
  "not-allowed",
  "not-authorized",
  "policy-violation",
  "recipient-unavailable",
  "redirect",
  "registration-required",
  "remote-server-not-found",
  "remote-server-timeout",
  "resource-constraint",
  "service-unavailable",
  "subscription-required",
  "undefined-condition",
  "unexpected-request",
]);
const RESERVED_NAMESPACES = new Set([
  "jabber:client",
  "jabber:server",
  "http://etherx.jabber.org/streams",
]);
const CHARACTER_DATA = new Set(["text", "gone", "redirect"]);

// RFC 6120 §§8.3.1/8.3.2/.3.5/.3.14: validate one serialized core error.
// Feed the existing XML parser events; neither a second parse nor a tree is needed.
export default function createStanzaErrorValidator(namespace) {
  let depth = 0;
  let conditions = 0;
  let child;
  let address = "";

  return {
    open(tag) {
      depth += 1;
      if (depth === 1) {
        if (
          tag.local !== "error" ||
          tag.uri !== namespace ||
          !TYPES.has(tag.attributes.type?.value)
        ) {
          throw new TypeError("Invalid stanza error");
        }
        return;
      }
      if (depth === 2) {
        child = tag;
        address = "";
        if (tag.uri === NS_STANZA) {
          if (tag.local !== "text") {
            conditions += 1;
            if (!CONDITIONS.has(tag.local)) {
              throw new TypeError("Invalid stanza error condition");
            }
          }
        } else if (!tag.uri || RESERVED_NAMESPACES.has(tag.uri)) {
          throw new TypeError("Invalid stanza error application namespace");
        }
        return;
      }
      // Ordinary conditions and application extensions have no schema mandate.
      if (child.uri === NS_STANZA && CHARACTER_DATA.has(child.local)) {
        throw new TypeError("Invalid stanza error character data");
      }
    },
    close() {
      if (
        depth === 2 &&
        child.uri === NS_STANZA &&
        (child.local === "gone" || child.local === "redirect") &&
        address &&
        !isIRI(address)
      ) {
        throw new TypeError("Invalid stanza error address");
      }
      if (depth === 1 && conditions !== 1) {
        throw new TypeError("Invalid stanza error condition count");
      }
      depth -= 1;
    },
    text(text) {
      if (depth === 1 && text.trim()) {
        throw new TypeError("Invalid stanza error character data");
      }
      if (
        depth === 2 &&
        child.uri === NS_STANZA &&
        (child.local === "gone" || child.local === "redirect")
      ) {
        address += text;
      }
    },
  };
}
