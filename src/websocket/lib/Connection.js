import Connection from "../../connection/index.js";
import xml from "../../xml/index.js";
import { validateDocument, XML_CONTEXT } from "../../xml/lib/parseDocument.js";
import isLanguageTag from "../../xml/lib/language.js";

import Socket from "./Socket.js";
import FramedParser from "./FramedParser.js";

const NS_FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const XML_START_CHARACTER = "<";
const OPEN_ELEMENT = "open";
const XMPP_VERSION = "1.0";

/* References
 * WebSocket protocol https://tools.ietf.org/html/rfc6455
 * WebSocket Web API https://html.spec.whatwg.org/multipage/comms.html#network
 * XMPP over WebSocket https://tools.ietf.org/html/rfc7395
 */

class ConnectionWebSocket extends Connection {
  _validateHeader(source, expected) {
    // The socket repeats this guard for raw writes; openings must reject before stream setup.
    if (typeof source !== "string" || !source.startsWith(XML_START_CHARACTER)) {
      throw new TypeError("XMPP WebSocket frames must start with '<'");
    }
    try {
      let depth = 0;
      validateDocument(
        source,
        XML_CONTEXT.XMPP,
        (tag) => {
          depth += 1;
          if (
            depth !== 1 ||
            tag.local !== OPEN_ELEMENT ||
            tag.uri !== NS_FRAMING
          ) {
            throw new TypeError("Serialized opening has an invalid root");
          }
          if (tag.attributes.to?.value !== expected.to) {
            throw new TypeError("Serialized opening has an invalid target");
          }
          if (tag.attributes.version?.value !== XMPP_VERSION) {
            throw new TypeError("Serialized opening has an invalid version");
          }
          if (tag.attributes.id !== undefined) {
            throw new TypeError("An initiating opening must not contain an id");
          }
          const lang = tag.attributes["xml:lang"]?.value;
          if (lang !== undefined && lang !== "" && !isLanguageTag(lang)) {
            throw new TypeError("Invalid language tag");
          }
        },
        () => {
          depth -= 1;
        },
        (value) => {
          if (depth === 1 && value) {
            throw new TypeError("Serialized opening must be empty");
          }
        },
      );
    } catch (error) {
      throw new TypeError("Invalid outgoing XML", { cause: error });
    }
  }

  send(element, ...args) {
    element.attrs.xmlns ??= this.NS;
    element.attrs["xml:lang"] ??= this.root?.attrs["xml:lang"];
    return super.send(element, ...args);
  }

  async sendMany(elements) {
    for (const element of elements) {
      element.attrs.xmlns ??= this.NS;
      element.attrs["xml:lang"] ??= this.root?.attrs["xml:lang"];
      element.parent = this.root;
      // Bypass SM middleware during replay, not address or stream validation.
      await super.send(element);
    }
  }

  // https://tools.ietf.org/html/rfc7395#section-3.6
  footerElement() {
    return new xml.Element("close", {
      xmlns: NS_FRAMING,
    });
  }

  // https://tools.ietf.org/html/rfc7395#section-3.4
  headerElement() {
    const el = super.headerElement();
    el.name = "open";
    el.attrs.xmlns = NS_FRAMING;
    return el;
  }

  socketParameters(service) {
    return /^wss?:\/\//.test(service) ? service : undefined;
  }
}

ConnectionWebSocket.prototype.Socket = Socket;
ConnectionWebSocket.prototype.NS = "jabber:client";
ConnectionWebSocket.prototype.Parser = FramedParser;

export default ConnectionWebSocket;
