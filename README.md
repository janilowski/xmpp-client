# xmpp-client

> A small XMPP client library for the modern web.

This is an active, browser-focused fork of
[`xmpp.js`](https://github.com/xmppjs/xmpp.js). Its first goal is reliable XMPP
Core compliance, followed by carefully selected XMPP extensions needed by a
useful web client.

The project is in early development and is not yet published as a stable
release.

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
bun run build
````

The project uses Bun for development, TypeScript for its public API boundary,
and Rolldown for ESM and classic browser bundles. The inherited implementation
is still predominantly JavaScript and is being migrated incrementally.

## Scope

- browser clients over WebSocket
- XMPP Core compliance before broader extension support
- a small, auditable dependency and bundle footprint
- ESM-first packaging with TypeScript declarations and JSX support for XML

The minified browser bundle is continuously checked against a 13 KB
Brotli-compressed budget.

This project is maintained by Jan Iłowski in his spare time. Contributions are
welcome.
