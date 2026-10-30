import parseDocument, {
  MAX_XML_BYTES,
  XML_CONTEXT,
} from "../../xml/lib/parseDocument.js";

const MAX_BOM_BYTES = 3;
const UTF8 = "utf-8";
const UTF16LE = "utf-16le";
const UTF16BE = "utf-16be";
const BYTE_ORDER_MARKS = [
  [UTF8, [0xef, 0xbb, 0xbf]],
  [UTF16LE, [0xff, 0xfe]],
  [UTF16BE, [0xfe, 0xff]],
] as const;

function charset(contentType: string | null) {
  let position = contentType?.indexOf(";") ?? -1;
  if (!contentType || position === -1) {
    return;
  }
  // Consume complete parameters so a quoted value cannot invent a charset.
  const parameter =
    /;\s*([!#$%&'*+.^_`|~\dA-Za-z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~\dA-Za-z-]+))\s*/y;
  let encoding: string | undefined;
  while (position < contentType.length) {
    parameter.lastIndex = position;
    const match = parameter.exec(contentType);
    if (!match) {
      throw new TypeError("Invalid XML media type parameters");
    }
    if (match[1].toLowerCase() === "charset") {
      encoding ??=
        match[2] === undefined ? match[3] : match[2].replace(/\\(.)/g, "$1");
    }
    position = parameter.lastIndex;
  }
  return encoding?.toLowerCase();
}

// RFC 7303 §§3.2–3.3: BOM, then MIME charset, then XML/default encoding.
// Decoding is fatal and bounded before parsing; XMPP's UTF-8 rule is separate.
export default async function readXML(response: Response) {
  const reader = response.body!.getReader();
  const prefix = new Uint8Array(MAX_BOM_BYTES);
  let prefixLength = 0;
  let bytes = 0;
  let source = "";
  let decoder: TextDecoder | undefined;
  let context = XML_CONTEXT.DOCUMENT;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      let offset = 0;
      if (!done) {
        bytes += value.byteLength;
        if (bytes > MAX_XML_BYTES) {
          throw new RangeError("XML response exceeds size limit");
        }
        while (
          !decoder &&
          prefixLength < MAX_BOM_BYTES &&
          offset < value.length
        ) {
          prefix[prefixLength++] = value[offset++];
        }
      }
      if (!decoder && (prefixLength === MAX_BOM_BYTES || done)) {
        const encoding =
          BYTE_ORDER_MARKS.find(
            ([, bom]) =>
              prefixLength >= bom.length &&
              bom.every((byte, index) => prefix[index] === byte),
          )?.[0] ?? charset(response.headers.get("Content-Type"));
        if (encoding !== undefined) {
          if (
            encoding !== UTF8 &&
            encoding !== UTF16LE &&
            encoding !== UTF16BE
          ) {
            throw new TypeError("Unsupported XML encoding");
          }
          // Authoritative HTTP encoding overrides an inconsistent declaration.
          context = XML_CONTEXT.HTTP;
        }
        decoder = new TextDecoder(encoding ?? UTF8, { fatal: true });
        source += decoder.decode(prefix.subarray(0, prefixLength), {
          stream: true,
        });
      }
      if (done) {
        source += decoder!.decode();
        break;
      }
      if (decoder) {
        source += decoder.decode(value.subarray(offset), { stream: true });
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return parseDocument(source, context);
}
