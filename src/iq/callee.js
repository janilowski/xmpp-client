import xml from "../xml/index.js";
import createStanzaErrorValidator, {
  TYPES,
  CONDITIONS,
  NS_STANZA,
} from "../xml/lib/stanzaError.js";
import isIRI from "../xml/lib/isIRI.js";
import { validateDocument, XML_CONTEXT } from "../xml/lib/parseDocument.js";

/**
 * References
 * https://xmpp.org/rfcs/rfc6120.html#stanzas-semantics-iq
 * https://xmpp.org/rfcs/rfc6120.html#stanzas-error
 */

const RESERVED_NAMESPACES = new Set([
  "jabber:client",
  "jabber:server",
  "http://etherx.jabber.org/streams",
]);

function preserveNamespaces(element) {
  // Reparenting must preserve the closest binding, including distinct prefix aliases.
  const namespaces = Object.create(null);
  const ancestors = new Set();
  for (let parent = element; parent; parent = parent.parent) {
    if (ancestors.has(parent)) {
      throw new Error("Invalid XML parent chain");
    }
    ancestors.add(parent);
    for (const [attribute, value] of Object.entries(parent.attrs)) {
      if (
        (attribute === "xmlns" || attribute.startsWith("xmlns:")) &&
        value != null &&
        namespaces[attribute] === undefined
      ) {
        namespaces[attribute] = value;
      }
    }
  }
  Object.assign(element.attrs, namespaces);

  // Namespace lookup and serialization must agree for both ltx constructors.
  const pending = [element];
  const visited = new Set();
  while (pending.length) {
    const child = pending.pop();
    if (visited.has(child)) {
      continue;
    }
    visited.add(child);
    for (const [attribute, value] of Object.entries(child.attrs)) {
      if (
        (attribute === "xmlns" || attribute.startsWith("xmlns:")) &&
        value != null &&
        typeof value !== "string"
      ) {
        child.attrs[attribute] = value.toString(10);
      }
    }
    pending.push(
      ...child.children.filter((node) => typeof node?.getNS === "function"),
    );
  }
}

function validateError(element, namespace) {
  // Convert addresses before checking structure: scalar conversion can change the tree.
  for (const child of element.children) {
    if (
      typeof child?.getNS !== "function" ||
      (!child.is("gone", NS_STANZA) && !child.is("redirect", NS_STANZA))
    ) {
      continue;
    }
    if (
      child.children.some(
        (node) =>
          typeof node?.getNS === "function" ||
          typeof node?.write === "function",
      )
    ) {
      throw new Error("Invalid generated stanza error address");
    }
    // Validate the same character data the writer emits, converting scalars once.
    child.children = child.children
      .filter((node) => node != null)
      .map((node) => {
        const text = typeof node === "string" ? node : node.toString(10);
        if (typeof text !== "string") {
          throw new Error("Invalid generated stanza error address");
        }
        return text;
      });
  }

  const children = element.children.filter(
    (child) => typeof child?.getNS === "function",
  );
  const conditions = children.filter(
    (child) => child.getNS() === NS_STANZA && !child.is("text", NS_STANZA),
  );
  const rootNamespace = element.getNS();
  if (
    element.name !== "error" ||
    (rootNamespace !== undefined && rootNamespace !== namespace) ||
    !TYPES.has(element.attrs.type) ||
    conditions.length !== 1 ||
    !CONDITIONS.has(conditions[0].getName())
  ) {
    throw new Error("Invalid generated stanza error");
  }

  const condition = conditions[0];
  if (condition.is("gone", NS_STANZA) || condition.is("redirect", NS_STANZA)) {
    // A conversion may replace/rename the condition; validate only its final text.
    const text = condition.children.filter((node) => node != null);
    if (
      text.some(
        (node) => typeof node === "object" || typeof node === "function",
      )
    ) {
      throw new Error("Invalid generated stanza error address");
    }
    condition.children = text.map((node) =>
      typeof node === "string" ? node : node.toString(10),
    );
    const address = condition.children.join("");
    if (address && !isIRI(address)) {
      throw new Error("Invalid generated stanza error address");
    }
  }

  for (const child of children) {
    const namespace = child.getNS();
    if (namespace === NS_STANZA) {
      if (
        child.is("text", NS_STANZA) &&
        child.children.some((node) => typeof node?.getNS === "function")
      ) {
        throw new Error("Invalid generated stanza error");
      }
      continue;
    }
    if (!namespace || RESERVED_NAMESPACES.has(namespace)) {
      throw new Error("Invalid generated stanza error");
    }
  }
}

