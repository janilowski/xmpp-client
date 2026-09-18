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
  let sender;
  try {
    sender = jid(from);
  } catch {
    return false;
  }
  if (!to) {
    return sender.toString() === server || sender.toString() === account;
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

    try {
      const children = stanza.getChildElements();
      const errors = stanza.getChildren("error", stanza.getNS());
      if (type === "error") {
        if (errors.length !== 1 || children.length > 2) {
          throw new Error("Invalid IQ response");
        }
        deferred.reject(StanzaError.fromElement(errors[0]));
      } else {
        if (children.length > 1 || errors.length !== 0) {
          throw new Error("Invalid IQ response");
        }
        deferred.resolve(stanza);
      }
    } catch (error) {
      // Bad replies fail this request, never generate a response loop.
      deferred.reject(error);
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
        this.entity.jid?.domain ||
        (this.entity.options.domain && jid(this.entity.options.domain).domain),
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
