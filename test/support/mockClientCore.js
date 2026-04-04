import { Client } from "../../src/client-core/index.js";
import Connection from "../../src/connection/index.js";

import context from "./context.js";

export default function mockClient(options) {
  const xmpp = new Client(options);
  xmpp.send = Connection.prototype.send;
  const ctx = context(xmpp);
  return Object.assign(xmpp, ctx);
}
