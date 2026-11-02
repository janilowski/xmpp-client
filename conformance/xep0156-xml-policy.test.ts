import { afterEach, expect, spyOn, test } from "bun:test";
import { resolve } from "../src/resolve/lib/http.js";

// Local discovery policy, not an XML 1.0 or XEP-0156 requirement: reject all DTDs.
// XML 1.0 §5.1 otherwise requires processing applicable internal declarations.
// The separate XMPP prohibition remains covered by the RFC 6120 XML suites.
const MIME = "application/xrd+xml";
const HOST_META = "https://example.test/.well-known/host-meta";
const PLAIN_XRD =
  '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://host.test/xmpp"/></XRD>';
const EXPECTED_ENDPOINTS = [
  {
    rel: "urn:xmpp:alt-connections:websocket",
    href: "wss://host.test/xmpp",
    method: "websocket",
    uri: "wss://host.test/xmpp",
  },
];
let fetchMock: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchMock?.mockRestore());

const cases: [string, string, string?][] = [
  ["harmless declaration", "<!DOCTYPE XRD>"],
  [
    "internal entity declaration",
    '<!DOCTYPE XRD [<!ENTITY endpoint "wss://other.test/xmpp">]>',
  ],
  [
    "internal default attribute",
    '<!DOCTYPE XRD [<!ATTLIST Link title CDATA "default">]>',
  ],
  [
    "external subset",
    '<!DOCTYPE XRD SYSTEM "https://canary.invalid/discovery.dtd">',
  ],
  [
    "external general entity declaration",
    '<!DOCTYPE XRD [<!ENTITY external SYSTEM "https://canary.invalid/entity">]>',
  ],
  [
    "external parameter entity reference",
    '<!DOCTYPE XRD [<!ENTITY % external SYSTEM "https://canary.invalid/parameter">%external;]>',
  ],
  [
    "internal entity reference",
    '<!DOCTYPE XRD [<!ENTITY metadata "internal">]>',
    PLAIN_XRD.replace("</XRD>", "<Subject>&metadata;</Subject></XRD>"),
  ],
  [
    "external general entity reference",
    '<!DOCTYPE XRD [<!ENTITY metadata SYSTEM "https://canary.invalid/entity">]>',
    PLAIN_XRD.replace("</XRD>", "<Subject>&metadata;</Subject></XRD>"),
  ],
];
for (const [name, declaration, document = PLAIN_XRD] of cases) {
  test(`Discovery XML local policy rejects ${name} and recovers`, async () => {
    fetchMock = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(declaration + document, {
          headers: { "content-type": MIME },
        }),
      )
      .mockResolvedValueOnce(
        new Response(PLAIN_XRD, { headers: { "content-type": MIME } }),
      );

    expect(await resolve("example.test")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(HOST_META);

    expect(await resolve("example.test")).toEqual(EXPECTED_ENDPOINTS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(HOST_META);
  });
}
