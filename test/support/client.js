import { Client } from "../../src/client-core/index.js";
import JID from "../../src/jid/index.js";

import mockSocket from "./mockSocket";

export default function client(entity = new Client()) {
  entity.socket = mockSocket();
  entity.jid = new JID("foo@bar/test");
  return entity;
}
