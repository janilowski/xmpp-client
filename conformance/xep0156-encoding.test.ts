import { afterEach, expect, spyOn, test } from "bun:test";
import {
  ReadableStream,
  type ReadableStreamDefaultController,
} from "node:stream/web";
import { resolve } from "../src/resolve/lib/http.js";

// HTTP XRD is XML, not an XMPP stream: XML 1.0 §§2.2/4.3.3 requires
// UTF-8 and UTF-16. RFC 7303 §3.2 orders BOM, MIME charset, declaration/default.
// https://www.w3.org/TR/xml/#charencoding
// https://www.rfc-editor.org/rfc/rfc7303.html#section-3.2
// https://xmpp.org/extensions/xep-0156.html#rules
const MIME = "application/xrd+xml";
const EXPECTED_URI = "wss://host.test/%C5%BC%C3%B3%C5%82%C4%87";
const HEAD =
  '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://host.test/';
const TAIL = '"/></XRD>';
const XML_DECLARATION = '<?xml version="1.0"';
const RAW_BYTE_LIMIT = 1024 * 1024;
const DECODE_OBSERVATION_MS = 500;
type Encoding = "UTF-8" | "UTF-16LE" | "UTF-16BE";
enum ByteOrderMark {
  Absent,
  Present,
}
type Vector = { name: string; bytes: Buffer; mime?: string };
let fetchMock: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchMock?.mockRestore());

// Independent byte fixtures: żółć has literal UTF-8 / UTF-16 code units.
// Production decoding or URL/JID preparation never constructs the oracle.
function documentBytes(
  encoding: Encoding,
  declaration = "",
  bom = ByteOrderMark.Absent,
) {
  if (encoding === "UTF-8") {
    return Buffer.concat([
      bom === ByteOrderMark.Present
        ? Buffer.from([0xef, 0xbb, 0xbf])
        : Buffer.alloc(0),
      Buffer.from(declaration + HEAD, "ascii"),
      Buffer.from([0xc5, 0xbc, 0xc3, 0xb3, 0xc5, 0x82, 0xc4, 0x87]),
      Buffer.from(TAIL, "ascii"),
    ]);
  }
  const bytes = Buffer.concat([
    Buffer.from(declaration + HEAD, "utf16le"),
    Buffer.from([0x7c, 0x01, 0xf3, 0x00, 0x42, 0x01, 0x07, 0x01]),
    Buffer.from(TAIL, "utf16le"),
  ]);
  if (encoding === "UTF-16BE") {
    bytes.swap16();
  }
  return Buffer.concat([
    bom === ByteOrderMark.Present
      ? Buffer.from(encoding === "UTF-16LE" ? [0xff, 0xfe] : [0xfe, 0xff])
      : Buffer.alloc(0),
    bytes,
  ]);
}

const valid: Vector[] = [
  { name: "UTF-8 default", bytes: documentBytes("UTF-8") },
  {
    name: "UTF-8 declaration",
    bytes: documentBytes("UTF-8", `${XML_DECLARATION} encoding="UTF-8"?>`),
  },
  {
    name: "UTF-8 BOM",
    bytes: documentBytes("UTF-8", "", ByteOrderMark.Present),
  },
  {
    name: "UTF-8 MIME charset",
    bytes: documentBytes("UTF-8"),
    mime: `${MIME}; charset=utf-8`,
  },
];
for (const encoding of ["UTF-16LE", "UTF-16BE"] as const) {
  valid.push(
    {
      name: `${encoding} BOM without declaration`,
      bytes: documentBytes(encoding, "", ByteOrderMark.Present),
    },
    {
      name: `${encoding} BOM with UTF-16 declaration`,
      bytes: documentBytes(
        encoding,
        `${XML_DECLARATION} encoding="UTF-16"?>`,
        ByteOrderMark.Present,
      ),
    },
    {
      name: `${encoding} BOM and consistent MIME`,
      bytes: documentBytes(encoding, "", ByteOrderMark.Present),
      mime: `${MIME}; charset=utf-16`,
    },
    {
      name: `${encoding} explicit MIME without BOM`,
      bytes: documentBytes(encoding),
      mime: `${MIME}; charset=${encoding.toLowerCase()}`,
    },
    {
      name: `${encoding} quoted case-insensitive MIME`,
      bytes: documentBytes(encoding),
      mime: `${MIME}; Charset="${encoding}"`,
    },
    {
      name: `${encoding} BOM overrides wrong MIME charset`,
      bytes: documentBytes(
        encoding,
        `${XML_DECLARATION} encoding="UTF-16"?>`,
        ByteOrderMark.Present,
      ),
      mime: `${MIME}; charset=utf-8`,
    },
    // RFC 7303 §3.2 permits consumer interoperability despite conflicting labels.
    {
      name: `${encoding} MIME overrides UTF-8 declaration without BOM`,
      bytes: documentBytes(encoding, `${XML_DECLARATION} encoding="UTF-8"?>`),
      mime: `${MIME}; charset=${encoding.toLowerCase()}`,
    },
  );
}
valid.push({
  name: "UTF-8 BOM overrides UTF-16 MIME",
  bytes: documentBytes("UTF-8", "", ByteOrderMark.Present),
  mime: `${MIME}; charset=utf-16`,
});
valid.push(
  {
    name: "BOM overrides unsupported MIME charset",
    bytes: documentBytes("UTF-16BE", "", ByteOrderMark.Present),
    mime: `${MIME}; charset=not-an-encoding`,
  },
  {
    name: "quoted unrelated MIME parameter cannot invent charset",
    bytes: documentBytes("UTF-8"),
    mime: `${MIME}; note="ignore; charset=utf-16be"; charset=utf-8`,
  },
  {
    name: "UTF-8 MIME overrides UTF-16 declaration without BOM",
    bytes: documentBytes("UTF-8", `${XML_DECLARATION} encoding="UTF-16"?>`),
    mime: `${MIME}; charset=utf-8`,
  },
  {
    name: "escaped quoted charset preceding unrelated parameter",
    bytes: documentBytes("UTF-8"),
    mime: `${MIME}; charset="utf\\-8"; note="ignore\\"; charset=utf-16be"`,
  },
);

