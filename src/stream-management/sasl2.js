import { NS, makeResumeElement } from "./index.js";

export function setupSasl2({ sasl2, sm, failed, resumed }) {
  sasl2.use(
    NS,
    (element) => {
      if (!element.is("sm")) return;
      if (sm.id) return makeResumeElement({ sm });
    },
    (element, signal) => {
      if (element.is("resumed")) {
        return resumed(element, signal);
      } else if (element.is("failed")) {
        failed(element);
      }
    },
  );
}
