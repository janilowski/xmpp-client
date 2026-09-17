/**
 * [XEP-0175: Best Practices for Use of SASL ANONYMOUS](https://xmpp.org/extensions/xep-0175.html)
 * [RFC-4505: Anonymous Simple Authentication and Security Layer (SASL) Mechanism](https://www.rfc-editor.org/rfc/rfc4505.html)
 */

import type SASLMechanismRegistry from "../sasl/registry.ts";

const NAME = "ANONYMOUS";

export default function registerAnonymous(
  saslMechanisms: SASLMechanismRegistry,
) {
  saslMechanisms.register(NAME, () => ({
    name: NAME,
    clientFirst: true,
    challenge() {},
    response({ trace }) {
      return typeof trace === "string" ? trace : "";
    },
  }));
}
