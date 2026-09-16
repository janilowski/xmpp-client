import _resolve from "./resolve.js";

async function fetchURIs(domain) {
  const result = await _resolve(domain, {
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
  entity.connect = async function connect(service) {
    if (!service || /:\/\//.test(service)) {
      return _connect.call(this, service);
    }

    const uris = filterSupportedURIs(entity, await fetchURIs(service));

    if (uris.length === 0) {
      throw new Error("No compatible secure transport found.");
    }

    const errors = [];
    for (const uri of uris) {
      try {
        return await _connect.call(this, uri);
      } catch (error) {
        errors.push(error);
        await this.disconnect();
      }
    }
    throw new AggregateError(
      errors,
      "Could not connect to discovered endpoints",
    );
  };
}

export { _resolve as resolve };
