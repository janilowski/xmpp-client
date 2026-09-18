import XMPPError from "../../error/index.js";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const CONDITIONS = new Set([
  "aborted",
  "account-disabled",
  "credentials-expired",
  "encryption-required",
  "incorrect-encoding",
  "invalid-authzid",
  "invalid-mechanism",
  "malformed-request",
  "mechanism-too-weak",
  "not-authorized",
  "temporary-auth-failure",
]);

// https://xmpp.org/rfcs/rfc6120.html#sasl-errors

class SASLError extends XMPPError {
  static fromElement(element) {
    // RFC 6120 §6.5: unknown conditions are generic authentication failure.
    // SASL2 retains SASL's condition namespace and permits application details.
    const children = element.getChildElements();
    const condition = children.find(
      (child) => child.getNS() === SASL && child.name !== "text",
    );
    const error = new this(
      CONDITIONS.has(condition?.name) ? condition.name : "not-authorized",
      element.getChildText("text", element.getNS()) || "",
      children.find(
        (child) => child.getNS() !== SASL && child.getNS() !== element.getNS(),
      ),
    );
    error.element = element;
    return error;
  }

  constructor(...args) {
    super(...args);
    this.name = "SASLError";
  }
}

export default SASLError;
