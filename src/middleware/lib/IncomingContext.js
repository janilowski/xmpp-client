import JID from "../../jid/index.js";
import { getAccount } from "../../connection/lib/negotiation.js";

import Context from "./Context.js";

export default class IncomingContext extends Context {
  constructor(entity, stanza) {
    super(entity, stanza);

    const { jid } = entity;

    const to = stanza.attrs.to ?? jid?.toString();
    const from = stanza.attrs.from ?? getAccount(entity);

    if (to !== undefined) {
      this.to = new JID(to);
    }

    if (from !== undefined) {
      this.from = new JID(from);
      this.local = this.from.local;
      this.domain = this.from.domain;
      this.resource = this.from.resource;
    }
  }
}
