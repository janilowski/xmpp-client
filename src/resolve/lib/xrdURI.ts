const XML_WHITESPACE = /[\t\n\r ]+/g;
const EXCLUDED_URI_CHARACTERS = /[^\x21-\x7e]|["<>\\^`{|}]/gu;

// XRD anyURI: XML Schema whitespace collapse, then XLink §5.4 escaping.
// Preserve URI delimiters and existing escapes before native URL processing.
export default function prepareURI(value: string) {
  return value
    .replace(XML_WHITESPACE, " ")
    .replace(/^ | $/g, "")
    .replace(EXCLUDED_URI_CHARACTERS, encodeURIComponent);
}
