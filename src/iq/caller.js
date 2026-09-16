import xid from "../util/id.js";
import StanzaError from "../middleware/lib/StanzaError.js";
import operation from "../events/lib/operation.js";
import xml from "../xml/index.js";
import jid from "../jid/index.js";

// Match prepared wire identities; do not repair malformed sender addresses.
function replyMatches(from, { to, server, account }) {
  if (from === undefined) {
    return !to || to === server || to === account;
  }
  const slash = from.indexOf("/");
  if (!from || from.startsWith("@") || slash === from.length - 1) {
    return false;
  }
  let sender;
  try {
    sender = jid(from);
  } catch {
    return false;
  }
  const canonical =
    slash < 0
      ? from.toLowerCase()
      : from.slice(0, slash).toLowerCase() + from.slice(slash);
  if (sender.toString() !== canonical) {
    return false;
  }
  if (!to) {
    return canonical === server || canonical === account;
  }
  const target = jid(to);
  return target.equals(target.resource ? sender : sender.bare());
}

function isReply({ name, type }) {
  if (name !== "iq") return false;
  if (type !== "error" && type !== "result") return false;
  return true;
}

class IQCaller {
  constructor({ entity, middleware }) {
    this.handlers = new Map();
    this.entity = entity;
    this.middleware = middleware;
  }

  start() {
    this.middleware.use(this._route.bind(this));
  }

  _route({ type, name, id, stanza }, next) {
    if (!isReply({ name, type })) return next();

    const deferred = this.handlers.get(id);

    if (!deferred || !replyMatches(stanza.attrs.from, deferred)) {
      return next();
    }

    if (type === "error") {
      deferred.reject(StanzaError.fromElement(stanza.getChild("error")));
    } else {
      deferred.resolve(stanza);
    }

    this.handlers.delete(id);
  }

  async request(stanza, timeout = 30 * 1000, signal) {
    if (!stanza.attrs.id) {
      stanza.attrs.id = xid();
    }

    const { id, to } = stanza.attrs;
    if (this.handlers.has(id)) {
      throw new Error(`Duplicate IQ id: ${id}`);
    }
    // Snapshot the request identity before send or application callbacks run.
    const deferred = Object.assign(Promise.withResolvers(), {
      to: to === undefined ? undefined : jid(to.toString()).toString(),
      server:
        this.entity.jid?.domain || this.entity.options.domain?.toLowerCase(),
      account: this.entity.jid?.bare().toString(),
    });
    this.handlers.set(id, deferred);

    try {
      return await operation(
        this.entity,
        () => {
          Promise.resolve(this.entity.send(stanza)).catch(deferred.reject);
          return deferred.promise;
        },
        timeout,
        signal,
      );
    } finally {
      if (this.handlers.get(id) === deferred) {
        this.handlers.delete(id);
      }
    }
  }

  _childRequest(type, element, to, ...args) {
    const {
      name,
      attrs: { xmlns },
    } = element;
    return this.request(xml("iq", { type, to }, element), ...args).then(
      (stanza) => stanza.getChild(name, xmlns),
    );
  }

  async get(...args) {
    return this._childRequest("get", ...args);
  }

  async set(...args) {
    return this._childRequest("set", ...args);
  }
}

export default function iqCaller(...args) {
  const iqCaller = new IQCaller(...args);
  iqCaller.start();
  return iqCaller;
}
