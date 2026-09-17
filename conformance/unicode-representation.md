# Unicode representation comparison

Measured 2026-09-17 against `d7d09e16`. Recommendation: retain the independent
delta-range format. `unicode-trie` reduces our adapter code and initialization
time, but increases compressed size without a consistent warm-JID advantage.
This is a local performance experiment, not a new conformance claim.

## Variants

- **Ranges:** committed independent (gap, length) varints, decoded once into
  native regular expressions. No added dependency.
- **Trie:** published `unicode-trie@2.0.0`, one bitmask per code point, serialized
  by its builder and loaded from base64. A small `.test()` adapter preserves the
  existing property consumers; protocol validation is unchanged.
- **Raw trie:** the same trie using the library's pre-parsed constructor with a
  literal `Uint32Array`. Tested through a build-time module replacement, not a
  completed alternative generator. Avoids inflation but retains library code.

All use the same 20 Unicode 16 properties. The published npm package depends on
`tiny-inflate@1.0.3` at runtime and `pako@0.2.9` for the builder. GitHub's current
branch uses `fflate`, but that is not the published 2.0.0 package tested here.
The client sourcemap confirms that `pako` is not bundled.

Sources: [library and API](https://github.com/foliojs/unicode-trie),
[published package](https://www.npmjs.com/package/unicode-trie/v/2.0.0).

## Bundle

Same Rolldown 1.2.7 minified client IIFE and Node Brotli defaults as the repository
size gate. KiB means 1024 bytes. Sourcemap files are excluded, their reference
comment is included consistently. These are whole-client sizes, not table sizes.

| Variant  | JS bytes | Brotli bytes | Brotli KiB | Delta vs ranges |
| -------- | -------: | -----------: | ---------: | --------------: |
| Ranges   |   93,992 |       27,243 |      26.60 |               — |
| Trie     |   94,030 |       30,004 |      29.30 |       +2.70 KiB |
| Raw trie |  199,536 |       29,319 |      28.63 |       +2.03 KiB |

Before packing, the client was 32,422 Brotli bytes (31.66 KiB). The committed
format saves 5,179 bytes (5.06 KiB). The previous, uncommitted shared-mask format
was 26,130 bytes: simplifying it costs 1,113 bytes (1.09 KiB).
Both library variants exceed the unchanged 27 KiB gate.

## Code maintained here

Physical lines, including comments and blank lines; generated data and dependency
code are counted separately. Counts below compare ranges with the serialized
trie implementation, not the raw-trie build hook.

| Area                               | Ranges | Trie | Difference |
| ---------------------------------- | -----: | ---: | ---------: |
| Runtime decoder / property adapter |     53 |   13 |        −40 |
| Complete Unicode generator         |    306 |  303 |         −3 |
| Total handwritten implementation   |    359 |  316 |        −43 |
| Generated data module              |     55 |   32 |        −23 |
| Representation-specific unit tests |     42 |   20 |        −22 |

Generated module bytes: 13,051 vs 9,646. Its line count is not a complexity metric.
The original 11 decoder cases are replaced by one adapter case; all independent
classification/profile oracles and protocol cases remain unchanged.

The trie additionally imports 535 physical lines of runtime dependency source
(`index.js`, `swap.js`, `tiny-inflate/index.js`), plus a 965-line builder and its
build-time compression dependency. Those are upstream-maintained, not 535 new
lines of project code. The library removes custom decoding, not the need to
derive and verify the normative Unicode properties.

## Chromium performance

AMD Ryzen 5 7640U, Linux, Bun 1.4.2, Chromium 153.0.8010.12. Two complete runs;
tables show the interval between the two run medians, not confidence intervals.

Initialization: 31 samples per variant per run, rotating variant order. Each
sample uses a fresh browser page/context in one running browser. Timing covers
`new Function(bundle)` compilation and evaluation, without network, page creation
or automation transport. This is fresh-realm initialization, not a cold browser
process, empty compilation cache, or a user-visible page-load measurement.

| Measurement                                      |  Ranges |    Trie | Raw trie |
| ------------------------------------------------ | ------: | ------: | -------: |
| Bundle initialization, ms                        | 7.8–8.2 | 4.6–5.1 |  3.6–3.7 |
| First Latin Unicode JID after initialization, ms | 0.9–1.0 | 0.6–0.7 |  0.6–0.7 |

Warm validation: 16 varying inputs per category, 2,000 warmup operations per
category, then 15 rounds of 12,000 operations (1,500 for long resources). Variant
order rotates. Each operation constructs and serializes a JID; output lengths
are consumed and acceptance/rejection counts are checked.

| JID category, microseconds per operation    |      Ranges |        Trie |    Raw trie |
| ------------------------------------------- | ----------: | ----------: | ----------: |
| ASCII                                       |   2.39–2.47 |   2.32–2.63 |   2.52–2.71 |
| Decomposed Latin username, IDN and resource |   9.68–9.95 |  9.72–10.74 |  9.69–10.41 |
| Hebrew username and IDN                     | 12.80–13.84 | 11.27–12.44 | 11.73–12.51 |
| Contextual middle dot and Japanese resource |   8.06–8.68 |   8.27–9.28 |   8.24–8.33 |
| Resource containing 500 accented letters    | 15.47–24.47 | 15.07–15.07 | 14.73–22.67 |
| Rejected contextual joiner                  |   4.28–5.97 |   4.08–4.52 |   4.04–5.63 |

Warm measurements show noticeable run-to-run variation, especially long inputs
and exceptions. Do not interpret small differences as an established speedup.
The initialization advantage is clearer on this machine. Neither result predicts
mobile performance; download latency and memory consumption were not measured.

## Verification

The committed ranges passed the complete `test:all` gate: 469 unit, 259
conformance, 18 caught mutations, 21 e2e, 2 bundle-export and 13 Chromium tests,
plus lint, typecheck, build and size. Generator `--check` passes; all 20 regex
source strings equal the original pre-optimization patterns.

The serialized trie passed 459 unit, 259 conformance, 18 caught mutations,
21 e2e, 2 bundle-export and 13 Chromium tests. Typecheck, focused lint and
generator `--check` pass. The lower unit count replaces decoder-specific tests,
not protocol tests. The size gate fails at 29.30 KiB; it was not relaxed.

All three variants passed the exhaustive Chromium digest of all 20 properties
over all 1,114,112 code points and empty-string checks. The raw trie additionally
passed the benchmark's acceptance checks, but did not receive a separate full
protocol/e2e run. It remains an experimental build variant.

Golden property digest:
`c445e88b892f68395bd6025dabb88abb11d9e53de2165bb77849a1ca1487ba83`.

## Local experiment artifacts

The isolated copy `/tmp/xmpp-unicode-trie.dGVv0Z` was removed after the comparison;
no experimental branch was created and `main` has no trie dependency.
Its source changes, package lock, benchmark and both raw result files are backed
up in `/tmp/xmpp-unicode-trie-experiment-dGVv0Z.tar.gz`. This temporary archive is
not tracked or guaranteed to survive cleanup. To reproduce, overlay it on a fresh
copy of `d7d09e16`, install dependencies and build both clients before running
`bun benchmark.mjs`. Regeneration requires the checksum-pinned Unicode 16 UCD
documented in [Unicode maintenance](../docs/unicode.md).
