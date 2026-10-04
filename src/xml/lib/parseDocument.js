import { SaxesParser } from "saxes";
import Element from "ltx/lib/Element.js";
import XMLError from "./XMLError.js";

export const XML_CONTEXT = { DOCUMENT: "document", XMPP: "xmpp" };
export const MAX_XML_BYTES = 1024 * 1024;
const MAX_XML_DEPTH = 64;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const encoder = new TextEncoder();

function createParser(source, context) {
  // XML 1.0 excludes lone surrogates; saxes assumes every high surrogate is paired.
  if (UNPAIRED_SURROGATE.test(source)) {
    throw new XMLError("XML contains an unpaired UTF-16 surrogate");
  }
  const parser = new SaxesParser({ xmlns: true });
  const prohibited =
    context === XML_CONTEXT.XMPP
      ? ["doctype", "processinginstruction", "comment"]
      : ["doctype"];
  for (const event of prohibited) {
    parser.on(event, () => {
      const error = new XMLError(`Prohibited XML construct: ${event}`);
      error.condition = "restricted-xml";
      throw error;
    });
  }
  parser.on("xmldecl", ({ version, encoding }) => {
    if (version !== "1.0" || (encoding && encoding.toLowerCase() !== "utf-8")) {
      throw new XMLError("Expected XML 1.0 encoded as UTF-8");
    }
  });
  return parser;
}

// Validate generated output without building a second tree or imposing receive limits.
export function validateDocument(source, context = XML_CONTEXT.DOCUMENT) {
  createParser(source, context).write(source).close();
}

/** Validate the complete document before exposing its tree to a consumer. */
export default function parseDocument(source, context = XML_CONTEXT.DOCUMENT) {
  if (
    source.length > MAX_XML_BYTES ||
    encoder.encode(source).length > MAX_XML_BYTES
  ) {
    const error = new XMLError("XML document exceeds size limit");
    error.condition = "policy-violation";
    throw error;
  }
  const parser = createParser(source, context);
  let root;
  let cursor;
  let depth = 0;
  parser.on("opentag", (tag) => {
    depth += 1;
    if (depth > MAX_XML_DEPTH) {
      const error = new XMLError("XML document exceeds depth limit");
      error.condition = "policy-violation";
      throw error;
    }
    const element = new Element(
      tag.name,
      Object.fromEntries(
        Object.values(tag.attributes).map(({ name, value }) => [name, value]),
      ),
    );
    if (cursor) {
      cursor.append(element);
    } else {
      root = element;
    }
    cursor = element;
  });
  parser.on("closetag", () => {
    depth -= 1;
    cursor = cursor.parent;
  });
  parser.on("text", (text) => {
    cursor?.t(text);
  });
  parser.on("cdata", (text) => {
    cursor?.t(text);
  });
  parser.write(source).close();
  return root;
}
