# Remaining work

Implement a standard through small test-first slices. Never infer completeness
from a green suite or a count of catalogue entries.

## Immediate sequence

The bounded remediation issues #11–#17 are closed, including procedure
cancellation (#12), IQ sender validation (#11), stream-management counters (#13),
and JID preparation (#14). These fixes have executable evidence; JID preparation
and its Unicode profile are mapped in [RFC 7622 coverage](rfc7622.md).

The [lifecycle coverage map](rfc6120.md) links procedure deadlines, IQ cleanup,
SASL/SASL2, binding and SM cancellation regressions, including delayed callbacks
across reconnects. Wire tests also exercise a silent or disconnected SASL peer.
These address #12; they do not establish complete RFC 6120 compliance.

Next, complete the [TLS/Web audit (#8)](https://github.com/janilowski/xmpp-client/issues/8)
before adding XEP-0030 (#1), then XEP-0115 (#2), which depends on discovery.
For #8, verify the RFC 7590, BCP 195 and XEP-0156 review notes against their
sources and errata; map requirements to tests or justified runtime delegation;
fix any uncovered defects; publish the evidence on the default branch.
Chromium SPKI exceptions do not prove hostname or expiry validation. Broader
browser matrices remain useful follow-up work, not an absolute closure condition.
Contribute these maps to #10 without waiting for unrelated Core work in #7.

## Coverage backlog

1. Preserve the [RFC 7395 client-binding baseline](rfc7395.md). Attributes,
   language, failed restarts, raw handshakes, limits and Bun PKIX now have tests.
   Expand fuzzing and browser matrices; fixed vectors are not exhaustive proof.
2. Extend the [RFC 6120 lifecycle/IQ baseline](rfc6120.md) to the remaining
   negotiation, authentication, binding, stanza and error requirements.
3. Preserve the [RFC 7622 baseline](rfc7622.md), including independent Unicode
   vectors, versioned tables, contextual cases and browser/runtime validation.
4. Cover RFC 7590/BCP 195 and XEP-0156 with authenticated TLS endpoints and adversarial
   redirects/discovery. Bun now checks trust, expiry and hostname independently;
   extend the trusted-CA matrix to browsers.
5. Preserve the [XEP-0198 counter/resumption baseline](xep0198.md); review the
   remaining negotiation, session policy and application-handling requirements.
6. Add XEP-0030, then XEP-0115. Split large suites by section, retaining a standard-level index.
7. Run relevant wire scenarios in supported browsers as well as Bun. Browser TLS
   tests with an SPKI exception do not prove hostname validation; retain that gap.

Closed remediation issues: [11](https://github.com/janilowski/xmpp-client/issues/11),
[12](https://github.com/janilowski/xmpp-client/issues/12),
[13](https://github.com/janilowski/xmpp-client/issues/13),
[14](https://github.com/janilowski/xmpp-client/issues/14),
[15](https://github.com/janilowski/xmpp-client/issues/15),
[16](https://github.com/janilowski/xmpp-client/issues/16),
[17](https://github.com/janilowski/xmpp-client/issues/17).

## Discovery and capabilities design notes

1. Build XEP-0030 as infrastructure

XEP-0030 should not be merely a function that sends one IQ. It will become the feature registry underlying nearly every subsequent extension.

A good implementation needs:

- `disco#info` querying
- `disco#items` querying
- Incoming IQ handlers
- Registration of client identities and supported features
- Optional node-specific information and items
- Correct XMPP error responses
- Deduplicated, deterministic feature results
- A stable public TypeScript API

This gives future modules a clean way to announce themselves:

```ts
disco.addFeature("urn:xmpp:carbons:2");
```

without every extension having to manipulate discovery responses directly.

### 2. Implement XEP-0115 carefully

Entity Capabilities depends on the discovery registry and adds:

- Capability advertisement in outgoing presence
- Handling capability information from incoming presence
- Canonicalization and hashing
- `node#ver` discovery requests
- Verification before caching
- Deduplication of concurrent capability queries
- Cache limits and invalid-response handling

The security property matters: a remote client’s advertised capability hash must not be trusted until its discovery response has been retrieved and verified.

I would keep the canonicalization and hash implementation isolated so that support for newer capability approaches can be added later without rewriting discovery.
