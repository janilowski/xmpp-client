import { NS, makeResumeElement } from "./index.js";

const SASL2 = "urn:xmpp:sasl:2";

export function setupSasl2({ sasl2, sm, failed, resumed, hasResumeId }) {
  sasl2.use(
    NS,
    (element) => {
      if (!element.is("sm")) return;
      if (hasResumeId()) {
        return makeResumeElement({ sm });
      }
    },
    (element, signal) => {
      if (element.is("resumed")) {
        return resumed(
          element,
          signal,
          element.parent.getChildText("authorization-identifier", SASL2),
        );
      } else if (element.is("failed")) {
        failed(element);
      }
    },
  );
}
