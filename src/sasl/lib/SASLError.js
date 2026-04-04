import XMPPError from "../../error/index.js";

// https://xmpp.org/rfcs/rfc6120.html#sasl-errors

class SASLError extends XMPPError {
  constructor(...args) {
    super(...args);
    this.name = "SASLError";
  }
}

export default SASLError;
