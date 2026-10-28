import IncomingContext from "./lib/IncomingContext.js";
import OutgoingContext from "./lib/OutgoingContext.js";
import Context from "./lib/Context.js";
import { ConnectionClosedError } from "../events/lib/operation.js";
import { isReported, markReported } from "../events/lib/reportedError.js";
import { QueueFullError, sendPolicies } from "../connection/lib/sendPolicy.js";

export async function runMiddleware(stack, context) {
  if (!Array.isArray(stack)) {
    throw new TypeError("Middleware stack must be an array.");
  }

  for (const middleware of stack) {
    if (typeof middleware !== "function") {
      throw new TypeError("Every middleware must be a function.");
    }
  }

  let nextPosition = 0;

  async function run(position) {
    if (position < nextPosition) {
      throw new Error("next() called multiple times");
    }

    nextPosition = position + 1;
    const middleware = stack[position];
    if (!middleware) return;

    return middleware(context, () => run(position + 1));
  }

  return run(0);
}

function listener(entity, middleware, StanzaContext) {
  return (stanza) => {
    let ctx;
    try {
      // Extension nonzas do not have XMPP stanza addressing semantics.
      ctx = entity.isStanza(stanza)
        ? new StanzaContext(entity, stanza)
        : new Context(entity, stanza);
    } catch (error) {
      // Malformed peer identities must not route replies or escape into the XML parser.
      if (StanzaContext === IncomingContext && error instanceof TypeError) {
        return;
      }
      throw error;
    }
    return runMiddleware(middleware, ctx);
  };
}

function errorHandler(entity) {
  return (ctx, next) => {
    const socket = entity.socket;
    const parser = entity.parser;
    const requiredReply =
      entity.isStanza(ctx.stanza) &&
      ctx.name === "iq" &&
      (ctx.type === "get" || ctx.type === "set");
    return next()
      .then((reply) => {
        if (!reply) {
          return;
        }
        return entity.send(reply).catch(async (error) => {
          // Only a failed returned reply is terminal, not optional middleware sends.
          if (error instanceof QueueFullError && requiredReply) {
            if (entity.socket !== socket || entity.parser !== parser) {
              return;
            }
            const shutdown = sendPolicies.get(entity)?.fail();
            try {
              if (entity.socket === socket && entity.parser === parser) {
                if (entity.listenerCount("error") > 0) {
                  markReported(entity, error);
                }
                entity.emit("error", error);
              }
            } finally {
              await shutdown;
            }
            return;
          }
          throw error;
        });
      })
      .catch((error) => {
        // Cancellation of an old exchange must not poison a replacement stream.
        if (
          !(error instanceof ConnectionClosedError) &&
          !isReported(entity, error)
        ) {
          entity.emit("error", error);
        }
      });
  };
}

export default function middleware({ entity }) {
  const incoming = [errorHandler(entity)];
  const outgoing = [];

  const incomingListener = listener(entity, incoming, IncomingContext);
  const outgoingListener = listener(entity, outgoing, OutgoingContext);

  entity.on("element", incomingListener);
  entity.on("send", outgoingListener);

  return {
    use(fn) {
      incoming.push(fn);
      return fn;
    },
    filter(fn) {
      outgoing.push(fn);
      return fn;
    },
  };
}
