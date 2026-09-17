"""Print independent golden digests; never import production code or update tests.

Optional verification dependencies: precis-i18n==1.1.2,
unicodedata2==16.0.0, idna==3.11. See docs/unicode.md.
"""

from hashlib import sha256

import idna.idnadata
from idna.intranges import intranges_contain
import unicodedata2 as ucd
from precis_i18n import get_profile
from precis_i18n.derived import derived_property
from precis_i18n.unicode import UnicodeData

UNICODE_END = 0x110000
XMPP_LOCAL_EXCLUDED = set("\"&'/:<>@")
assert ucd.unidata_version == idna.idnadata.__version__ == "16.0.0"
data = UnicodeData(ucd)
identifier = bytearray(UNICODE_END)
opaque = bytearray(UNICODE_END)
idna_valid = bytearray(UNICODE_END)
for cp in range(UNICODE_END):
    prop, _ = derived_property(cp, data)
    identifier[cp] = prop == "PVALID"
    opaque[cp] = prop in ("PVALID", "FREE_PVAL")
    # idna 3.11 admits outlined digits; Unicode 16 gives them <font>
    # decompositions, making them Unstable under RFC 5892 §2.2.
    idna_valid[cp] = (
        intranges_contain(cp, idna.idnadata.codepoint_classes["PVALID"])
        and not 0x1CCF0 <= cp <= 0x1CCF9
    )
for name, values in [("identifier", identifier), ("opaque", opaque), ("idna", idna_valid)]:
    print(name, sha256(values).hexdigest())

for name in ("UsernameCaseMapped", "OpaqueString"):
    profile = get_profile(name, unicodedata=ucd)
    digest = sha256()
    count = 0
    for cp in range(UNICODE_END):
        char = chr(cp)
        # Python's lower() also follows its host Unicode version. Pin input.
        if ucd.category(char) == "Cn":
            continue
        try:
            value = profile.enforce(char)
        except UnicodeError:
            continue
        if name == "UsernameCaseMapped" and XMPP_LOCAL_EXCLUDED.intersection(value):
            continue
        count += 1
        digest.update(f"{cp:x}:{value}\n".encode("utf-8"))
    print(name, count, digest.hexdigest())
