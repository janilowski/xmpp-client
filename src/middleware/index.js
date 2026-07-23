import IncomingContext from "./lib/IncomingContext.js";
import OutgoingContext from "./lib/OutgoingContext.js";

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
    const ctx = new Context(entity, stanza);
    return runMiddleware(middleware, ctx);
  };
}

function errorHandler(entity) {
  return (ctx, next) => {
    next()
      .then((reply) => reply && entity.send(reply))
      .catch((error) => entity.emit("error", error));
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
