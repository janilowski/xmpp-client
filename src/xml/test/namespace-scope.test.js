import { expect, test } from "bun:test";
import xml from "../index.js";
import parseDocument from "../lib/parseDocument.js";
import { jsx, jsxs } from "../jsx-runtime.js";
import LtxElement from "ltx/lib/Element.js";
import SourceElement from "ltx/src/Element.js";
import clone from "ltx/lib/clone.js";

const CLIENT = "jabber:client";
const FOREIGN = "urn:example:namespace-scope";
const SOURCE = `<message xmlns="${CLIENT}" xmlns:p="${FOREIGN}"><error xmlns=""><condition/><restored xmlns="${FOREIGN}"><inside/><again xmlns=""><leaf/><p:qualified/></again><sibling/></restored><plain/></error><after/><p:after/></message>`;
const EXPECTED = [
  ["message", CLIENT],
  ["error", ""],
  ["condition", ""],
  ["restored", FOREIGN],
  ["inside", FOREIGN],
  ["again", ""],
  ["leaf", ""],
  ["qualified", FOREIGN],
  ["sibling", FOREIGN],
  ["plain", ""],
  ["after", CLIENT],
  ["after", FOREIGN],
];

function expandedNames(root) {
  return [
    [root.getName(), root.getNS() ?? ""],
    ...root.getChildElements().flatMap(expandedNames),
  ];
}

function buildTree() {
  return xml(
    "message",
    { xmlns: CLIENT, "xmlns:p": FOREIGN },
    xml(
      "error",
      { xmlns: "" },
      xml("condition"),
      xml(
        "restored",
        { xmlns: FOREIGN },
        xml("inside"),
        xml("again", { xmlns: "" }, xml("leaf"), xml("p:qualified")),
        xml("sibling"),
      ),
      xml("plain"),
    ),
    xml("after"),
    xml("p:after"),
  );
}

// Namespaces in XML 1.0 §6.2: cancellation is a declaration, not its absence.
test.each(["document", "stream", "builder", "clone"])(
  "§6.2: %s trees cancel, restore and isolate namespace scope",
  (origin) => {
    let root;
    if (origin === "document") {
      root = parseDocument(SOURCE);
    } else if (origin === "stream") {
      const parser = new xml.Parser();
      parser.on("element", (element) => {
        root = element;
      });
      parser.end(`<stream xmlns="${CLIENT}">${SOURCE}</stream>`);
    } else {
      root = buildTree();
      if (origin === "clone") {
        root = clone(root);
      }
    }
    expect(root).toBeInstanceOf(xml.Element);
    expect(expandedNames(root)).toEqual(EXPECTED);
    expect(root.getChild("error").is("error", CLIENT)).toBe(false);
    expect(root.getChildren("error", CLIENT)).toEqual([]);
  },
);

test("§6.2: JSX, direct and external ltx constructors retain the same Element contract", () => {
  const external = new LtxElement("error", { xmlns: "" });
  const direct = new xml.Element("error", { xmlns: "" });
  const jsxTree = jsxs("message", {
    xmlns: CLIENT,
    children: [
      jsx("error", { xmlns: "", children: jsx("condition", {}) }),
      external,
      direct,
    ],
  });
  expect(xml.Element).toBe(LtxElement);
  for (const child of jsxTree.getChildElements()) {
    expect(child).toBeInstanceOf(xml.Element);
    expect(child.getNS()).toBe("");
    expect(child.is("error", CLIENT)).toBe(false);
  }
  expect(jsxTree.children[1]).toBe(external);
  expect(jsxTree.children[2]).toBe(direct);
  expect(jsxTree.children[0].getChild("condition").getNS()).toBe("");
});

test("§6.2: fluent construction and cloned external children preserve cancellation", () => {
  const root = new xml.Element("message", { xmlns: CLIENT });
  const error = root.c("error", { xmlns: "" });
  const leaf = error.c("condition");
  expect(error.getNS()).toBe("");
  expect(leaf.getNS()).toBe("");
  expect(root.c("after").getNS()).toBe(CLIENT);
  expect(expandedNames(clone(root))).toEqual([
    ["message", CLIENT],
    ["error", ""],
    ["condition", ""],
    ["after", CLIENT],
  ]);
});

test.each([
  ["CommonJS", LtxElement],
  ["ES module", SourceElement],
])(
  "§6.2: ltx %s exports preserve explicit cancellation",
  (_format, Element) => {
    const root = new Element("message", { xmlns: CLIENT });
    const cancelled = root.c("error", { xmlns: "" });
    expect(cancelled.getNS()).toBe("");
    expect(cancelled.c("condition").getNS()).toBe("");
    expect(root.c("after").getNS()).toBe(CLIENT);
  },
);

test("namespace selectors retain the empty-string wildcard contract", () => {
  const root = xml(
    "message",
    { xmlns: CLIENT },
    xml("error", { xmlns: FOREIGN }),
    xml("error", { xmlns: "" }),
  );
  expect(root.getChildren("error", "")).toEqual(root.getChildElements());
});

test.each([undefined, null])(
  "§6.2: omitted declaration %s inherits the serialized parent namespace",
  (xmlns) => {
    const root = new xml.Element("message", { xmlns: CLIENT });
    const child = root.c("body", { xmlns });
    expect(child.getNS()).toBe(CLIENT);
    expect(root.toString()).toBe(
      `<message xmlns="${CLIENT}"><body/></message>`,
    );
    expect(parseDocument(root.toString()).getChild("body").getNS()).toBe(
      CLIENT,
    );
  },
);
