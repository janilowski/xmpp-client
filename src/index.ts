import {
  client as createClient,
  jid as createJid,
  xml as createXml,
} from "./client/index.js";

import type { ClientFactory, JIDFactory, XMLFactory } from "../types/index.js";

export type * from "../types/index.js";

export const client = createClient as ClientFactory;
export const jid = createJid as unknown as JIDFactory;
export const xml = createXml as XMLFactory;
