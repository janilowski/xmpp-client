import { expect, test } from "bun:test";
import xml from "../index.js";
import parseDocument from "../lib/parseDocument.js";
import LtxElement from "ltx/lib/Element.js";
import SourceElement from "ltx/src/Element.js";
import clone from "ltx/lib/clone.js";

const XML = "http://www.w3.org/XML/1998/namespace";
const ORIGINAL = "urn:test:original";
const REPLACEMENT = "urn:test:replacement";
const ORIGINS = ["document", "stream", "factory", "CJS", "ESM"];

// Namespaces in XML 1.0 §§3/6.1/6.2: lookup uses expanded names, not a
// URI-to-single-prefix map. Literal parser inputs do not use our serializer.
// https://www.w3.org/TR/REC-xml-names/#ns-decl
// https://www.w3.org/TR/REC-xml-names/#scoping
function tree(origin, source, build) {
  if (origin === "document") {
    return parseDocument(source);
  }
  if (origin === "stream") {
    const parser = new xml.Parser();
    const errors = [];
    let result;
    parser.on("error", (error) => errors.push(error));
    parser.on("element", (element) => {
      result = element;
    });
    parser.end(`<stream>${source}</stream>`);
    expect(errors).toEqual([]);
    expect(result).toBeDefined();
    return result;
  }
  const construct =
    origin === "factory"
      ? xml
      : (name, attrs) =>
          new (origin === "CJS" ? LtxElement : SourceElement)(name, attrs);
  return build(construct);
}

test.each(ORIGINS)(
  "Namespaces §3: %s resolves implicit xml attributes",
  (origin) => {
    const value = tree(origin, '<root xml:lang="pl"/>', (construct) =>
      construct("root", { "xml:lang": "pl" }),
    );
    expect(value.attrs["xml:lang"]).toBe("pl");
    expect(value.getAttr("lang", XML)).toBe("pl");
    expect(value.getAttr("space", XML)).toBeUndefined();
  },
);

test.each(ORIGINS)(
  "Namespaces §6.1: %s searches all aliases for one namespace",
  (origin) => {
    const value = tree(
      origin,
      `<root xmlns:p="${ORIGINAL}" xmlns:q="${ORIGINAL}" p:a="value"/>`,
      (construct) =>
        construct("root", {
          "xmlns:p": ORIGINAL,
          "xmlns:q": ORIGINAL,
          "p:a": "value",
        }),
    );
    expect(value.getAttr("p:a")).toBe("value");
    expect(value.getAttr("a", ORIGINAL)).toBe("value");
    expect(value.getXmlns()).toEqual({ [ORIGINAL]: "q" });
    // Mutation of this public tree must not leave a stale namespace lookup cache.
    value.attrs["q:b"] = "second";
    expect(value.getAttr("b", ORIGINAL)).toBe("second");
    value.attrs["xmlns:q"] = REPLACEMENT;
    expect(value.getAttr("b", ORIGINAL)).toBeUndefined();
    expect(value.getAttr("b", REPLACEMENT)).toBe("second");
  },
);

test.each(ORIGINS)(
  "Namespaces §6.1: %s respects prefix rebinding without affecting siblings",
  (origin) => {
    const root = tree(
      origin,
      `<root xmlns:p="${ORIGINAL}"><child xmlns:p="${REPLACEMENT}" p:a="new"/><sibling p:a="old"/></root>`,
      (construct) => {
        const value = construct("root", { "xmlns:p": ORIGINAL });
        value.append(
          construct("child", { "xmlns:p": REPLACEMENT, "p:a": "new" }),
        );
        value.append(construct("sibling", { "p:a": "old" }));
        return value;
      },
    );
    const child = root.getChild("child");
    const sibling = root.getChild("sibling");
    expect(child.getAttr("a", REPLACEMENT)).toBe("new");
    expect(child.getAttr("a", ORIGINAL)).toBe(null);
    expect(sibling.getAttr("a", ORIGINAL)).toBe("old");
    expect(sibling.getAttr("a", REPLACEMENT)).toBe(null);
  },
);

