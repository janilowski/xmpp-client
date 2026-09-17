# Protocol tests

Development order: standard → tests → implementation. Group scenarios by standard
and semantic section. Put the source clause in the test name, `describe` block or
nearby comment; distinguish normative requirements from local safety policy.
Do not maintain a parallel Markdown catalogue of requirements or passing tests.

```sh
bun run test:conformance
bun run test:mutations
```

The scripted peer uses ephemeral loopback ports; no VM or Prosody is needed for
these suites. Failure to bind is a failure, not a skip. `test:all` also runs unit,
Prosody interoperability and Chromium tests; see the [setup guide](../README.md).

## Writing tests

Read the source, conditions, updates and errata before choosing an oracle. Use
the public client with literal peer responses and independent expected values.
Cover valid alternatives, malformed input, boundaries, ordering, cancellation and
recovery. First observe a behavioral assertion fail, then fix the implementation.
Mutations must fail assertions, not merely crash or time out.

Missing requirements and confirmed findings belong in
[GitHub issues](https://github.com/janilowski/xmpp-client/issues), not another
local backlog. Keep [profile decisions and runtime boundaries](../docs/profile.md)
separate from protocol requirements. A green suite does not prove completeness.

## Evidence and independence

`test:conformance` writes fresh ignored `reports/run-*/` directories containing
JUnit results and environment metadata (revision, dirty flag, runtime, OS,
command and exit status). CI uploads them even on failure. These describe the
executed scenarios, not a completeness percentage.

The transcript normalizer shares `saxes` with production; agreement alone is not
independent validation. Literal malformed inputs and Chromium's native DOMParser
provide additional oracles. Saxes 6 is archived upstream; it is not certified by
our tests. TLS fixtures using an SPKI exception do not prove hostname or expiry
validation; disposable trusted-CA scenarios are separate.
