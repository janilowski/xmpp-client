import { expect, test } from "bun:test";
import { SaxesParser } from "saxes";
import SourceElement from "ltx/src/Element.js";
import xml from "../index.js";

const constructors = [
  ["factory", (attributes, text) => xml("message", attributes, text)],
  [
    "CJS Element",
    (attributes, text) => new xml.Element("message", attributes).t(text),
  ],
  [
    "ESM Element",
    (attributes, text) => new SourceElement("message", attributes).t(text),
  ],
];

// XML 1.0 §§2.11/3.3.3: literal TAB/LF/CR are normalized in attributes.
// Numeric references preserve the value without changing text serialization.
for (const value of ["\t", "\n", "\r", "\r\n", 'a\tb\nc\rd&"<>']) {
  test.each(constructors)(
    `XML 1.0 §3.3.3: %s preserves attribute ${JSON.stringify(value)}`,
    (_name, construct) => {
      const element = construct({ id: value }, value);
      const source = element.toString();
      const parser = new SaxesParser({ xmlns: true });
      let received;
      parser.on("opentag", (tag) => {
        received = tag.attributes.id.value;
      });
      parser.write(source).close();
      expect(received).toBe(value);
      expect(source.endsWith(`>${xml.escapeXMLText(value)}</message>`)).toBe(
        true,
      );
      expect(element.attrs.id).toBe(value);
    },
  );
}
