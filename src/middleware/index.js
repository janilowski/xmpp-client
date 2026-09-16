import IncomingContext from "./lib/IncomingContext.js";
import OutgoingContext from "./lib/OutgoingContext.js";
import { ConnectionClosedError } from "../events/lib/operation.js";

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

function listener(entity, middleware, Context) {
  return (stanza) => {
    let ctx;
    try {
      ctx = new Context(entity, stanza);
    } catch (error) {
      // Malformed peer identities must not route replies or escape into the XML parser.
      if (Context === IncomingContext && error instanceof TypeError) {
        return;
      }
      throw error;
    }
    return runMiddleware(middleware, ctx);
  };
}

function errorHandler(entity) {
  return (ctx, next) => {
    next()
      .then((reply) => reply && entity.send(reply))
      .catch((error) => {
        // Cancellation of an old exchange must not poison a replacement stream.
        if (!(error instanceof ConnectionClosedError)) {
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
