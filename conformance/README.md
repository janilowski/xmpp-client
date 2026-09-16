# Protocol tests

Tests specify observable behavior before implementation. One suite per standard;
large standards may use section-level files under a shared index.

```sh
bun run test:conformance
bun run test:mutations
```

No VM or Prosody is required here. The scripted peer listens on an ephemeral
loopback port. Failure to bind a port is a test failure, never a skip.
Prosody interoperability and Chromium tests remain separate (`test:e2e`,
`test:browser`). `test:all` runs all layers.

- [Scope and source notes](scope.md)
- [RFC 7395 coverage and gaps](rfc7395.md)
- [RFC 6120 lifecycle coverage and gaps](rfc6120.md)
- [Remaining standards work](roadmap.md)

## Adding a requirement

1. Read the source clause, conditions, updates and errata. Record its section in
   the coverage map. Preserve an existing requirement ID where available.
2. Write positive, negative, boundary and state-transition scenarios as applicable.
   Use the public client and literal peer responses, not production helpers as
   the expected-result oracle. Pure algorithms can use independent vectors.
3. Observe the relevant test fail, implement the smallest fix, then observe it pass.
4. Add deliberate mutations for important checks. Assertions must catch the
   defect; timeouts and runtime crashes do not count as successful detection.
5. Keep uncovered clauses visible. Document conditional exclusions and justified
   SHOULD deviations. A test's existence is not a passing result.

## Evidence

`test:conformance` creates a fresh `reports/run-*/` directory containing Bun's
JUnit results and environment metadata (revision, dirty flag, runtime, OS, command,
exit status). Reports are generated and ignored by Git. CI uploads them even on
failure. Results describe tested scenarios, not a completeness percentage.

The suite uses Bun's real WebSocket transport, including raw-peer tests for
absent/wrong subprotocols and invalid UTF-8 in Bun and Chromium. Adapter tests
also simulate permissive platforms. The transcript normalizer and production document parser
both use `saxes`; their agreement is not independent validation. Literal malformed
inputs check production rejection directly. Chromium tests additionally parse
outgoing frames with native `DOMParser` and exercise malicious peer responses.
Saxes 6 is archived upstream: this production dependency needs continued review,
not an assumption of certification.

`notes/` preserves the former catalogue's IDs and interpretations without its
schema or hand-maintained results. Those notes still need source review;
the migration is not validation.
