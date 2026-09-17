# TLS / Web transport audit

Reviewed 2026-09-17 for the **browser-oriented WebSocket client**, not a TLS
implementation or general TCP XMPP client. This closes the implementation audit
scope of #8 when the reviewed code, tests and maps reach the default branch.
It does not certify every browser or complete XMPP Core (#7/#10).

## Sources and interpretation

- [RFC 7590](https://www.rfc-editor.org/rfc/rfc7590.html), June 2015,
  §§1–4; [RFC 7395](rfc7395.md) replaces TCP/STARTTLS with WebSocket TLS.
- [BCP 195](https://www.rfc-editor.org/info/bcp195/): RFC 8996 (March 2021),
  RFC 9325 (November 2022), RFC 9852 (2026). Existing XMPP/WebSocket is
  not a newly defined protocol under RFC 9852 §§4–5. Its TLS 1.3 default rule
  permits a non-default TLS 1.2 option; minimum-version configuration remains
  delegated to the runtime (the browser APIs expose no version selector).
- [RFC 9325](https://www.rfc-editor.org/rfc/rfc9325.html) §§3–7 supplies the
  runtime/deployment requirements below. Its TLS, PKIX, algorithm and extension
  references belong to that same boundary, not a second JavaScript TLS stack.
- [WebSockets](https://websockets.spec.whatwg.org/) and
  [Fetch](https://fetch.spec.whatwg.org/) define our platform interfaces.
  Neither exposes cipher negotiation, certificate chains or session keys.
  WebSocket failure details are intentionally opaque to browser scripts.

RFC Editor errata records checked on the review date: none for RFC 7590,
9325 or 9852. RFC 8996 has editorial 7103/7796 (verified) and 7769 (held):
reference links, an author's name and field capitalization; no policy change.
Discovery's separate source/errata review is in [XEP-0156](xep0156.md).

## Responsibility and status

**Verified** means executable library or integration evidence. **Delegated**
means an explicit platform contract and deployment obligation, not a claim that
our tests prove the runtime's complete TLS implementation. **Not applicable**
identifies a role/path this client does not implement. **Deviation** identifies a
documented SHOULD departure. No TLS bypass option is exposed by this library;
applications must not disable runtime certificate verification.

| Source / condition                                                                | Owner and disposition                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC 7590 §§1, 3 (`RFC7590-follow-bcp195`)                                         | Shared: runtime requirements below; verified secure discovery and no automatic plaintext fallback.                                                                                             |
| §3.1 (`RFC7590-attempt-unadvertised-starttls`, `RFC7590-local-policy-starttls`)   | Not applicable: RFC 7395 §3.9 forbids XMPP-layer STARTTLS; TLS precedes the WebSocket handshake. [Binding tests](rfc7395.md) verify this boundary.                                             |
| §3.2, XMPP compression                                                            | No XEP-0138 implementation; no new compression mandate. TLS compression is runtime-owned.                                                                                                      |
| §3.3 (`RFC7590-session-resumption`)                                               | Delegated: TLS resumption keys/tickets are not exposed. XEP-0198 resumption is a separate application protocol.                                                                                |
| §3.4 (`RFC7590-client-authenticates-server`)                                      | Verified endpoint trust/expiry/hostname rejection in Bun; Chromium trust rejection. PKIX/path construction is delegated. HTTPS authenticates discovery before WSS endpoint selection.          |
| §3.4 (`RFC7590-server-authenticates-client`, `RFC7590-server-authenticates-peer`) | Not applicable: server authentication policy and server-to-server roles. This does not waive client SASL requirements tracked under #7.                                                        |
| §3.5, SNI                                                                         | Delegated to HTTPS/WSS URL handling. This client cannot inject XMPP-domain SNI into a browser handshake.                                                                                       |
| §3.6, human factors                                                               | Application UI responsibility. `Socket.secure` also permits explicit loopback credentials; it is **not proof of TLS encryption**. The actual `wss:` scheme identifies the encrypted transport. |
| §4, security boundary                                                             | Hop-by-hop only; no end-to-end encryption or protection against compromised peers.                                                                                                             |

### Runtime/deployment checklist

Every row below is **delegated**, except the explicitly excluded paths. These
requirements remain obligations of the chosen maintained browser/runtime and
server configuration. JavaScript cannot inspect or enforce them through our Web
APIs; replacing those APIs with a private TLS implementation is not this project.

| RFC 9325 source          | Requirement group / applicability                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §§3.1.1, 3.1.3; RFC 8996 | Protocol floor, supported versions, preference and fallback. Existing `BCP195-no-*`, `support-tls12/13`, `no-version-fallback` IDs. TLS 1.3 support is SHOULD; preference when supported is MUST. |
| §3.1.2                   | DTLS: not applicable.                                                                                                                                                                             |
| §3.2                     | TLS-only transport preference (`BCP195-prefer-tls-only-transport`); verified WSS-only discovery, no STARTTLS path. Explicit caller-selected WS is outside the secure profile.                     |
| §§3.3–3.4                | Compression policy, resumption secrecy/integrity, ticket keys/lifetime and forward secrecy. Certificate compression is distinct from TLS record compression.                                      |
| §3.5                     | TLS 1.2 secure renegotiation and extended-master-secret support (`BCP195-secure-renegotiation`). Do not confuse support with mandatory peer negotiation of EMS.                                   |
| §§3.6–3.8                | Post-handshake authentication, SNI, ALPN. HTTP ALPN is distinct from the library-checked `xmpp` WebSocket subprotocol.                                                                            |
| §3.9                     | Multi-server key handling: server deployment, not applicable to client code.                                                                                                                      |
| §3.10                    | Early-data replay policy. The library sends XMPP only after WebSocket establishment; HTTP/TLS early-data handling belongs to the runtime.                                                         |
| §§4.1–4.3                | Cipher exclusions, forward secrecy, AEAD/CBC conditions, curves, point format and TLS 1.3 algorithm profile. Existing `BCP195-no-rc4`, `aead-ciphers` IDs are not the whole group.                |
| §§4.4–4.6                | Key-use limits, asymmetric strength/signatures, truncated-HMAC prohibition.                                                                                                                       |
| §§5, 7.1                 | Authenticated confidential transport, endpoint identity and certificate paths. Not an opportunistic-TLS profile.                                                                                  |
| §§7.2–7.4                | Nonce generation, forward secrecy and DH reuse/validation.                                                                                                                                        |
| §7.5                     | Revocation strategy: platform trust policy. Our CA fixtures do **not** prove revocation enforcement or guarantee fresh online revocation checks.                                                  |

This is a delegation review, not a TLS-stack conformance report. Full negotiation,
cipher, ticket and revocation matrices are not claimed. A runtime known to violate
these requirements must be updated/replaced or explicitly restricted by deployment;
a successful XMPP test must not override that security decision.

## Executable evidence and limits

- [TLS suite](rfc7395-tls.test.ts): isolated Bun processes with a disposable CA
  and verification enabled; valid, untrusted, expired and wrong-host certificates
  for **both HTTPS discovery and direct WSS**. The XMPP domain differs from the
  authenticated endpoint, checking secure delegation rather than domain equality.
- [Discovery map](xep0156.md): HTTPS selection, no downgrade, malformed/expired
  XRD, case-insensitive relations, deadlines, byte limits and redirect policy.
- [Binding map](rfc7395.md): subprotocol, UTF-8, opening/restarting, stream errors,
  redirects, closing and adversarial raw peers; positive and negative cases.
- [Chromium suite](../browser.test.js): production bundle, certificate-trust
  rejection, opaque redirects, no discovery downgrade and WebSocket behavior.
  Positive SPKI-exception fixtures do **not** prove expiry/hostname validation.
- [IPv6 integration case](../test/client.test.js): Bun 1.3.14/1.4.2 WSS identity
  defect is an executable expected failure, not a skip. Unexpected success fails
  the marker so it must be removed. This runtime boundary does not excuse a
  library downgrade or disabling certificate verification.

Supported API profile: browser `fetch`, `URL` and `WebSocket`; current validation
uses Bun 1.4.2 and Playwright 1.63.0's Chromium on Linux. Other engines remain
untested, not implicitly passed. Browser raw DNS/SRV is unavailable; Bun executes
the same Web API profile rather than adding a TCP transport.

Reproduce with `bun run prosody:setup`, then `bun run test:all` (native Prosody and
Playwright Chromium required; no VM). Conformance reports record runtime/revision
and results. `bun run test:mutations` must detect removed security guards by
assertions, not crashes or outer runner timeouts. Keep TLS verification enabled;
use only the fixture's scoped trust configuration for integration tests.

Validation on 2026-09-17: `bun run test:all` passed on Bun 1.4.2: 469 unit,
315 conformance, 24 assertion-detected mutations, 21 e2e, 2 bundle and
14 Chromium tests; lint, public type checks and build passed. The e2e total
includes the declared Bun IPv6 expected failure, not a successful IPv6 identity
check. Browser bundle: 26.88 KiB Brotli against the unchanged 27 KiB gate.
