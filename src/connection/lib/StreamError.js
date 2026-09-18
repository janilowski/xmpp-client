import XMPPError from "../../error/index.js";

// https://xmpp.org/rfcs/rfc6120.html#streams-error

const NS = "urn:ietf:params:xml:ns:xmpp-streams";
const CONDITIONS = new Set([
  "bad-format",
  "bad-namespace-prefix",
  "conflict",
  "connection-timeout",
  "host-gone",
  "host-unknown",
  "improper-addressing",
  "internal-server-error",
  "invalid-from",
  "invalid-namespace",
  "invalid-xml",
  "not-authorized",
  "not-well-formed",
  "policy-violation",
  "remote-connection-failed",
  "reset",
  "resource-constraint",
  "restricted-xml",
  "see-other-host",
  "system-shutdown",
  "undefined-condition",
  "unsupported-encoding",
  "unsupported-feature",
  "unsupported-stanza-type",
  "unsupported-version",
]);

class StreamError extends XMPPError {
  static fromElement(element) {
    // Even malformed fatal errors must close the stream, never crash parsing.
    return super.fromElement(element, NS, CONDITIONS);
  }

  constructor(...args) {
    super(...args);
    this.name = "StreamError";
  }
}

export default StreamError;