test.each(ORIGINS)(
  "Namespaces §6.1: %s accepts ordinary attributes shadowing object methods",
  (origin) => {
    const value = tree(
      origin,
      `<root xmlns:p="${ORIGINAL}" hasOwnProperty="ordinary" constructor="data" p:a="value"/>`,
      (construct) =>
        construct("root", {
          "xmlns:p": ORIGINAL,
          hasOwnProperty: "ordinary",
          constructor: "data",
          "p:a": "value",
        }),
    );
    expect(value.getAttr("hasOwnProperty")).toBe("ordinary");
    expect(value.getAttr("constructor")).toBe("data");
    expect(() => value.getAttr("a", ORIGINAL)).not.toThrow();
    expect(value.getAttr("a", ORIGINAL)).toBe("value");
    expect(() => value.getXmlns()).not.toThrow();
    expect(value.getXmlns()).toEqual({ [ORIGINAL]: "p" });
  },
);

test.each(ORIGINS)(
  "Namespaces §6.2: %s preserves unqualified and absent-attribute contracts",
  (origin) => {
    const value = tree(
      origin,
      `<root xmlns="${ORIGINAL}" xmlns:p="${REPLACEMENT}" a="plain" p:a="qualified"/>`,
      (construct) =>
        construct("root", {
          xmlns: ORIGINAL,
          "xmlns:p": REPLACEMENT,
          a: "plain",
          "p:a": "qualified",
        }),
    );
    expect(value.getAttr("a")).toBe("plain");
    expect(value.getAttr("a", "")).toBe("plain");
    expect(value.getAttr("p:a")).toBe("qualified");
    expect(value.getAttr("a", ORIGINAL)).toBe(null);
    expect(value.getAttr("a", REPLACEMENT)).toBe("qualified");
    expect(value.getAttr("missing", REPLACEMENT)).toBeUndefined();
    expect(value.getAttr("missing", "urn:test:unknown")).toBe(null);
    expect(value.getAttr("missing")).toBeUndefined();
  },
);

test("namespace fixes retain external constructor identity", () => {
  expect(xml.Element).toBe(LtxElement);
  expect(xml("root")).toBeInstanceOf(LtxElement);
});

test.each(ORIGINS)(
  "Namespaces §3: %s resolves implicit xml element namespace",
  (origin) => {
    const value = tree(origin, '<xml:root xml:lang="pl"/>', (construct) =>
      construct("xml:root", { "xml:lang": "pl" }),
    );
    expect(value.findNS("xml")).toBe(XML);
    expect(value.getNS()).toBe(XML);
  },
);

test.each(ORIGINS)(
  "Namespaces §6.1: %s namespace map drops shadowed ancestor bindings",
  (origin) => {
    const value = tree(
      origin,
      `<root xmlns:p="${ORIGINAL}"><child xmlns:p="${REPLACEMENT}"/></root>`,
      (construct) => {
        const root = construct("root", { "xmlns:p": ORIGINAL });
        root.append(construct("child", { "xmlns:p": REPLACEMENT }));
        return root;
      },
    ).getChild("child");
    expect(value.getXmlns()).toEqual({ [REPLACEMENT]: "p" });
  },
);

test.each(ORIGINS)(
  "Namespaces §6.1: %s keeps child alias priority for namespace maps",
  (origin) => {
    const value = tree(
      origin,
      `<root xmlns:p="${ORIGINAL}"><child xmlns:q="${ORIGINAL}"/></root>`,
      (construct) => {
        const root = construct("root", { "xmlns:p": ORIGINAL });
        root.append(construct("child", { "xmlns:q": ORIGINAL }));
        return root;
      },
    ).getChild("child");
    expect(value.getXmlns()).toEqual({ [ORIGINAL]: "q" });
  },
);

test.each(ORIGINS)(
  "Namespaces §3: %s ignores ordinary attribute names containing xmlns",
  (origin) => {
    const value = tree(
      origin,
      `<root xmlnsfoo="${ORIGINAL}" a="plain"/>`,
      (construct) => construct("root", { xmlnsfoo: ORIGINAL, a: "plain" }),
    );
    expect(value.getXmlns()).toEqual({});
    expect(value.getAttr("a", ORIGINAL)).toBe(null);
    expect(value.getAttr("xmlnsfoo")).toBe(ORIGINAL);
  },
);

