import XMPPError from "../../error/index.js";

/* https://xmpp.org/rfcs/rfc6120.html#stanzas-error */

const NS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const TYPES = new Set(["auth", "cancel", "continue", "modify", "wait"]);
const CONDITIONS = new Set([
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

class StanzaError extends XMPPError {
  constructor(condition, text, application, type) {
    super(condition, text, application);
    this.type = type;
    this.name = "StanzaError";
  }

  static fromElement(element) {
    const children = element?.getChildElements() ?? [];
    const conditions = children.filter(
      (child) => child.getNS() === NS && !child.is("text", NS),
    );
    if (!TYPES.has(element?.attrs.type) || conditions.length !== 1) {
      throw new Error("Invalid stanza error");
    }
    const error = super.fromElement(element, NS, CONDITIONS);
    error.type = element.attrs.type;
    return error;
  }
}

export default StanzaError;