function captureError(element, namespace) {
  // Call the real writer once; later query/scalar callbacks cannot change these bytes.
  let source = "";
  element.write((chunk) => {
    source += chunk;
  });

  let snapshot;
  let cursor;
  let depth = 0;
  const validator = createStanzaErrorValidator(namespace);
  validateDocument(
    `<iq xmlns="${namespace}">${source}</iq>`,
    XML_CONTEXT.XMPP,
    (tag) => {
      depth += 1;
      if (depth === 1) {
        return;
      }
      if (depth === 2) {
        if (snapshot || tag.name !== "error" || tag.uri !== namespace) {
          throw new Error("Invalid generated stanza error");
        }
      }
      validator.open(tag);
      const parsed = xml(
        tag.name,
        Object.fromEntries(
          Object.values(tag.attributes).map(({ name, value }) => [name, value]),
        ),
      );
      if (cursor) {
        cursor.append(parsed);
      } else {
        snapshot = parsed;
      }
      cursor = parsed;
    },
    () => {
      if (depth >= 2) {
        validator.close();
        cursor = cursor.parent;
      }
      depth -= 1;
    },
    (text) => {
      if (depth === 1 && text.trim()) {
        throw new Error("Invalid generated stanza error character data");
      }
      if (depth >= 2) {
        validator.text(text);
      }
      cursor?.t(text);
    },
  );
  if (!snapshot) {
    throw new Error("Invalid generated stanza error");
  }
  Object.defineProperty(snapshot, "write", {
    value: (writer) => writer(source),
    writable: true,
    configurable: true,
  });
  return snapshot;
}

function isQuery({ name, type }) {
  if (name !== "iq") return false;
  if (type === "error" || type === "result") return false;
  return true;
}

function isValidQuery({ type, stanza }, children, child) {
  return (
    stanza.attrs.id !== undefined &&
    (type === "get" || type === "set") &&
    children.length === 1 &&
    !child.is("error", stanza.getNS())
  );
}

function buildReply({ stanza }) {
  return xml("iq", {
    to: stanza.attrs.from,
    from: stanza.attrs.to,
    id: stanza.attrs.id ?? "",
  });
}

function buildReplyResult(ctx, child) {
  const reply = buildReply(ctx);
  reply.attrs.type = "result";
  if (child) {
    reply.append(child);
  }

  return reply;
}

function buildReplyError(ctx, error, child) {
  const reply = buildReply(ctx);
  reply.attrs.type = "error";
  if (child && !child.is("error", ctx.stanza.getNS())) {
    preserveNamespaces(child);
    reply.append(child);
  }

  reply.append(error);
  return reply;
}

function buildError(type, condition) {
  return xml("error", { type }, xml(condition, NS_STANZA));
}

function iqHandler(entity) {
  return async function iqHandler(ctx, next) {
    if (!isQuery(ctx) || !entity.isStanza(ctx.stanza)) {
      return next();
    }

    const { stanza } = ctx;
    const children = stanza.getChildElements();
    const [child] = children;

    if (!isValidQuery(ctx, children, child)) {
      return buildReplyError(ctx, buildError("modify", "bad-request"), child);
    }

    ctx.element = child;

    try {
      const reply = await next();
      if (!reply) {
        return buildReplyError(
          ctx,
          buildError("cancel", "service-unavailable"),
          child,
        );
      }

      if (typeof reply?.getNS === "function") {
        preserveNamespaces(reply);
        if (
          reply.is("error") &&
          (!reply.getNS() || reply.getNS() === stanza.getNS())
        ) {
          validateError(reply, stanza.getNS());
          return buildReplyError(
            ctx,
            captureError(reply, stanza.getNS()),
            child,
          );
        }
      }

      return buildReplyResult(
        ctx,
        typeof reply?.getNS === "function" ? reply : undefined,
      );
    } catch (error) {
      entity.emit("error", error);
      return buildReplyError(
        ctx,
        buildError("cancel", "internal-server-error"),
        child,
      );
    }
  };
}

function route(type, ns, name, handler) {
  return (ctx, next) => {
    if ((ctx.type !== type) | !ctx.element || !ctx.element.is(name, ns))
      return next();
    return handler(ctx, next);
  };
}

export default function iqCallee({ middleware, entity }) {
  middleware.use(iqHandler(entity));

  return {
    get(ns, name, handler) {
      middleware.use(route("get", ns, name, handler));
    },
    set(ns, name, handler) {
      middleware.use(route("set", ns, name, handler));
    },
  };
}