test.each(ORIGINS)(
  "XML attribute contract: %s preserves legal __proto__ payload",
  (origin) => {
    const value = tree(origin, '<root __proto__="ordinary"/>', (construct) =>
      construct("root", { ["__proto__"]: "ordinary" }),
    );
    expect(Object.hasOwn(value.attrs, "__proto__")).toBe(true);
    expect(value.getAttr("__proto__")).toBe("ordinary");
    expect(value.toString()).toBe('<root __proto__="ordinary"/>');
    expect(Object.getPrototypeOf(value.attrs)).toBe(Object.prototype);
  },
);

for (const [name, Constructor] of [
  ["CJS", LtxElement],
  ["ESM", SourceElement],
]) {
  test(`XML attribute contract: ${name} does not invent prototype-named attributes`, () => {
    const element = new Constructor("root");
    for (const key of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(element.getAttr(key)).toBeUndefined();
      expect(element.attr(key)).toBeUndefined();
    }
  });

  test(`XML attribute contract: ${name} fluent setter preserves __proto__ and clones`, () => {
    const element = new Constructor("root");
    const retained = element.attrs;
    expect(element.attr("__proto__", "ordinary")).toBe(element);
    expect(Object.hasOwn(retained, "__proto__")).toBe(true);
    expect(element.attr("__proto__")).toBe("ordinary");
    expect(element.attrs).toBe(retained);
    expect(Object.getPrototypeOf(retained)).toBe(Object.prototype);
    expect(element.toString()).toBe('<root __proto__="ordinary"/>');
    expect(clone(element).toString()).toBe('<root __proto__="ordinary"/>');
  });

  test(`XML attribute contract: ${name} updates existing nonconfigurable __proto__ data`, () => {
    const element = new Constructor("root");
    const retained = element.attrs;
    Object.defineProperty(retained, "__proto__", {
      value: "before",
      writable: true,
      configurable: false,
      enumerable: false,
    });
    const descriptor = Object.getOwnPropertyDescriptor(retained, "__proto__");
    expect(() => element.setAttrs({ ["__proto__"]: "after" })).not.toThrow();
    expect(element.attrs).toBe(retained);
    expect(Object.getOwnPropertyDescriptor(retained, "__proto__")).toEqual({
      ...descriptor,
      value: "after",
    });
    expect(Object.getPrototypeOf(retained)).toBe(Object.prototype);
  });

  test(`XML attribute contract: ${name} preserves an existing __proto__ accessor`, () => {
    const element = new Constructor("root");
    let value = "before";
    let calls = 0;
    Object.defineProperty(element.attrs, "__proto__", {
      configurable: false,
      get() {
        return value;
      },
      set(next) {
        calls += 1;
        value = next;
      },
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      element.attrs,
      "__proto__",
    );
    expect(() => element.setAttrs({ ["__proto__"]: "after" })).not.toThrow();
    expect(value).toBe("after");
    expect(calls).toBe(1);
    expect(Object.getOwnPropertyDescriptor(element.attrs, "__proto__")).toEqual(
      descriptor,
    );
  });

  test(`XML attribute contract: ${name} cannot overwrite a read-only __proto__`, () => {
    const element = new Constructor("root");
    Object.defineProperty(element.attrs, "__proto__", {
      value: "before",
      writable: false,
      configurable: true,
    });
    expect(() => element.setAttrs({ ["__proto__"]: "after" })).toThrow(
      TypeError,
    );
    expect(element.attrs.__proto__).toBe("before");
  });

  test(`XML attribute contract: ${name} setAttrs preserves identity and reads enumerable getters once`, () => {
    const element = new Constructor("root");
    const retained = element.attrs;
    const symbol = Symbol("retained Object.assign compatibility");
    let calls = 0;
    const input = { [symbol]: "symbol data" };
    Object.defineProperty(input, "__proto__", {
      enumerable: true,
      get() {
        calls += 1;
        return "ordinary";
      },
    });
    Object.defineProperty(input, "hidden", {
      value: "private",
      enumerable: false,
    });
    element.setAttrs(input);
    expect(element.attrs).toBe(retained);
    expect(element.attrs.__proto__).toBe("ordinary");
    expect(element.attrs[symbol]).toBe("symbol data");
    expect(Object.hasOwn(element.attrs, "hidden")).toBe(false);
    expect(calls).toBe(1);
  });
}
