# XML 1.0 Fifth Edition: review notes

Migrated from the 2026-07-29 inventory. These are **unverified review notes**,
not a complete extraction or a compliance claim. Preserve IDs when adding tests;
check the original clause, its conditions and errata before implementation.
Executable coverage belongs in the standard's suite and coverage map, not here.

## DEPENDENCIES-xml-well-formed

XML 1.0 Fifth Edition §2.1; MUST; both; responsibility: library.

When: For every XML document or framed XML document

Produce and accept only well-formed XML as constrained further by RFC 6120.

## DEPENDENCIES-xml-namespaces

Namespaces in XML 1.0 Third Edition §6; MUST; both; responsibility: library.

When: For namespaced XMPP XML

Apply namespace declaration, expanded-name, and namespace-constraint rules.

## DEPENDENCIES-utf8-valid

RFC 3629 §3 and 4; MUST; both; responsibility: shared.

When: For XMPP XML encoded as UTF-8

Reject malformed UTF-8 and prohibited byte sequences.

Scope: delegated. WebSocket text decoding is browser-controlled; XML construction and parsing remain library behavior.

## DEPENDENCIES-base64-alphabet

RFC 4648 as profiled by RFC 6120 §RFC 6120 13.9.1; MUST; client; responsibility: library.

When: When decoding Base64 during SASL

Reject characters outside the Base64 alphabet rather than ignoring them.

## DEPENDENCIES-base64-padding

RFC 4648 as profiled by RFC 6120 §RFC 6120 13.9.1; MUST; client; responsibility: library.

When: When decoding Base64 during SASL

Reject invalid padding placement without crashing.

## DEPENDENCIES-sasl-mechanism-selection

RFC 4422 as profiled by RFC 6120 §RFC 6120 6.3.3; MUST; client; responsibility: library.

When: When a server offers SASL mechanisms

Select according to client preference among locally supported offered mechanisms, never merely the server's ordering.

## DEPENDENCIES-sasl-no-unsupported-mechanism

RFC 4422 as profiled by RFC 6120 §RFC 6120 6.3.3; MUST NOT; client; responsibility: library.

When: When choosing a SASL mechanism

Do not attempt a mechanism absent from either the server offer or the client's supported set.

## DEPENDENCIES-plain-requires-security

RFC 4616 as profiled by RFC 6120 §RFC 6120 13.8.3; MUST NOT; client; responsibility: shared.

When: When considering SASL PLAIN

Do not use PLAIN without confidentiality, integrity, and authenticated server identity.

## DEPENDENCIES-scram-sha1

RFC 5802 as required by RFC 6120 §RFC 6120 13.8.3; MUST; client; responsibility: library.

When: For the RFC 6120 mandatory password mechanism

Implement SCRAM-SHA-1 and validate the server proof.

## DEPENDENCIES-scram-sha1-plus

RFC 5802 as required by RFC 6120 §RFC 6120 13.8.3; MUST; client; responsibility: shared.

When: When the transport exposes a compatible TLS channel-binding type

Implement SCRAM-SHA-1-PLUS and validate channel binding and the server proof.

Scope: delegated. Browser WebSocket APIs do not currently expose TLS channel-binding material; the protocol obligation remains recorded for explicit audit treatment.

## DEPENDENCIES-service-identity

RFC 6125 as referenced by RFC 7590 §RFC 7590 3.4; MUST; client; responsibility: browser.

When: When authenticating the WSS or HTTPS server certificate

Verify the expected DNS service identity and abort on failure.

Scope: delegated. The browser performs HTTPS and WSS certificate validation against the URL host.

## DEPENDENCIES-websocket-protocol

RFC 6455 as profiled by RFC 7395 §RFC 7395 3; MUST; client; responsibility: browser.

When: For the underlying WebSocket connection

Use a conforming WebSocket client, including handshake validation, masking, framing, and close processing.

Scope: delegated. The browser WebSocket implementation owns the underlying RFC 6455 protocol.
