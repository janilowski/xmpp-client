import isIRI from "./isIRI.js";

const NON_URI_CHARACTER = /[^\x21-\x7e]/u;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const FIRST_SEGMENT = /^[^/?#]*/u;

// RFC 3986 §§3/4.1: ASCII URI references may omit the scheme, but their
// first relative path segment must not contain a colon. Never normalize.
export default function isURIReference(value: string) {
  if (NON_URI_CHARACTER.test(value)) {
    return false;
  }
  if (SCHEME.test(value)) {
    return isIRI(value);
  }
  if (FIRST_SEGMENT.exec(value)![0].includes(":")) {
    return false;
  }
  // A synthetic scheme reuses the same authority/path/query/fragment grammar.
  return isIRI(`relative:${value}`);
}
