import stringify from "ltx/lib/stringify.js";
import xml from "../xml/index.js";
import clone from "ltx/lib/clone.js";

/* eslint no-console: 0 */

const NS_SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const NS_SASL2 = "urn:xmpp:sasl:2";
const NS_COMPONENT = "jabber:component:accept";
const NS_FAST = "urn:xmpp:fast:0";

const SENSITIVES = [
  ["handshake", NS_COMPONENT],
  ["auth", NS_SASL],
  ["challenge", NS_SASL],
  ["response", NS_SASL],
  ["success", NS_SASL],
  ["challenge", NS_SASL2],
  ["response", NS_SASL2],
];

function isSensitive(element) {
  if (element.children.length === 0) return false;
  return SENSITIVES.some((sensitive) => {
    return element.is(...sensitive);
  });
}

function hide(element) {
  if (element) {
    element.children = [];
    element.append(xml("hidden", { xmlns: "xmpp-client" }));
  }
}

export function hideSensitive(element) {
  // Match every qualified field; foreign lookalikes must not hide real secrets.
  if (isSensitive(element)) {
    hide(element);
  } else if (element.is("authenticate", NS_SASL2)) {
    for (const response of element.getChildren("initial-response", NS_SASL2)) {
      hide(response);
    }
  } else if (element.getNS() === NS_SASL2) {
    for (const data of element.getChildren("additional-data", NS_SASL2)) {
      hide(data);
    }
    for (const token of element.getChildren("token", NS_FAST)) {
      token.attrs.token = "hidden by xmpp-client";
    }
  }

  return element;
}

function format(element) {
  return stringify(hideSensitive(clone(element)), 2);
}

export default function debug(entity, force) {
  if (process.env.XMPP_DEBUG || force === true) {
    entity.on("element", (data) => {
      console.debug(`IN\n${format(data)}`);
    });

    entity.on("send", (data) => {
      console.debug(`OUT\n${format(data)}`);
    });

    entity.on("error", console.error);

    entity.on("status", (status, value) => {
      console.debug("status", status, value ? value.toString() : "");
    });
  }
}
