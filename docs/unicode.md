# Unicode table maintenance

Download and unpack the official
[Unicode 16 UCD](https://www.unicode.org/Public/16.0.0/ucd/UCD.zip).
Archive SHA-256:
`c86dd81f2b14a43b0cc064aa5f89aa7241386801e35c59c7984e579832634eb2`.
The generator checks every consumed source file's digest.

```sh
bun tools/jid-unicode.js /path/to/unpacked/UCD --check
# Omit --check only when intentionally regenerating the checked-in table.
```

An optional independent oracle prints, but never rewrites, the golden digests:

```sh
python3 -m venv /tmp/xmpp-jid-oracle
/tmp/xmpp-jid-oracle/bin/pip install precis-i18n==1.1.2 unicodedata2==16.0.0 idna==3.11
/tmp/xmpp-jid-oracle/bin/python tools/jid-oracle.py
```

The oracle is not shipped or needed for normal tests. Its IDNA table has a known
exception: idna 3.11 admits U+1CCF0–U+1CCF9, whose Unicode 16 `<font>`
decompositions violate RFC 5892 §2.2. The explicit exclusion follows the source
standard, not production output. Do not refresh golden hashes automatically.

## Representation

Properties use independent (gap, length) pairs encoded as five-bit unsigned
varints in a fixed ASCII alphabet. Each gap starts at the previous range's
exclusive end. Tables decode once into native regular expressions, not per JID.
Before writing, the generator compares decoded properties across every code
point. Checksums and independent golden hashes must not be refreshed merely
to match production output.

The independent format avoids the palette and cross-property merging of the
smaller shared-mask prototype. See the dated
[Unicode representation experiment](../conformance/unicode-representation.md)
for measured alternatives and limitations; run `bun run size` and
`bun tools/bench-jid.js` for fresh local measurements.
