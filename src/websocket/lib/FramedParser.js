import { EventEmitter } from "../../events/index.js";
import XMLError from "../../xml/lib/XMLError.js";
import parseDocument, { XML_CONTEXT } from "../../xml/lib/parseDocument.js";

const NS_FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";

export default class FramedParser extends EventEmitter {
  #failed = false;
  #state = "opening";

  write(data) {
    if (this.#failed || this.#state === "closed") {
      return;
    }
    let element;
    try {
      if (typeof data !== "string" || !data.startsWith("<")) {
        throw new XMLError("An XMPP frame must start with <");
      }
      // WebSocket messages are documents, not chunks of a shared XML stream.
      element = parseDocument(data, XML_CONTEXT.XMPP);
      if (
        ["open", "close"].includes(element.getName()) &&
        element.getNS() !== NS_FRAMING
      ) {
        const error = new XMLError("Invalid framing namespace");
        error.condition = "invalid-namespace";
        throw error;
      }
      const opening = element.is("open", NS_FRAMING);
      const closing = element.is("close", NS_FRAMING);
      if (
        (this.#state === "opening" && !opening && !closing) ||
        (this.#state === "open" && opening)
      ) {
        throw new XMLError("Unexpected stream frame");
      }
    } catch (error_) {
      this.#failed = true;
      const error =
        error_ instanceof XMLError
          ? error_
          : new XMLError(error_.message, { cause: error_ });
      this.emit("error", error);
      return;
    }
    if (element.is("open", NS_FRAMING)) {
      this.#state = "open";
      this.emit("start", element);
    } else if (element.is("close", NS_FRAMING)) {
      this.#state = "closed";
      this.emit("end", element);
    } else {
      this.emit("element", element);
    }
  }

  end(data) {
    if (data) {
      this.write(data);
    }
  }
}
