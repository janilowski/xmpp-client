# Endpoint discovery

This internal module reads HTTPS host-meta and sorts recognized XMPP endpoints.
It performs no DNS SRV lookup and is not a public package export.

## Usage

```javascript
import resolve from "../resolve/resolve.js";

const endpoints = await resolve("example.test");
```

For a host-meta document containing a WebSocket link, the result has this shape:

```javascript
[
  {
    rel: "urn:xmpp:alt-connections:websocket",
    href: "wss://endpoint.example.test/xmpp",
    method: "websocket",
    uri: "wss://endpoint.example.test/xmpp",
  },
];
```

Discovery requests `https://<domain>/.well-known/host-meta`. It rejects redirects,
invalid or expired XRD metadata, relative endpoints and URL credentials. Failed
discovery returns an empty array. Reading has a deadline and a decompressed-body
limit; XML parsing also limits depth.

The low-level resolver retains recognized WebSocket, BOSH and HTTP polling links.
The client selects WSS only; retaining metadata does not implement other
transports. There are no `srv` or address-family options. Runtime APIs resolve
endpoint hostnames and establish connections.

See the [client profile](../../docs/profile.md#transport-and-discovery) for
security boundaries and the deliberate HTTP-redirect deviation.

## References

- [RFC 7395 §4: WebSocket endpoint discovery](https://www.rfc-editor.org/rfc/rfc7395.html#section-4)
- [RFC 6415: Web Host Metadata](https://www.rfc-editor.org/rfc/rfc6415.html)
- [XEP-0156: Discovering Alternative XMPP Connection Methods](https://xmpp.org/extensions/xep-0156.html)
