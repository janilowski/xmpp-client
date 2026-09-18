import { encode, decode, decodeBytes } from "../util/base64.js";
import xml from "../xml/index.js";
import { procedure } from "../events/index.js";
import SASLError from "./lib/SASLError.js";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";

// One challenge/response at a time, shared by the SASL and SASL2 adapters.
// A peer failure interrupts work; local abort waits for its failure acknowledgement.
export default function exchange(
  entity,
  stanza,
  mech,
  credentials,
  onSuccess,
  parent,
) {
  const namespace = stanza.getNS();
  let responding = false;
  let aborted = false;
  const onSend = (element) => {
    if (element.is("abort", namespace)) {
      aborted = true;
    }
  };
  entity.on("send", onSend);
  return procedure(
    entity,
    stanza,
    async (element, done, signal) => {
      if (element.getNS() !== namespace) {
        return;
      }
      if (element.name === "failure") {
        throw SASLError.fromElement(element);
      }
      if (
        responding ||
        aborted ||
        !["challenge", "success"].includes(element.name)
      ) {
        throw new SASLError("SASL: Unexpected negotiation element");
      }
      if (
        (element.name === "challenge" || namespace === SASL) &&
        element.getChildElements().length
      ) {
        throw new SASLError("SASL: Unexpected child in mechanism data");
      }
      responding = true;
      try {
        if (element.name === "challenge") {
          await mech.challenge(
            mech.binary ? decodeBytes(element.text()) : decode(element.text()),
          );
          signal.throwIfAborted();
          if (aborted) {
            return;
          }
          const response = await mech.response(credentials);
          signal.throwIfAborted();
          if (!aborted) {
            await entity.send(
              xml(
                "response",
                { xmlns: namespace },
                response == null ? "" : encode(response),
              ),
            );
          }
          return;
        }

        // Always validate success data, including mechanisms without final hooks.
        const data =
          namespace === SASL
            ? element.text() === "="
              ? ""
              : element.text()
            : (element.getChild("additional-data", namespace)?.text() ?? "");
        const final = mech.binary ? decodeBytes(data) : decode(data);
        if (mech.final) {
          await mech.final(final);
        }
        signal.throwIfAborted();
        if (aborted) {
          return;
        }
        await onSuccess?.(element, signal);
        signal.throwIfAborted();
        return done();
      } finally {
        responding = false;
      }
    },
    parent,
  ).finally(() => entity.removeListener("send", onSend));
}
