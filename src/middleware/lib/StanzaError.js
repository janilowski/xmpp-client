import XMPPError from "../../error/index.js";
import {
  TYPES,
  CONDITIONS,
  NS_STANZA as NS,
} from "../../xml/lib/stanzaError.js";

export { TYPES, CONDITIONS } from "../../xml/lib/stanzaError.js";

/* https://xmpp.org/rfcs/rfc6120.html#stanzas-error */

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
