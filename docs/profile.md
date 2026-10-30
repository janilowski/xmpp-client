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

The Bun disposable-CA tests exercise root trust, hostname and expiry rejection
for direct WSS and HTTPS discovery. Intermediate-chain scenarios accept a valid
chain and reject an untrusted, expired, non-CA or missing intermediate.
Separate Linux Chromium tests use a disposable CA in an isolated NSS database,
browser home, XDG paths and profile, without certificate-error exceptions.
They verify missing fixture trust for direct WSS and initial HTTPS discovery.
Trusted-CA controls reject wrong names, expiry and CN-only certificates there
and at WSS targets selected by valid discovery, with successful controls and
native certificate-error diagnostics. Protocol interoperability
fixtures using an SPKI exception remain separate. Public/system roots are not
removed by the isolated NSS setup. No complete cipher, revocation or all-browser
matrix is claimed. Expected runtime failures
remain executable test markers, not evidence of successful validation.
Bun 1.4.2–1.4.4 accept CN-only certificates without SAN for both WSS and
HTTPS discovery (#50); version-bounded expected failures retain strict rejection
assertions. Restricted trust-anchor provisioning (RFC 6120 §13.6) and long-lived
certificate expiry/OCSP rechecks (§13.7.2.3) are not verified by these tests.

After a received XMPP `reset` (RFC 6120 §4.9.3.16), that client instance
refuses further connections, including discovery, manual reconnect and
stop/start. Automatic retries stop. The original `StreamError` is returned.
This fail-closed policy avoids reusing TLS when WebSocket cannot require a
fresh security context. Other stream errors retain ordinary reconnect behavior.
Creating another client or page does not guarantee fresh TLS: browser caches
can be shared. Applications/deployments must establish a fresh TLS context
before reconnecting outside the refused instance; no cache-reset API is exposed.

## Service Discovery

XEP-0030 v2.5.0 uses the existing IQ services. Applications supply identities
and register only supported features and associated public items. Ownership,
authorization and contextual hierarchy classification belong to the application;
the library does not invent a roster, bare-account responder or client type.
An unconfigured client can query discovery but returns `service-unavailable`
for incoming info instead of a successful response without identity. This is
not evidence of a configured Core-compliant discovery responder.

The optional synchronous authorization callback can deny requests without
revealing whether a node exists. Registered nodes are independent snapshots,
not path hierarchies or automatically advertised items. Core info/items and
installed root ping features remain advertised; application features are mutable.
Empty node identifiers and conflicting local identity names reject explicitly.

Remote results retain original XML and duplicate evidence. Convenient feature
lists infer disco-info support when absent; XEP-0115 verification must
hash the original advertised data. Unknown foreign item metadata is ignored,
not interpreted. No automatic contact enumeration, tree walks, caching, remote
publishing or capability advertisement is implemented by this module.

## Entity Capabilities

XEP-0115 v1.6.0 is opt-in through `caps.node` and requires explicit discovery
identities. The software URI is preserved, not fetched. Advertisement uses SHA-1
for mandatory-algorithm interoperability; receivers also support SHA-256. Hashing uses native
Web Crypto. Only the original disco XML participates in verification, not inferred
features. Snapshot nodes retain all identity languages and respect disco
authorization; eight recent prepared versions are retained. Their data and the
installed caps feature cannot be changed through application registry methods.

No initial presence is sent. Root identity/feature changes refresh only the last
successful application-owned undirected available presence, preserving its payload.
Newer application intent supersedes stale refreshes; unavailable is never reversed.
Directed presence does not start a broadcast. With caps enabled, send events and
SM observe a prepared copy, not an annotation on the caller's original tree.
Original serialization is validated once before preparation; the prepared output
is checked again. SM replay retains its original annotation and admission charge.
Receive-size/depth limits do not become limits on valid generated presence.

Queries target the exact declared sender and `node#ver`. Server hints use the
explicit opening sender after negotiation. Missing later annotations retain hints
because servers may strip redundant caps. Legacy hashless annotations are ignored.
Unknown algorithms and valid anonymous fixed fields without `var` remain per-peer
unverified data, never globally reused. XEP-0004 permits the latter, but XEP-0115
defines no hash for them. Malformed known-hash results or mismatches are invalid;
request failures are unverified. Ordinary presence delivery continues.

Only verified data is shared across JIDs and presence sessions. Fresh non-resumed
sessions clear peer hints; SM resumption retains them and restarts pending work.
Unavailable clears that sender's hint, not shared verified data. Stale replies and
digests cannot publish into a replacement session. Returned trees and arrays are
copies. A matching hash authenticates neither a peer nor its feature claims:
XEP-0115 §9.3 explicitly acknowledges cache-poisoning limitations.

Local resource policies retain at most 128 peer hints / 64 KiB of serialized
UTF-8 hint metadata, 128 records / 1 MiB of serialized response XML, and 64 scheduled
query groups with four active queries/digests. Uncancellable old digests keep
their active slots until completion. These are serialized-data budgets, not heap
or native WebSocket-buffer bounds. Oversized hints are ignored; eviction/queue
pressure yields unverified state without disconnecting XMPP. Queries use positive
finite `entity.timeout`, falling back to two seconds when disabled. Repeated hints
can retry transient failures or evicted data. There is no disk persistence.

This modern-client feature does not certify all inherited XEP-0004, XEP-0128,
RFCs, browser engines or general denial-of-service protection.

## Library policies

- Reconnect uses exponential backoff with equal jitter and a 60-second cap;
  the base window defaults to one second. These are local choices implementing
  RFC 6120 §3.3's recommendations, not mandatory RFC durations.
- Unknown stream features are ignored alongside supported negotiation features.
  An offer with no supported feature cannot complete an unauthenticated or
  unbound client session and fails explicitly. There is no universal `required`
  marker (RFC 6120 §4.3.2); feature-specific requirements remain authoritative.
  Malformed direct feature namespaces report `bad-format` before closure;
  foreign feature payloads remain opaque.
- After a `conflict` stream error, classic binding avoids the previously bound
  resource (RFC 6120 §4.9.3.3). A repeated or absent choice is replaced with a
  fresh UUID; a different prepared callback/configured choice is preserved.
  IQ conflicts do not trigger this policy. Bind2 tags are not resourceparts.
- Stream `see-other-host` targets require a complete prepared
  `domainpart[:port]`. Same-host port redirects preserve the WebSocket scheme,
  path, query, stream `to` and language. A connection attempt stops after five
  successive redirects; completed negotiation starts a new sequence
  (RFC 6120 §4.9.3.19). Hosts are compared after preparation against the actual
  WebSocket endpoint, not the stream destination or mutable configuration.
  Cross-host redirects are rejected before contact: browser TLS cannot verify
  the original XMPP service reference identity at a different URL host.
  This browser-profile boundary rejects otherwise valid cross-host deployments;
  callers may configure a trusted endpoint explicitly, with runtime TLS checks.
- Malformed correlated IQ responses reject that request locally without replying
  to a result/error stanza. Stanza errors are recoverable; stream errors close
  the transport. Unknown standard error conditions map to `undefined-condition`.
  IQ handlers returning malformed core error elements produce a
  `cancel/internal-server-error` reply and one local error. Foreign error-named
  payloads remain ordinary IQ results; scoped namespace bindings are preserved.
- IQ `gone`/`redirect` errors retain the target in the error's XML element and
  reject the request without automatically contacting that target or resending.
  Applications choosing to follow stanza redirects own user approval, peer
  authentication and successive-redirect limits (RFC 6120 §8.3.3.14).
- Error conditions and types drive protocol behavior; diagnostic `text` does not.
  Applications MUST NOT interpret that text programmatically. It SHOULD NOT be
  the primary user-facing message for stanza errors (RFC 6120 §8.3.2), and MUST
  NOT be the primary message for stream errors (§4.9.2).
- Applications generating stanza errors own authorization-sensitive selection.
  Use `service-unavailable` rather than `item-not-found` or
  `recipient-unavailable` if those conditions would disclose availability to
  an unauthorized peer (RFC 6120 §§8.3.3.7/.13/.19). The library has no
  presence-authorization context and does not rewrite these otherwise valid
  conditions.
- Outgoing core IQs require an ID, a defined type and the child structure in
  RFC 6120 §8.2.3. Get/set payloads require an extension namespace (§8.4).
  Validation checks serialized output before writes or SM admission; it does
  not infer extension schemas. Empty opaque IDs and namespace aliases remain
  allowed, and foreign IQ-named nonzas remain outside these rules.
- `send` and `sendMany` accept application-built stanzas, so the caller owns
  recipient intent under RFC 6120 §8.1.1.1: a specific recipient requires a
  `to` address, while direct server processing requires its omission. Explicit
  addresses are prepared; omission remains omission on the wire. Callers SHOULD
  assign message and presence IDs and choose their uniqueness scope (§8.1.3);
  absence remains legal, while `iqCaller` generates required IQ IDs. Outgoing
  middleware runs after a successful write and cannot repair this metadata.
- Outgoing message, presence and IQ errors share RFC 6120 §8.3 validation.
  Only error stanzas may contain a direct core error, with one defined condition
  and a defined error type. Optional diagnostic text is character data;
  application conditions require their own namespace. Nonempty `gone`/`redirect`
  addresses use generic absolute URI/IRI syntax, not URL resolution or
  scheme-specific validation. Ordinary conditions and foreign extensions do
  not require schema validation. Checks inspect the actual serialized snapshot
  before writes, send events or SM admission; generated IQ errors retain that
  snapshot even if application objects change during reply serialization.
- Core stanzas require the client content namespace. Incoming `jabber:server`
  content closes with `invalid-namespace`; outgoing server content is rejected.
  Foreign extension nonzas do not route IQs, parse XMPP addresses or enter SM
  counters/replay queues.
  Prefixes for elements qualified by the stream's client content namespace
  reject locally on output; incoming documents containing them are ignored
  atomically before dispatch. Foreign namespace prefixes remain permitted
  (RFC 6120 §§4.8.5/8.4).
- Before negotiation completes, core stanzas can address only the connected
  server or a protocol-confirmed account. Configured usernames and former
  connections do not grant identity authority. Remote stanzas reject locally
  before writing or queue admission; validated SM resumption permits replay
  before the public online event (RFC 6120 §4.3.5; XEP-0198 §5).
- XML limits are 1 MiB UTF-8 and 64 element levels, not RFC-prescribed values.
  These are receive limits, not outgoing XML grammar restrictions. Generated
  documents are validated before writes and SM queue admission; invalid local
  XML rejects with a TypeError (RFC 6120 §11.3).
  Generated XML declarations must omit `standalone` (RFC 6120 §11.5).
  Incoming standalone declarations are ignored; generic XML documents retain
  their normal grammar. WebSocket standalone documents do not waive SDDecl rules.
  Generated WebSocket openings use the same XML/language checks before parser
  attachment; serialization runs once and the validated snapshot is written.
  Browser messages are buffered before delivery; these checks cannot bound
  native allocation before the library receives them.
- XML diagnostic policy follows RFC 6120 §§4.9.3.1/11.6 recommendations:
  malformed XML/namespace syntax reports `not-well-formed`, a non-UTF-8
  declaration reports `unsupported-encoding`, and prohibited constructs report
  `restricted-xml`. Other unprocessable frames may still report `bad-format`.
  XML 1.1 rejection does not imply schema validation or a stream-version error;
  whole-extension schema validation remains optional and caller-owned.
- Stream version 1.x is supported, including numeric leading zeros and higher
  minor versions. Missing version is unsupported pre-1.0 behavior. Legacy missing
  server `from`/`to` is tolerated; server ID/language is not fabricated.
  Outgoing language is caller-selected. Empty stream/core-stanza root values
  reject before writing; malformed nonempty values also reject on serialized
  descendants, including extensions. Format checks preserve
  grandfathered/private-use alternatives and do not claim IANA registration or
  extension-specific validity (RFC 5646 §§2.1–2.2).
  Empty XML inheritance resets remain supported on descendants and foreign
  nonza roots, not stream/core-stanza roots (RFC 6120 §§4.7.4/8.1.5).
  Incoming trees retain declared attributes without inserting inherited ones.
  Applications presenting text track the latest input `open` header (including
  an absent replacement default) and resolve the nearest ancestor `xml:lang`;
  an empty value cancels inheritance. Configured `lang` is an output preference,
  not the input default. `disco.info()` exposes declared identity languages and
  retains the raw query ancestry for interpretation. Caps verification uses the
  original declared fields, not materialized language defaults.
- Application `send`/`sendMany` rejects until the opening write completes;
  mutable root/status fields and peer replies cannot grant that permission.
  Framing `open`/`close` documents belong to lifecycle methods,
  not generic sends. Opening writes have their own negotiation deadline;
  failed or cancelled initialization grants no output authority. A shutdown
  joins the owned write outcome before deciding whether XML closure is owed.
- Negotiation uses `entity.timeout` (default 2000 ms), including binding and
  waiting for features after each opening, SASL restart or reconnect, and after
  SASL2 success except successful inline SM resumption. These are
  per-stage deadlines, not one deadline for the entire login;
  ordinary IQ requests default to 30 seconds. These are local deadlines.
  Cancellation prevents further protocol work after callbacks settle, but
  cannot stop arbitrary application callbacks or undo their side effects.
- Shutdown continuations and queued socket/parser events remain attached to
  their original session. Replacement streams must not inherit old close writes,
  errors or status changes. This is a local lifecycle safety policy; it does not
  cancel arbitrary application code or extend protocol deadlines.
  Closing transports reject stream initiation/restart while continuing incoming
  processing until reciprocal closure; a fresh transport permits initiation
  again (RFC 6120 §4.4; RFC 7395 §3.6).
- Negotiated Stream Management checks idle peers every five minutes by default
  (RFC 6120 §4.6.4). Outgoing stanzas still request acknowledgement after a
  250-ms debounce; a pending check allows 60 seconds for incoming traffic.
  These are local policies: an otherwise silent broken stream can take six
  minutes to detect. Existing `streamManagement.requestAckInterval` overrides
  remain available; zero disables periodic probes. WebSocket framing forbids
  whitespace keepalives (RFC 7395 §3.8).
- IQ correlation checks sender and ID. Full destinations require the same full
  JID; bare destinations permit a resource. No-`to` requests accept no sender,
  the server domain or the client's bare JID. Own-bare/server destinations also
  allow absent `from`; remote destinations do not. An error's `by` attribute
  cannot override this policy. Server/account authorities are private
  protocol-confirmed snapshots, not mutable public JIDs or options.
  Before the account is known, only the internal binding transaction also
  accepts an account-bare result agreeing with its validated full-JID payload,
  or an account-bare error that rejects without granting identity or routing.
  Ordinary requests, including application-created binding XML, get no exception.
  Reusing caller-supplied IDs for the same peer cannot distinguish delayed
  replies; prefer generated fresh IDs.
- SM malformed counts or resumption identities close with `bad-format`, a local
  validation policy. Resumption IDs are opaque and must match exactly.
  Resumption requires `enabled@resume` to be true or 1 and a present ID;
  an empty ID remains valid. ID-only, false and 0 responses enable acknowledgements
  without permitting resumption. Disconnecting such a session emits `fail` once
  per unhandled stanza; applications own notification or intentional resend.
  Ordinary and Bind2 enabling share one attempt per stream. Refusal does not
  permit a retry; it reports provisional queued stanzas through `fail`.
  A new connection permits a new attempt or resumption of its retained session.
  Both resumption paths require the private bound identity retained from that
  enabled session; assigning a public ID alone cannot restore a session.
  `sm.outbound` means last acknowledged sequence, not total sent; retransmission
  does not count twice. SM supplies neither persistence nor exactly-once delivery.
  Local queue admission defaults to 1024 stanzas and 8 MiB of serialized UTF-8
  XML, including in-flight writes. `streamManagement.maxStanzas` and `maxBytes`
  configure these budgets at construction; both must be positive integers,
  `maxStanzas` below 2^32 and `maxBytes` within the safe-integer range.
  These are local resource limits, not XEP-0198 maxima. Overflow rejects
  `send`/`sendMany` with an Error whose `code` is `ERR_SM_QUEUE_FULL`, before
  writing, emitting `send` or accepting SM responsibility. Existing items remain
  owned; ACKs release capacity. `sendMany` keeps its accepted prefix and stops.
  Replay reuses the original admission charge. This measures original serialized
  payloads, not JavaScript heap use: queued Elements remain mutable caller objects,
  and replay may add delay metadata. It does not claim immutable snapshot replay.
  SM controls and foreign nonzas do not consume stanza capacity. If admission
  prevents an internally generated IQ reply, the local terminal policy sends
  `undefined-condition` with `queue-full` in
  `https://github.com/janilowski/xmpp-client/errors`, then closes the stream.
  This ends the session rather than fulfilling the requested IQ exchange;
  remaining owned items produce `fail` once. Ordinary application overflow alone
  does not close the connection. Applications own notification and intentional
  retry; local rejection is not proof of remote delivery failure.

## Authentication

Classic resource binding requires completed authentication and one unambiguous
full client JID in the matching IQ result. Malformed binding results fail closed;
the returned JID is prepared before granting session identity. Server-selected
accounts, domains and replacement resources are accepted rather than guessed
from login options. Binding errors are surfaced as stanza errors, without
automatic resource retries or credential replacement.
RFC 6120 §7.7.3's retry allowance is a server obligation, not a client retry mandate.

The fixed or asynchronous `resource` option is prepared as an OpaqueString before
the binding IQ is sent. The 1023-octet UTF-8 limit applies after preparation;
invalid choices fail locally. An omitted or empty choice requests server
allocation and never sends an empty `<resource/>`. Bind2 `<tag>` is not a
resourcepart and does not use this option's preparation policy.

SASL2 success requires one same-namespace, text-only account identifier. It is
bare before binding and full after requested, successful Bind2; it need not match
the authentication username. Inline resumption validates the retained session
before processing other success extensions. A bare or matching full identifier
keeps that session's full JID/resource; it cannot switch accounts or resources
(XEP-0388 §2.6.1/example 9, XEP-0386 §3.2.1, XEP-0198 §9.2).

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

Malformed JIDs throw `TypeError`. Complete-address parsing does not apply
XEP-0106 or collapse reverse-solidus identities; the explicit parts constructor
retains XEP-0106 escaping. Equivalent Unicode/IDNA addresses compare equal,
domains serialize as U-labels and resource case remains significant. Migrate
stored keys with collision checks. This is not SASLprep, account provisioning
or authorization.

Core stanza `to`/`from` values are prepared before serialization and SM admission.
Length checks use prepared UTF-8, so longer input can normalize to a valid JID.
Strict local rejection implements RFC 7622 §4's client SHOULD; generic foreign
nonza attributes retain their own semantics, not implicit JID-slot validation.

Invalid addresses cannot enter middleware or complete IQs, but raw
`element`/`stanza` events are untrusted wire observations. Extension fields must
explicitly use JID preparation. Standalone input resource budgets before
normalization are separate from post-preparation address limits.
Confusable detection and safe display remain application duties;
never authorize by display text. See [Unicode maintenance](unicode.md).

## XML dependency maintenance

The XML factory retains ltx's Element constructor rather than wrapping it.
The checked-in Bun patch corrects explicit default-namespace cancellation and
preserves attribute TAB/LF/CR through numeric references in both CommonJS and
ES module exports; text escaping is unchanged. Install with `bun install --frozen-lockfile`;
dependency upgrades must recheck cancellation, scoped dispatch and constructor
compatibility before removing or regenerating the patch. Distributed bundles
embed the corrected implementation; consumers' separate raw ltx installations
are not patched and do not share the bundle's constructor.
