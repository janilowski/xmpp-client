# Client profile and boundaries

Target: browser-oriented XMPP Core and Web Client Compliance 2023 over
WebSocket, using [XEP-0479 v0.1.0](https://xmpp.org/extensions/attic/xep-0479-0.1.0.html).
This is a development target, not certification. Requirements and findings live
in [GitHub](https://github.com/janilowski/xmpp-client/issues); source clauses live
beside tests. Passing transport tests does not certify inherited standards.

## Transport and discovery

The client uses browser `fetch`, `URL` and `WebSocket` APIs, including in Bun.
There is no raw TCP, DNS SRV, BOSH or XMPP-layer STARTTLS transport.
WebSocket framing, UTF-8 validation and control-frame closure belong to the
runtime; the library validates the `xmpp` subprotocol and XMPP documents.

Discovery reads XRD host-meta over authenticated HTTPS and selects WSS only.
Explicit caller-selected WS remains outside the secure profile. The low-level
parser can retain other recognized connection methods; this does not enable
those transports. JRD publication, CORS configuration and server routing are
server/deployment responsibilities.

HTTP redirects are rejected: a deliberate departure from RFC 6415 §2's SHOULD
follow redirects. Browser Fetch hides manual redirect destinations and offers no
per-hop approval for automatic following. Rejecting redirects avoids a hidden
HTTPS-to-HTTP hop, at the cost of rejecting redirected host-meta deployments.
Serve XRD directly or configure a trusted WSS endpoint. XMPP `see-other-uri`
redirects are likewise never followed automatically.

Only direct host-wide XRD links select endpoints. Unused metadata and extensions
are not trust assertions; no XML Signature or XRDS trust path is implemented.
Expiry uses the device clock; there is no additional metadata cache.
Equivalent endpoints are ordered lexically after transport/security preferences.
Reported RFC 6415 erratum 4811 does not relax this profile's absolute-URL rule;
held erratum 3118 concerns a JRD example, not XRD link selection.

TLS, certificate paths, endpoint identity, SNI, protocol/cipher selection,
compression, resumption, key handling and revocation are runtime/deployment
obligations under RFC 7590 and current BCP 195, not a JavaScript TLS stack.
Use a maintained runtime and do not disable certificate verification.
Web APIs expose neither certificate chains nor channel-binding key material.
`Socket.secure` also permits explicit loopback credentials: it is not proof
of encryption. TLS is hop-by-hop, not end-to-end protection.

The Bun disposable-CA tests exercise trust, hostname and expiry rejection.
Chromium tests separately reject an untrusted certificate, but positive fixtures
using an SPKI exception do not prove hostname/expiry validation. No complete
cipher, revocation or all-browser matrix is claimed. Expected runtime failures
remain executable test markers, not evidence of successful validation.

## Library policies

- XML limits are 1 MiB UTF-8 and 64 element levels, not RFC-prescribed values.
  Browser messages are buffered before delivery; these checks cannot bound
  native allocation before the library receives them.
- Stream version 1.x is supported, including numeric leading zeros and higher
  minor versions. Missing version is unsupported pre-1.0 behavior. Legacy missing
  server `from`/`to` is tolerated; server ID/language is not fabricated.
  Outgoing language is caller-selected; incoming documents inherit no context.
- Negotiation uses `entity.timeout` (default 2000 ms), including binding;
  ordinary IQ requests default to 30 seconds. These are local deadlines.
  Cancellation prevents further protocol work after callbacks settle, but
  cannot stop arbitrary application callbacks or undo their side effects.
- IQ correlation checks sender and ID. Full destinations require the same full
  JID; bare destinations permit a resource. No-`to` requests accept no sender,
  the server domain or the client's bare JID. Own-bare/server destinations also
  allow absent `from`; remote destinations do not. An error's `by` attribute
  cannot override this policy. Reusing caller-supplied IDs for the same peer
  cannot distinguish delayed replies; prefer generated fresh IDs.
- SM malformed counts close with `bad-format`, a local invalid-schema policy.
  `sm.outbound` means last acknowledged sequence, not total sent; retransmission
  does not count twice. SM supplies neither persistence nor exactly-once delivery.

## Authentication

Classic resource binding requires completed authentication and one unambiguous
full client JID in the matching IQ result. Malformed binding results fail closed;
server-selected replacement resources are accepted. Binding errors are surfaced
as stanza errors, without automatic resource retries or credential replacement.
RFC 6120 §7.7.3's retry allowance is a server obligation, not a client retry mandate.

Password authentication prefers SCRAM-SHA-256, then SCRAM-SHA-1, then PLAIN,
independently of the server's advertisement order. Both SCRAM variants use native
Web Crypto and verify the server proof before stream restart, binding or online.
Use HTTPS/WSS: SCRAM does not replace authenticated transport.

The XMPP adapter prepares nonempty authorization identities as bare client JIDs;
it does not interpret authentication usernames as JIDs or invent a realm from
the XMPP domain (RFC 6120 §§6.3.7–6.3.9). Realms require caller/server input.
Credential callbacks can explicitly retry failed exchanges on the same connection,
but cannot overlap attempts, select unoffered mechanisms, or choose PLAIN while
a preferred mechanism is offered. No automatic password downgrade is performed.
Exhausted attempts close the connection. Sending SASL `<abort/>` waits for the
server's failure response; transport cancellation instead terminates the exchange.

Built-in mechanisms negotiate no SASL security layer (RFC 4422 §3.7); custom
mechanisms requiring one are unsupported. EXTERNAL is not implemented: this
browser profile does not integrate certificate provisioning or externally
authenticated identities. This is a scoped departure from RFC 6120 §§6.3.4,
13.8.4's SHOULDs, not a claim that browsers can never use client certificates.
The explicit loopback PLAIN exception is outside RFC 6120 §13.8.3's TLS
requirement. Only authenticated WSS belongs to the secure deployment profile.

SCRAM uses Unicode 3.2 SASLprep: query preparation for usernames and stored-string
preparation for passwords (an empty password is allowed). Prohibited characters,
invalid bidirectional strings and unassigned password characters fail explicitly,
without automatic downgrade to PLAIN. JID PRECIS is not a substitute. GS2
authorization identities are escaped, not normalized as simple usernames;
the XMPP adapter applies the bare-JID authorization profile described above.
Web APIs provide no channel-binding material, so the client uses the GS2 `n`
flag and does not advertise or select `-PLUS`. This is an explicit platform
boundary, not a claim of full RFC 6120 mandatory mechanism compliance.

SCRAM caps server messages at 16,384 characters and PBKDF2 at 1,000,000
iterations. These are local resource limits, not RFC maxima. Counts above the
limit fail rather than being reduced. Native derivation already in progress
cannot be cancelled; connection cancellation prevents its result from being
sent or completing a replacement session. No password/key cache is retained.

## Address preparation

JIDs use RFC 7622 with verified errata 4534/4560, RFC 8264/8265 PRECIS,
IDNA2008 (RFC 5890–5893), RFC 5895 mapping and RFC 9844's wire-grammar update.
No transitional UTS #46 mapping. Unicode 16 is the selected repertoire;
unassigned input is rejected before mapping. Older normalization engines reject
non-ASCII preparation rather than silently returning partially prepared names.

Malformed JIDs throw `TypeError`. Complete-address parsing does not automatically
escape invalid localparts; the explicit parts constructor retains XEP-0106
escaping. Equivalent Unicode/IDNA addresses compare equal, domains serialize as
U-labels and resource case remains significant. Migrate stored keys with
collision checks. This is not SASLprep, account provisioning or authorization.

Invalid addresses cannot enter middleware or complete IQs, but raw
`element`/`stanza` events are untrusted wire observations. Extension fields must
explicitly use JID preparation. Bound standalone untrusted input before
normalization. Confusable detection and safe display remain application duties;
never authorize by display text. See [Unicode maintenance](unicode.md).
