import { client, jid, xml } from "@janilowski/xmpp-client";

const address = jid("romeo@example.net/orchard");
const presence = xml("presence", { to: address.bare() });
const xmpp = client({
  service: "wss://example.net/xmpp-websocket",
  credentials: { username: "romeo", password: "secret" },
});

xmpp.on("stanza", (stanza: typeof presence) => stanza.toString());
void xmpp.send(presence);
void xmpp.start().then((onlineAddress) => onlineAddress.bare().toString());
