import parseDocument, {
  validateDocument,
  XML_CONTEXT,
} from "../lib/parseDocument.js";

test.each([
  '<root a="first" a="second"/>',
  "<root><unbound:child/></root>",
  '<root xmlns:p="urn:test" xmlns:q="urn:test" p:a="first" q:a="second"/>',
  '<root xmlns:xml="urn:test"/>',
  "<root>\u0000</root>",
  "<root value='\uFFFF'/>",
  "<root><bad name/></root>",
  "<root/><another/>",
  "<root>",
])("outgoing XML validation rejects malformed documents: %s", (source) => {
  expect(() => validateDocument(source, XML_CONTEXT.XMPP)).toThrow();
});

// XML 1.0 §2.2 excludes surrogate code points, not valid supplementary pairs.
test.each([
  ["high surrogate before ASCII", "\uD800x"],
  ["high surrogate before NUL", "\uD800\u0000"],
  ["consecutive high surrogates", "\uD800\uD800"],
  ["unpaired low surrogate", "\uDC00"],
])("XML validation rejects invalid UTF-16: %s", (_name, value) => {
  for (const source of [`<root>${value}</root>`, `<root value="${value}"/>`]) {
    expect(() => validateDocument(source, XML_CONTEXT.XMPP)).toThrow();
    expect(() => parseDocument(source, XML_CONTEXT.XMPP)).toThrow();
  }
});

test.each([
  "<!DOCTYPE root><root/>",
  "<!-- comment --><root/>",
  "<?instruction data?><root/>",
  '<?xml version="1.1"?><root/>',
  '<?xml version="1.0" encoding="iso-8859-1"?><root/>',
])("outgoing XMPP validation retains shared XML policy: %s", (source) => {
  expect(() => validateDocument(source, XML_CONTEXT.XMPP)).toThrow();
  expect(() => parseDocument(source, XML_CONTEXT.XMPP)).toThrow();
});

test("outgoing XML validation returns no element tree", () => {
  expect(
    validateDocument(
      '<message xmlns="jabber:client"><body>valid &amp; escaped</body></message>',
      XML_CONTEXT.XMPP,
    ),
  ).toBeUndefined();
});

test("document-context validation preserves comments and processing instructions", () => {
  expect(
    validateDocument("<!-- comment --><?instruction data?><root/>"),
  ).toBeUndefined();
});

// RFC 6120 §11.5: SDDecl is forbidden on output; incoming "no" may be ignored.
test.each(["yes", "no"])(
  "outgoing XMPP rejects standalone=%s",
  (standalone) => {
    const source = `<?xml version="1.0" standalone="${standalone}"?><root/>`;
    expect(() => validateDocument(source, XML_CONTEXT.XMPP)).toThrow(
      "standalone",
    );
  },
);

test.each(["yes", "no"])(
  "document and incoming XMPP grammar preserve standalone=%s",
  (standalone) => {
    const source = `<?xml version="1.0" standalone="${standalone}"?><root/>`;
    expect(() => validateDocument(source, XML_CONTEXT.DOCUMENT)).not.toThrow();
    expect(() => parseDocument(source, XML_CONTEXT.DOCUMENT)).not.toThrow();
    expect(() => parseDocument(source, XML_CONTEXT.XMPP)).not.toThrow();
    expect(validateDocument(source, XML_CONTEXT.DOCUMENT)).toBeUndefined();
    expect(parseDocument(source, XML_CONTEXT.DOCUMENT).name).toBe("root");
    expect(parseDocument(source, XML_CONTEXT.XMPP).name).toBe("root");
  },
);

test.each([
  '<?xml version="1.0"?><root/>',
  '<?xml version="1.0" encoding="UTF-8"?><root/>',
])(
  "outgoing XMPP preserves an XML declaration without SDDecl: %s",
  (source) => {
    expect(validateDocument(source, XML_CONTEXT.XMPP)).toBeUndefined();
  },
);

// Size/depth limits protect receive-side parsing; they are not XML grammar rules.
test("outgoing XML validation does not inherit the receive-side size limit", () => {
  const source = `<root>${"x".repeat(1024 * 1024 + 1)}</root>`;
  expect(validateDocument(source, XML_CONTEXT.XMPP)).toBeUndefined();
  expect(() => parseDocument(source, XML_CONTEXT.XMPP)).toThrow("size limit");
});

test("outgoing XML validation does not inherit the receive-side depth limit", () => {
  const source = "<root>".repeat(65) + "</root>".repeat(65);
  expect(validateDocument(source, XML_CONTEXT.XMPP)).toBeUndefined();
  expect(() => parseDocument(source, XML_CONTEXT.XMPP)).toThrow("depth limit");
});
