import { client } from "../../src/client/index.js";
import Connection from "../../src/connection/index.js";

import context from "./context.js";

const clients = new Set();
export async function disconnectClients() {
  // Tests that inspect only part of negotiation still own its pending work.
  for (const client of clients) {
    client.reconnect.stop();
    client.emit("disconnect");
  }
  clients.clear();
  await Promise.resolve();
}

export default function mockClient(options) {
  const xmpp = client(options);
  clients.add(xmpp);
  xmpp.send = Connection.prototype.send;
  xmpp.sendMany = async (stanzas) => {
    for (const stanza of stanzas) {
      await xmpp.send(stanza);
    }
  };
  const ctx = context(xmpp);
  return Object.assign(xmpp, ctx);
}
