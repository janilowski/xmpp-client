import { SaxesParser } from "saxes";
import Element from "ltx/lib/Element.js";
import XMLError from "./XMLError.js";

export const XML_CONTEXT = { DOCUMENT: "document", XMPP: "xmpp" };

/** Validate the complete document before exposing its tree to a consumer. */
export default function parseDocument(source, context = XML_CONTEXT.DOCUMENT) {
  const parser = new SaxesParser({ xmlns: true });
  let root;
  let cursor;
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
  parser.on("opentag", (tag) => {
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
