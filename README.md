# xmpp-client

> A small XMPP client library for the modern web.

This is an active, browser-focused fork of
[`xmpp.js`](https://github.com/xmppjs/xmpp.js). Its first goal is reliable XMPP
Core compliance, followed by carefully selected XMPP extensions needed by a
useful web client.

The minified browser bundle is continuously checked against a **50 KiB**
Brotli-compressed budget, temporarily increased while completing Core behavior.
We will lower the budget after measured optimizations, without removing required
behavior. Run `bun run size` for a fresh measurement and check.

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
bun install --frozen-lockfile
bun run test:static
```

The project uses Bun for development, TypeScript for its public API boundary,
and Rolldown for ESM and classic browser bundles. The inherited implementation
is still predominantly JavaScript and is being migrated incrementally.

The SASL registry and PLAIN/ANONYMOUS mechanisms are checked TypeScript.
Their internal exchange contract covers credentials, synchronous factories,
asynchronous responses, and text/byte callback inputs. `bun run typecheck`
also runs the compile-only cases in `src/sasl/registry.types.ts`.
SCRAM, FAST, and the SASL negotiation drivers remain unchecked JavaScript;
their interoperability is exercised by the authentication tests. These internal
types do not change the published API or replace runtime input validation.

### Native integration environment (Fedora)

No VM or container is required. Use Bun 1.4.2 (also pinned in CI),
Prosody 13 with Lua 5.4, and Playwright's Chromium:

```sh
sudo dnf install prosody lua lua-devel luarocks
bun install --frozen-lockfile
bun run prosody:setup
bunx playwright install chromium
bun run test:all
```

The integration runner starts and stops its own Prosody. Do not start the
system service for these tests. Ports 5280, 5281, and 5347 must be free.
If the system service already occupies them, stop it only if it is not serving
anything you need: `sudo systemctl stop prosody`.

`test:unit` needs no server. `test:e2e` runs native integration tests;
`test:browser` builds and tests both bundles in Chromium. `test:all` runs
static checks, conformance and mutation checks, and both integration suites.
Fedora uses Playwright's Ubuntu fallback browser build; it was verified locally
on Fedora 44.

Each integration invocation creates `server/.runtime/run-*` with an isolated
configuration, account, certificate authority, and retained logs. Tests never
reset the tracked Prosody configuration through Git. Run integration commands
sequentially; a lock rejects overlapping runs. SIGKILL or a machine crash can
leave the lock behind: inspect the processes before removing the empty lock
directory. Runtime directories contain test credentials and keys; do not publish
them. CI uploads only the server logs on failure.

TLS verification remains enabled in Bun using the fixture CA. Chromium trusts
only the fixture's public-key fingerprint for positive tests; a separate browser
without that exception must reject it. That fingerprint exception is not a test
of hostname validation. Bun 1.4.2's IPv6 WSS identity failure remains an executable
expected-failure test, not a skip; an unexpected success requires removing the
marker. See [the upstream fix](https://github.com/oven-sh/bun/pull/30674).

The four Prosody module versions are pinned in `server/setup.js`. The native
Prosody package is supplied by your distribution, not lockfile-pinned; this run
used 13.0.6. JavaScript implementation-wide type checking and protocol compliance
remain separate work; `typecheck` checks TypeScript sources and the public
declarations.

[Client profile](docs/profile.md) documents policy and platform limits.
Project progress, priorities and outstanding findings live in
[GitHub issues](https://github.com/janilowski/xmpp-client/issues) and
[milestones](https://github.com/janilowski/xmpp-client/milestones), not a separate
repository roadmap.

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

| Standard                                              | Area                        | Status                                                                            |
| ----------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| [RFC 6120](https://www.rfc-editor.org/info/rfc6120/)  | XMPP Core                   | [Lifecycle/IQ tests](conformance/rfc6120.test.ts); partial Core support           |
| [RFC 7590](https://www.rfc-editor.org/info/rfc7590/)  | TLS for XMPP                | [Web profile](docs/profile.md); TLS stack delegated                               |
| [RFC 7622](https://www.rfc-editor.org/info/rfc7622/)  | XMPP addresses              | [Address tests](conformance/rfc7622.test.js); Unicode 16 profile                  |
| [XEP-0030](https://xmpp.org/extensions/xep-0030.html) | Service Discovery           | Planned                                                                           |
| [XEP-0115](https://xmpp.org/extensions/xep-0115.html) | Entity Capabilities         | Planned                                                                           |
| [RFC 7395](https://www.rfc-editor.org/info/rfc7395/)  | XMPP over WebSocket         | [Client-binding tests](conformance/rfc7395.test.ts); platform boundaries explicit |
| [XEP-0156](https://xmpp.org/extensions/xep-0156.html) | Connection Method Discovery | [XRD/WSS tests](conformance/xep0156.test.js); redirects deliberately rejected     |

RFC 6120 and the other top-level specifications have normative dependencies,
including XML, XML Namespaces, UTF-8, SASL, Base64, and current TLS best
practices. Applicable requirements from those dependencies are part of the
audit even when they do not have their own project milestone.
Tests reference the applicable source clauses directly. The [client profile](docs/profile.md)
documents runtime delegation and deliberate deviations, not blanket certification
of inherited standards or browser engines. Outstanding work lives in GitHub.

Password authentication supports SCRAM-SHA-256 and SCRAM-SHA-1 through SASL
and SASL2, with mandatory server-proof verification. See the
[credential preparation and channel-binding boundaries](docs/profile.md#authentication).

### Additional protocol work

These implementations are useful but are not required for the base Core and
Web target:

| Standard                                                                                                       | Feature           | Status                                                                   |
| -------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| [RFC 4616](https://www.rfc-editor.org/info/rfc4616/)                                                           | SASL PLAIN        | Implemented; audit pending                                               |
| [RFC 4505](https://www.rfc-editor.org/info/rfc4505/) and [XEP-0175](https://xmpp.org/extensions/xep-0175.html) | SASL ANONYMOUS    | Implemented; audit pending                                               |
| [XEP-0106](https://xmpp.org/extensions/xep-0106.html)                                                          | JID Escaping      | Implemented; audit pending                                               |
| [XEP-0198](https://xmpp.org/extensions/xep-0198.html)                                                          | Stream Management | [Counter/resumption tests](conformance/xep0198.test.ts); partial support |
| [XEP-0199](https://xmpp.org/extensions/xep-0199.html)                                                          | XMPP Ping         | Responder implemented; audit pending                                     |
| [XEP-0386](https://xmpp.org/extensions/xep-0386.html)                                                          | Bind 2            | Partial; audit pending                                                   |
| [XEP-0388](https://xmpp.org/extensions/xep-0388.html)                                                          | SASL 2            | Partial; audit pending                                                   |
| [XEP-0484](https://xmpp.org/extensions/xep-0484.html)                                                          | FAST              | Partial; audit pending                                                   |

## Testing and compliance

Compliance work is requirements-driven. Requirements are extracted from the
standards and their errata before being compared with the current
implementation. Applicable requirements retain their source sections and
conditions; execution produces results. `SHOULD` and `SHOULD
NOT` deviations require a written justification; server-only or
transport-replaced requirements must be explicitly marked not applicable.

The [protocol suites](conformance/) exercise RFC 7395 client
binding, RFC 7622 addresses, and bounded RFC 6120/XEP-0198 behavior.
Run `bun run test:conformance` for protocol tests and generated reports,
and `bun run test:mutations` to check assertions against deliberate defects.
Tests carry source references; GitHub tracks uncovered requirements.

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
