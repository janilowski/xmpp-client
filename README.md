# xmpp-client

> A small XMPP client library for the modern web.

This is an active, browser-focused fork of
[`xmpp.js`](https://github.com/xmppjs/xmpp.js). Its first goal is reliable XMPP
Core compliance, followed by carefully selected XMPP extensions needed by a
useful web client.

The minified browser bundle is continuously checked against a 13 KB
Brotli-compressed budget.

The project is in early development and is not yet published as a stable
release.

This project is maintained by Jan Iłowski in his spare time. Contributions are
welcome.


## Install

```sh
bun add @janilowski/xmpp-client
```

## Use

```ts
import { client, xml } from "@janilowski/xmpp-client";

const xmpp = client({
  service: "wss://example.com/xmpp-websocket",
  domain: "example.com",
  username: "romeo",
  password: "secret",
});

xmpp.on("error", console.error);
xmpp.on("online", async (address) => {
  console.log(`online as ${address}`);
  await xmpp.send(xml("presence"));
});

await xmpp.start();
```

For a classic browser script, use `dist/xmpp.js` or the minified
`dist/xmpp.min.js`; both expose the `XMPP` global.

## Develop

```sh
bun install
bun run test:all
```

The project uses Bun for development, TypeScript for its public API boundary,
and Rolldown for ESM and classic browser bundles. The inherited implementation
is still predominantly JavaScript and is being migrated incrementally.

## Scope

- browser clients over WebSocket
- XMPP Core compliance before broader extension support
- a small, auditable dependency and bundle footprint
- ESM-first packaging with TypeScript declarations and JSX support for XML

## Compliance target

The current target is a self-assessed **XMPP Core and Web Client Compliance
2023** implementation over WebSocket, following
[XEP-0479](https://xmpp.org/extensions/xep-0479.html) experimental guidance.

### Target profile

| Standard                                              | Area                        | Status                 |
| ----------------------------------------------------- | --------------------------- | ---------------------- |
| [RFC 6120](https://www.rfc-editor.org/info/rfc6120/)  | XMPP Core                   | Partial; audit pending |
| [RFC 7590](https://www.rfc-editor.org/info/rfc7590/)  | TLS for XMPP                | Partial; audit pending |
| [RFC 7622](https://www.rfc-editor.org/info/rfc7622/)  | XMPP addresses              | Partial; audit pending |
| [XEP-0030](https://xmpp.org/extensions/xep-0030.html) | Service Discovery           | Planned                |
| [XEP-0115](https://xmpp.org/extensions/xep-0115.html) | Entity Capabilities         | Planned                |
| [RFC 7395](https://www.rfc-editor.org/info/rfc7395/)  | XMPP over WebSocket         | Partial; audit pending |
| [XEP-0156](https://xmpp.org/extensions/xep-0156.html) | Connection Method Discovery | Partial; audit pending |

RFC 6120 and the other top-level specifications have normative dependencies,
including XML, XML Namespaces, UTF-8, SASL, Base64, and current TLS best
practices. Applicable requirements from those dependencies are part of the
audit even when they do not have their own project milestone.

### Additional protocol work

These implementations are useful but are not required for the base Core and
Web target:

| Standard                                                                                                       | Feature           | Status                               |
| -------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------ |
| [RFC 4616](https://www.rfc-editor.org/info/rfc4616/)                                                           | SASL PLAIN        | Implemented; audit pending           |
| [RFC 4505](https://www.rfc-editor.org/info/rfc4505/) and [XEP-0175](https://xmpp.org/extensions/xep-0175.html) | SASL ANONYMOUS    | Implemented; audit pending           |
| [XEP-0106](https://xmpp.org/extensions/xep-0106.html)                                                          | JID Escaping      | Implemented; audit pending           |
| [XEP-0198](https://xmpp.org/extensions/xep-0198.html)                                                          | Stream Management | Implemented; audit pending           |
| [XEP-0199](https://xmpp.org/extensions/xep-0199.html)                                                          | XMPP Ping         | Responder implemented; audit pending |
| [XEP-0386](https://xmpp.org/extensions/xep-0386.html)                                                          | Bind 2            | Partial; audit pending               |
| [XEP-0388](https://xmpp.org/extensions/xep-0388.html)                                                          | SASL 2            | Partial; audit pending               |
| [XEP-0484](https://xmpp.org/extensions/xep-0484.html)                                                          | FAST              | Partial; audit pending               |

## Testing and compliance

Compliance work is requirements-driven. Requirements are extracted from the
standards and their errata before being compared with the current
implementation. Every applicable normative requirement is tracked with its
role, conditions, source section, status, and evidence. `SHOULD` and `SHOULD
NOT` deviations require a written justification; server-only or
transport-replaced requirements must be explicitly marked not applicable.

Evidence can include:

- black-box protocol transcript tests against the public client boundary
- focused tests for JIDs, XML, Base64, counters, and other protocol data
- malformed-input, downgrade, resource-limit, and other adversarial tests
- browser integration tests for WebSocket and browser-controlled TLS behavior
- interoperability tests against more than one XMPP server implementation
- documented inspection where a requirement cannot be observed automatically

Passing the ordinary unit tests is not by itself a compliance claim. A
standard reaches **verified** only when its applicable requirements have no
unexplained failures or coverage gaps and its implementation has been
exercised for interoperability.
