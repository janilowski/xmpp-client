import _resolve from "./resolve.js";
import { assertCanConnect } from "../connection/lib/reset.ts";
import { ConnectionClosedError } from "../events/lib/operation.js";

async function fetchURIs(domain, signal) {
  const result = await _resolve(domain, {
    signal,
    srv: [
      {
        service: "xmpps-client",
        protocol: "tcp",
      },
      {
        service: "xmpp-client",
        protocol: "tcp",
      },
    ],
  });

  return [
    // Remove duplicates
    ...new Set(result.map((record) => record.uri)),
  ];
}

function filterSupportedURIs(entity, uris) {
  // Automatic discovery must not turn a TLS failure into a plaintext login.
  // Explicit ws:// services remain available for applications choosing that policy.
  return uris.filter(
    (uri) => uri.startsWith("wss://") && entity._findTransport(uri),
  );
}

export default function resolve({ entity }) {
  const _connect = entity.connect;
  const _disconnect = entity.disconnect;
  let attempt;

  // Retire discovery before shutdown yields, even if fetch ignores its signal.
  entity.disconnect = function disconnect(...args) {
    const previous = attempt;
    try {
      // Snapshot the affected transport before abort listeners can replace it.
      return _disconnect.apply(this, args);
    } finally {
      previous?.abort(new ConnectionClosedError());
    }
  };
  entity.connect = async function connect(service) {
    assertCanConnect(this);
    const previous = attempt;
    const current = new AbortController();
    attempt = current;
    const { signal } = current;
    let onAbort;
    const cancelled = new Promise((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // Reentrant abort listeners may start an even newer attempt.
    previous?.abort(new ConnectionClosedError());
    const work = (async () => {
      signal.throwIfAborted();
      if (!service || /:\/\//.test(service)) {
        const result = await _connect.call(this, service);
        signal.throwIfAborted();
        return result;
      }

      const uris = filterSupportedURIs(
        entity,
        await fetchURIs(service, signal),
      );
      signal.throwIfAborted();
      if (uris.length === 0) {
        throw new Error("No compatible secure transport found.");
      }

      const errors = [];
      for (const uri of uris) {
        signal.throwIfAborted();
        try {
          const result = await _connect.call(this, uri);
          signal.throwIfAborted();
          return result;
        } catch (error) {
          // A stale failure must not disconnect a newer direct/discovered owner.
          signal.throwIfAborted();
          errors.push(error);
          await _disconnect.call(this);
          signal.throwIfAborted();
        }
      }
      throw new AggregateError(
        errors,
        "Could not connect to discovered endpoints",
      );
    })();
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (attempt === current) {
        attempt = undefined;
      }
    }
  };
}

export { _resolve as resolve };
