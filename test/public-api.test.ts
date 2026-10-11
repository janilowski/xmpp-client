import { client, jid, xml } from "@janilowski/xmpp-client";
import xmlExport, { Element, createElement } from "@janilowski/xmpp-client/xml";
import { Fragment, jsx, jsxs } from "@janilowski/xmpp-client/xml/jsx-runtime";
import { jsxDEV } from "@janilowski/xmpp-client/xml/jsx-dev-runtime";

const address = jid("romeo@example.net/orchard");
const presence = xml("presence", { to: address.bare() });
const xmpp = client({
  service: "wss://example.net/xmpp-websocket",
  credentials: { username: "romeo", password: "secret" },
});

xmpp.on("stanza", (stanza: typeof presence) => stanza.toString());
void xmpp.send(presence);
void xmpp.start().then((onlineAddress) => onlineAddress.bare().toString());

// Check every published entry point without suppressing declaration errors.
const element: Element = new Element("message");
const message: Element = xmlExport("message", {}, element);
const created: Element = createElement("presence", { to: address });
const jsxElement: Element = jsx("presence", { to: address });
const jsxElements: Element = jsxs("message", { children: "text" });
const developmentElement: Element = jsxDEV("presence", { to: address });
void [message, created, jsxElement, jsxElements, developmentElement, Fragment];

// @ts-expect-error Stanzas must be XML elements, not serialized strings.
void xmpp.send("<presence/>");
// @ts-expect-error Credentials require a string password.
client({ password: 123 });
// @ts-expect-error Service addresses must be strings.
client({ service: 123 });
