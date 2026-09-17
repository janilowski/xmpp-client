# Scope and sources

Target: XMPP Core and Web Client Compliance 2023 over WebSocket.
This is a development target, **not a certification**. The RFC 7395 client-binding
suite maps direct obligations and platform boundaries; inherited standards remain
separate work. See the [coverage map](rfc7395.md).
Core also needs XEP-0030 and XEP-0115; transport tests do not establish Core compliance.

## Reviewed transport subset (2026-09-17)

[RFC 7590/current BCP 195](tls.md) and [XEP-0156/XRD](xep0156.md) now have
source-reviewed section maps, inherited requirement boundaries, errata decisions
and executable evidence. These supersede the historical TLS/discovery entries
below and contribute the transport subset to #10. They do not mark unrelated
Core requirements or the entire historical inventory as reviewed.

## Historical source snapshot

The former inventory recorded the following sources on 2026-07-29. Versions,
updates and errata below are retained for traceability, not freshly verified.
Recheck them before converting each set of notes into executable requirements.

- [RFC6120: Extensible Messaging and Presence Protocol (XMPP): Core](https://www.rfc-editor.org/info/rfc6120) — March 2011. Updates recorded: RFC 7590, RFC 8553. See [review notes](notes/rfc6120.md).
- [RFC7590: Use of Transport Layer Security (TLS) in XMPP](https://www.rfc-editor.org/info/rfc7590) — June 2015. See [review notes](notes/rfc7590.md).
- [RFC7622: XMPP Address Format](https://www.rfc-editor.org/info/rfc7622) — September 2015. Updates recorded: RFC 9844. See [review notes](notes/rfc7622.md).
- [RFC7395: XMPP Subprotocol for WebSocket](https://www.rfc-editor.org/info/rfc7395) — October 2014. See [review notes](notes/rfc7395.md).
- [XEP0156: Discovering Alternative XMPP Connection Methods](https://xmpp.org/extensions/xep-0156.html) — 1.4.0. See [review notes](notes/xep0156.md).
- [BCP195: Recommendations for Secure Use of TLS](https://www.rfc-editor.org/info/bcp195) — RFC 8996, RFC 9325, and RFC 9852. See [review notes](notes/bcp195.md).
- [DEPENDENCIES: Applicable normative dependencies](https://www.rfc-editor.org/info/rfc6120) — Pinned through the referring standards. See [review notes](notes/dependencies.md).

Profile basis: [XEP-0479 v0.1.0, 2023-05-04](https://xmpp.org/extensions/attic/xep-0479-0.1.0.html).

### Recorded errata

- RFC6120: 4228 (reported); 4741 (held-for-document-update); 2855 (held-for-document-update); 3486 (held-for-document-update); 3650 (held-for-document-update); 3651 (held-for-document-update).
- RFC7590: none recorded (not evidence that no errata exist).
- RFC7622: 4534 (verified); 4560 (verified); 5769 (held-for-document-update); 5789 (held-for-document-update); 4470 (held-for-document-update).
- RFC7395: none recorded (not evidence that no errata exist).

## Interpretation boundaries

- Separate library behavior, WebSocket/TLS platform guarantees, and deployment policy.
- RFC 6120 TCP/STARTTLS clauses replaced by RFC 7395 are not missing client features.
- Server-only clauses inform adversarial peer scenarios, not client certification.
- Do not flatten SHOULD into MUST; document justified deviations and conditional behavior.
- RFC 6120 §3.3 and §14 phrase reconnect policy differently; review both before choosing an oracle.
- RFC 7622 limits are octets after mapping, not JavaScript string length. Review RFC 9844 too.