for (const vector of valid) {
  test(`XEP-0156 / XML encoding: ${vector.name}`, async () => {
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(vector.bytes, {
        headers: { "Content-Type": vector.mime ?? MIME },
      }),
    );
    expect(
      (await resolve("example.test")).map(({ uri }: { uri: string }) => uri),
    ).toEqual([EXPECTED_URI]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}

for (const encoding of ["UTF-8", "UTF-16LE", "UTF-16BE"] as const) {
  test(`XML encoding: ${encoding} bytewise chunks split BOM, declaration and characters`, async () => {
    const bytes = documentBytes(
      encoding,
      `${XML_DECLARATION} encoding="${encoding === "UTF-8" ? "UTF-8" : "UTF-16"}"?>`,
      ByteOrderMark.Present,
    );
    let offset = 0;
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            controller.enqueue(bytes.subarray(offset, ++offset));
          },
        }),
        { headers: { "Content-Type": MIME } },
      ),
    );
    expect(
      (await resolve("example.test")).map(({ uri }: { uri: string }) => uri),
    ).toEqual([EXPECTED_URI]);
    expect(offset).toBe(bytes.length);
  });
}

const malformed: Vector[] = [
  {
    name: "malformed UTF-8 in link",
    bytes: Buffer.concat([
      Buffer.from(HEAD),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(TAIL),
    ]),
  },
  {
    name: "truncated UTF-8 entity",
    bytes: Buffer.concat([documentBytes("UTF-8"), Buffer.from([0xc3])]),
  },
  {
    name: "unsupported authoritative charset",
    bytes: documentBytes("UTF-8"),
    mime: `${MIME}; charset=not-an-encoding`,
  },
  {
    name: "invalid unquoted charset escape",
    bytes: documentBytes("UTF-8"),
    mime: `${MIME}; charset=utf\\-8`,
  },
];
for (const encoding of ["UTF-16LE", "UTF-16BE"] as const) {
  malformed.push({
    name: `${encoding} without required BOM or external encoding`,
    bytes: documentBytes(encoding, `${XML_DECLARATION} encoding="UTF-16"?>`),
  });
  for (const invalid of [
    "high surrogate",
    "low surrogate",
    "odd trailing byte",
  ]) {
    let bytes: Buffer;
    if (invalid === "odd trailing byte") {
      bytes = Buffer.concat([
        documentBytes(encoding, "", ByteOrderMark.Present),
        Buffer.from([0x20]),
      ]);
    } else {
      const content = Buffer.concat([
        Buffer.from(HEAD, "utf16le"),
        Buffer.from(invalid === "high surrogate" ? [0x00, 0xd8] : [0x00, 0xdc]),
        Buffer.from(TAIL, "utf16le"),
      ]);
      if (encoding === "UTF-16BE") {
        content.swap16();
      }
      bytes = Buffer.concat([
        Buffer.from(encoding === "UTF-16LE" ? [0xff, 0xfe] : [0xfe, 0xff]),
        content,
      ]);
    }
    malformed.push({ name: `${encoding} ${invalid}`, bytes });
  }
}
for (const vector of malformed) {
  test(`XML encoding rejects before endpoint authority: ${vector.name}`, async () => {
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(vector.bytes, {
        headers: { "Content-Type": vector.mime ?? MIME },
      }),
    );
    expect(await resolve("example.test")).toEqual([]);
  });
}

test("XML decoding retains raw-byte limit and cancels oversized UTF-16 before EOF", async () => {
  // Decoded ASCII is below 1 MiB, but the received UTF-16 exceeds the wire budget.
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(HEAD, "utf16le"),
    Buffer.from(" ".repeat(RAW_BYTE_LIMIT / 2), "utf16le"),
    Buffer.from(TAIL, "utf16le"),
  ]);
  let cancelled = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          controller = stream;
          stream.enqueue(bytes);
          // No EOF: rejection must cancel without waiting for another chunk.
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Type": MIME } },
    ),
  );
  const pending = resolve("example.test");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(bytes.length).toBeGreaterThan(RAW_BYTE_LIMIT);
    const result = await Promise.race([
      pending,
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), DECODE_OBSERVATION_MS);
      }),
    ]);
    expect(result).toEqual([]);
    expect(cancelled).toBe(true);
  } finally {
    clearTimeout(timer);
    if (!cancelled) {
      controller!.close();
    }
    await pending;
  }
});

for (const name of [
  "malformed UTF-8 in link",
  "UTF-16LE high surrogate",
  "UTF-16BE high surrogate",
]) {
  test(`Fatal XML decoding cancels before EOF: ${name}`, async () => {
    const bytes = malformed.find((vector) => vector.name === name)!.bytes;
    let cancelled = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            controller = stream;
            stream.enqueue(bytes);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": MIME } },
      ),
    );
    const pending = resolve("example.test");
    try {
      // No EOF until cleanup: a broken decoder yields an explicit pending result.
      const result = await Promise.race([
        pending,
        new Promise<"pending">((resolve) => {
          timer = setTimeout(() => resolve("pending"), DECODE_OBSERVATION_MS);
        }),
      ]);
      expect(result).toEqual([]);
      expect(cancelled).toBe(true);
    } finally {
      clearTimeout(timer);
      if (!cancelled) {
        controller!.close();
      }
      await pending;
    }
  });
}
