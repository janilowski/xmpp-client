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
  disco: { identities: [{ category: "client", type: "web", name: "Example" }] },
});

xmpp.on("error", console.error);
xmpp.on("online", async (address) => {
  console.log(`online as ${address}`);
  await xmpp.send(xml("presence", { id: globalThis.crypto.randomUUID() }));
});

await xmpp.start();
```

For a classic browser script, use `dist/xmpp.js` or the minified
`dist/xmpp.min.js`; both expose the `XMPP` global.

### Service Discovery

```ts
const info = await xmpp.disco.info("example.com");
console.log(info.identities, info.features);
const items = await xmpp.disco.items("example.com");

xmpp.disco.addFeature("urn:example:implemented-feature");
xmpp.disco.setNode("commands", {
  identities: [{ category: "automation", type: "command-list" }],
});
xmpp.disco.setItems([{ jid: String(xmpp.jid), node: "commands" }]);
const commands = await xmpp.disco.info("peer@example.com/device", {
  node: "commands",
  timeout: 5000,
  signal: new AbortController().signal,
});
```

The application supplies its identity; there is no guessed default. Without
`disco.identities`, queries still work, but incoming info requests receive
`service-unavailable`. Root items start empty. Configured responders advertise
disco info/items and the installed ping handler automatically.

Use `setIdentities`, `setItems`, `setNode` and `removeNode` to replace public
metadata; `addFeature` / `removeFeature` manage extension features. Registered
values are copied, local duplicates collapse, and invalid replacements leave
existing data intact. Built-in features cannot be removed. Register only
implemented features and items your application owns or can vouch for.

Optional `disco.authorize(request)` is a synchronous predicate over
`{ from, to, node, type }`; returning `false` answers `service-unavailable`.
All registered metadata is public by default. Node names are opaque, nonempty
strings; registration never adds them to an items list automatically.

Replies contain parsed `identities`/`features` or `items`, plus the original
`query` XML. Parsed info infers disco-info support when omitted by a peer;
`query` preserves the advertised data, including duplicates and extensions,
for protocols such as capability verification. Neither form authenticates a
peer's feature claims. Queries do not cache results or walk item trees.

### Entity Capabilities

```ts
const xmpp = client({
  service: "wss://example.com/xmpp-websocket",
  username: "user",
  password: "secret",
  disco: { identities: [{ category: "client", type: "web", name: "My app" }] },
  caps: { node: "https://example.com/my-app" },
});
xmpp.on("capabilities", ({ jid, status, info, error }) => {
  console.log(jid, status, info?.features, error?.message);
});
await xmpp.start();
await xmpp.send(xml("presence")); // Presence remains an application decision.
const peer = xmpp.caps.get("contact@example.com/device");
```

Caps is opt-in and requires explicit discovery identities. It annotates outgoing
presence and discovers received hints through disco; it does not fetch the
software URI or enumerate contacts. Root identity/feature changes refresh only
an existing application-owned broadcast. Directed presence alone never starts one.

Results are `pending`, `verified`, `unverified` or `invalid`, with copied discovery
data when available. `verified` means the data matches the advertised hash, not
that the peer is authenticated or actually implements those features. Do not use
caps as authorization. Disabled clients still expose `caps.get`, returning
`undefined`. See [cache, privacy and interoperability boundaries](docs/profile.md#entity-capabilities).

## Develop

```sh
bun install --frozen-lockfile
bun run test:static
```

The project uses Bun for development, TypeScript 7 for typechecking, and Rolldown
for ESM and classic browser bundles. ESLint uses Microsoft's TS6 compatibility
package for the compiler API; `tsc` runs TS7. The inherited implementation is still
predominantly JavaScript and is being migrated incrementally.

### Native integration environment (Fedora)

No VM or container is required. Use Bun 1.4.4 (also pinned in CI),
Prosody 13 with Lua 5.4, and Playwright's Chromium. Development tools additionally
require Node 22.22.1+ and Git 2.32+; the library's runtime floor is unchanged.

Bun 1.4.4 fixes the bundled [Brotli decoder vulnerability](https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p)
and [compromised CA trust](https://github.com/oven-sh/bun/security/advisories/GHSA-26q8-h657-pf84)
affecting earlier releases. Upgrade with `bun upgrade` before installing dependencies.

```sh
sudo dnf install prosody lua lua-devel luarocks nss-tools
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

TLS verification remains enabled in Bun using the fixture CA. The protocol
interoperability browser uses an SPKI exception, not certificate-validation proof.
Separate Linux Chromium tests import a disposable CA into an isolated NSS database
and verify trust, hostname and expiry for WSS and HTTPS discovery without exceptions.
They isolate the browser home, XDG paths and profile; public/system roots remain.
`certutil` is required (`nss-tools` on Fedora, `libnss3-tools` on Ubuntu).
Set `XMPP_CERTUTIL` only when that executable is outside `PATH`.
IPv6 WSS is tested without an expected-failure marker:
Bun 1.4.3 fixes the earlier identity-verification defect. The separate CN-only
identity defect remains an executable expected failure; see the
[TLS boundary](docs/profile.md#transport-and-discovery).

The four Prosody module versions are pinned in `server/setup.js`. The native
Prosody package is supplied by your distribution, not lockfile-pinned; this run
used 13.0.6. New TypeScript modules and published types are checked;
implementation-wide checking of inherited JavaScript remains separate work.

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
| [XEP-0030](https://xmpp.org/extensions/xep-0030.html) | Service Discovery           | [Wire tests](conformance/xep0030.test.ts); explicit application identity          |
| [XEP-0115](https://xmpp.org/extensions/xep-0115.html) | Entity Capabilities         | [Wire/hash/SM tests](conformance/xep0115.test.ts); opt-in application identity    |
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
