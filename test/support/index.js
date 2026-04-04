import xml from "../../src/xml/index.js";
import clone from "ltx/lib/clone.js";
import jid from "../../src/jid/index.js";
import { delay, promise, timeout } from "../../src/events/index.js";
import id from "../../src/util/id.js";

import mockClient from "./mockClient.js";
import mockClientCore from "./mockClientCore.js";
import context from "./context.js";
import mockSocket from "./mockSocket.js";

export {
  context,
  xml,
  jid,
  jid as JID,
  mockClient,
  mockClientCore,
  delay,
  promise,
  timeout,
  id,
  mockSocket,
  clone,
};

export function mockInput(entity, el) {
  entity.emit("input", el.toString());
  entity._onElement(el);
}

export async function promiseSend(entity) {
  const stanza = await promise(entity, "send", "");
  delete stanza.attrs.xmlns;
  return stanza;
}

export function promiseError(entity) {
  return promise(entity, "error", "");
}
