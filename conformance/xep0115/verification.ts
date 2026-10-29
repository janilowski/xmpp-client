import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  verificationString,
} from "../../src/caps/verification.ts";
import parseXML from "../../src/xml/lib/parseDocument.js";
import type { Element } from "../../types/index.js";
import {
  INFO,
  DATA,
  SIMPLE_IDENTITY,
  FEATURES,
  SIMPLE_XML,
  SIMPLE_CANONICAL,
  SIMPLE_SHA1,
  COMPLEX_XML,
  COMPLEX_CANONICAL,
  COMPLEX_SHA1,
} from "./fixture.ts";

// The existing JavaScript parser's inferred return type omits its event-built tree.
const parseDocument = parseXML as unknown as (source: string) => Element;

describe("XEP-0115 v1.6.0 §5 — verification strings", () => {
  test.each([
    ["simple", SIMPLE_XML, SIMPLE_CANONICAL, SIMPLE_SHA1],
    ["complex", COMPLEX_XML, COMPLEX_CANONICAL, COMPLEX_SHA1],
  ])(
    "§§5.2–5.3: published %s vector",
    async (_name, source, expected, hash) => {
      const query = parseDocument(source) as Element;
      expect(canonicalize(query)).toBe(expected);
      expect(await verificationString(query)).toBe(hash);
      expect(await verificationString(query, "sha-1")).toBe(hash);
    },
  );

  test.each([
    [SIMPLE_XML, "Wr6IGEKhx6b9627gBmi/cCmpxXBc/GYq5zWuYfWGWoc="],
    [COMPLEX_XML, "VyRoCfkwN7Q9lxZhqOI+mxfSpo/MsaCF4hBufCzfCpI="],
  ])(
    "§§5.1/9.1: optional SHA-256 uses binary UTF-8 digest",
    async (source, hash) => {
      // Independently computed from the explicit canonical strings with node:crypto.
      expect(
        await verificationString(parseDocument(source) as Element, "sha-256"),
      ).toBe(hash);
    },
  );

  test("§5.1: sort identities by category, type, then explicit language", () => {
    const query = parseDocument(`<query xmlns="${INFO}">
      <identity category="server" type="im" name="Server"/>
      <identity category="client" type="web" name="Web"/>
      <identity category="client" type="pc" xml:lang="pl" name="Polski"/>
      <identity category="client" type="pc" name="Default"/>
      <identity category="client" type="pc" xml:lang="en" name="English"/>
    </query>`) as Element;
    expect(canonicalize(query)).toBe(
      "client/pc//Default<client/pc/en/English<client/pc/pl/Polski<" +
        "client/web//Web<server/im//Server<",
    );
  });

  test.each([
    ['<identity category="client" type="pc"/>', "client/pc//<"],
    [
      '<identity category="client" type="pc" xml:lang="" name=""/>',
      "client/pc//<",
    ],
    ['<identity category="client" type="pc" xml:lang="en"/>', "client/pc/en/<"],
  ])(
    "§5.1: absent optional identity components retain every slash",
    (identity, expected) => {
      const query = parseDocument(
        `<query xmlns="${INFO}">${identity}</query>`,
      ) as Element;
      expect(canonicalize(query)).toBe(expected);
    },
  );

  test("§5.1: raw discovery data is neither inferred nor changed", async () => {
    const query = parseDocument(`<query xmlns="${INFO}" node="unchanged">
      ${SIMPLE_IDENTITY}<feature var="urn:example:only"/>
      <metadata xmlns="urn:example:extension">retained</metadata>
    </query>`) as Element;
    const before = query.toString();
    const children = [...query.children];
    expect(canonicalize(query)).toBe(
      "client/pc//Exodus 0.9.1<urn:example:only<",
    );
    await verificationString(query);
    expect(query.toString()).toBe(before);
    expect(query.children).toEqual(children);
    expect(query.attrs.node).toBe("unchanged");
  });

  test.each([[[3, 2, 1, 0]], [[1, 3, 0, 2]], [[2, 0, 3, 1]]])(
    "§5.1: feature wire order is irrelevant (%j)",
    async (order) => {
      const features = order
        .map((index) => `<feature var="${FEATURES[index]}"/>`)
        .join("");
      const query = parseDocument(
        `<query xmlns="${INFO}">${features}${SIMPLE_IDENTITY}</query>`,
      ) as Element;
      expect(canonicalize(query)).toBe(SIMPLE_CANONICAL);
      expect(await verificationString(query)).toBe(SIMPLE_SHA1);
    },
  );

  test.each([false, true])(
    "§5.1: forms, fields and values are sorted independently (reverse=%s)",
    (reverse) => {
      const values = reverse
        ? "<value>beta</value><value>Alpha</value>"
        : "<value>Alpha</value><value>beta</value>";
      const fields = [
        '<field var="FORM_TYPE" type="hidden"><value>urn:example:a</value></field>',
        `<field var="z" type="text-multi">${values}</field>`,
        '<field var="A"><value>last</value></field>',
      ];
      if (reverse) {
        fields.reverse();
      }
      const forms = [
        `<x xmlns="${DATA}" type="result">${fields.join("")}</x>`,
        `<x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:z</value></field><field var="field"><value>other</value></field></x>`,
      ];
      if (reverse) {
        forms.reverse();
      }
      const query = parseDocument(
        `<query xmlns="${INFO}">${forms.join("")}${SIMPLE_IDENTITY}</query>`,
      ) as Element;
      expect(canonicalize(query)).toBe(
        "client/pc//Exodus 0.9.1<urn:example:a<A<last<z<Alpha<beta<urn:example:z<field<other<",
      );
    },
  );

  test("§5.1 / RFC 4790 §9.3: UTF-8 octet ordering is not UTF-16 or locale order", () => {
    const query = parseDocument(`<query xmlns="${INFO}">${SIMPLE_IDENTITY}
      <feature var="urn:example:𐀀"/><feature var="urn:example:"/>
      <feature var="urn:example:é"/><feature var="urn:example:z"/>
      <x xmlns="${DATA}" type="result">
        <field var="FORM_TYPE" type="hidden"><value>urn:example:𐀀</value></field>
      </x>
      <x xmlns="${DATA}" type="result">
        <field var="FORM_TYPE" type="hidden"><value>urn:example:</value></field>
        <field var="𐀀"><value>late</value></field>
        <field var="" type="text-multi"><value>𐀀</value><value></value><value>é</value><value>z</value></field>
      </x>
    </query>`) as Element;
    expect(canonicalize(query)).toBe(
      "client/pc//Exodus 0.9.1<urn:example:z<urn:example:é<urn:example:<urn:example:𐀀<" +
        "urn:example:<<z<é<<𐀀<𐀀<late<urn:example:𐀀<",
    );
  });

  test("§5.1: canonicalization does not normalize Unicode or trim data", () => {
    const query = parseDocument(`<query xmlns="${INFO}">
      <identity category="client" type="pc" name=" Å "/>
      <feature var="urn:example:Å"/><feature var="urn:example:Å"/>
      <x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value> urn:example:form </value></field><field var=" data "><value> value </value></field></x>
    </query>`) as Element;
    expect(canonicalize(query)).toBe(
      "client/pc// Å <urn:example:Å<urn:example:Å< urn:example:form < data < value <",
    );
  });

  test("§§5.1/5.4/9.3: XML entities are decoded once, never twice", async () => {
    const literal = parseDocument(`<query xmlns="${INFO}">
      <identity category="client" type="pc" name="Client&amp;lt;feature"/>
      <feature var="urn:example:&amp;lt;"/>
      <x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:&amp;lt;</value></field><field var="&amp;lt;"><value>&amp;lt;</value></field></x>
    </query>`) as Element;
    const character = parseDocument(`<query xmlns="${INFO}">
      <identity category="client" type="pc" name="Client&lt;feature"/>
      <feature var="urn:example:&lt;"/>
      <x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:&lt;</value></field><field var="&lt;"><value>&lt;</value></field></x>
    </query>`) as Element;
    expect(canonicalize(literal)).toBe(
      "client/pc//Client&lt;feature<urn:example:&lt;<urn:example:&lt;<&lt;<&lt;<",
    );
    expect(canonicalize(character)).toBe(
      "client/pc//Client<feature<urn:example:<<urn:example:<<<<<<",
    );
    expect(await verificationString(literal)).not.toBe(
      await verificationString(character),
    );
  });

  test("§5.1 / XEP-0128 §2: only direct children in the right namespace contribute", () => {
    const query = parseDocument(`<query xmlns="${INFO}" xml:lang="pl">
      ${SIMPLE_IDENTITY}<feature var="urn:example:real"/>
      <identity xmlns="urn:foreign" category="spoof" type="spoof"/>
      <feature xmlns="urn:foreign" var="urn:spoof"/>
      <x xmlns="urn:foreign"><field var="FORM_TYPE" type="hidden"><value>spoof</value></field></x>
      <wrapper xmlns="urn:foreign"><feature xmlns="${INFO}" var="urn:nested"/><x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>nested</value></field></x></wrapper>
      <x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>real</value></field><field xmlns="urn:foreign" var="foreign"><value>ignored</value></field><field var="field" type="list-single"><value>accepted</value><value xmlns="urn:foreign">ignored</value><option><value>not-a-direct-value</value></option></field></x>
    </query>`) as Element;
    expect(canonicalize(query)).toBe(
      "client/pc//Exodus 0.9.1<urn:example:real<real<field<accepted<",
    );
  });

  test.each([
    '<x xmlns="jabber:x:data" type="result"><field var="other"><value>ignored</value></field></x>',
    '<x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE"><value>ignored</value></field></x>',
    '<x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE" type="text-single"><value>ignored</value></field></x>',
    '<x xmlns="jabber:x:data" type="result"><field xmlns="urn:foreign" var="FORM_TYPE" type="hidden"><value>ignored</value></field></x>',
  ])(
    "§5.4: ignore a form without a hidden FORM_TYPE and continue",
    (ignored) => {
      const query = parseDocument(
        `<query xmlns="${INFO}">${SIMPLE_IDENTITY}${ignored}<feature var="urn:example:retained"/></query>`,
      ) as Element;
      expect(canonicalize(query)).toBe(
        "client/pc//Exodus 0.9.1<urn:example:retained<",
      );
    },
  );

  test("§5.4: equal repeated FORM_TYPE values identify one form", () => {
    const query = parseDocument(`<query xmlns="${INFO}">${SIMPLE_IDENTITY}
      <x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:form</value><value>urn:example:form</value></field><field var="list" type="text-multi"><value>same</value><value>same</value></field></x>
    </query>`) as Element;
    expect(canonicalize(query)).toBe(
      "client/pc//Exodus 0.9.1<urn:example:form<list<same<same<",
    );
  });

  test.each([
    ["identical identities", SIMPLE_IDENTITY.repeat(2)],
    [
      "absent and empty optional identity components",
      '<identity category="client" type="pc"/><identity category="client" type="pc" xml:lang="" name=""/>',
    ],
    [
      "identical features",
      `${SIMPLE_IDENTITY}<feature var="urn:example:duplicate"/><feature var="urn:example:duplicate"/>`,
    ],
    [
      "same FORM_TYPE in two forms",
      `${SIMPLE_IDENTITY}<x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>same</value></field></x><x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>same</value></field></x>`,
    ],
    [
      "different FORM_TYPE values",
      `${SIMPLE_IDENTITY}<x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>one</value><value>two</value></field></x>`,
    ],
  ])(
    "§5.4: reject the entire ill-formed response / %s",
    async (_name, content) => {
      const query = parseDocument(
        `<query xmlns="${INFO}">${content}</query>`,
      ) as Element;
      expect(() => canonicalize(query)).toThrow();
      await expect(verificationString(query)).rejects.toThrow();
    },
  );

  test.each([
    ["missing identity category", '<identity type="pc"/>'],
    ["missing identity type", '<identity category="client"/>'],
    ["empty identity category", '<identity category="" type="pc"/>'],
    ["empty identity type", '<identity category="client" type=""/>'],
    ["missing feature var", `${SIMPLE_IDENTITY}<feature/>`],
    ["empty feature var", `${SIMPLE_IDENTITY}<feature var=""/>`],
    [
      "feature child",
      `${SIMPLE_IDENTITY}<feature var="urn:example:feature"><hidden/></feature>`,
    ],
    [
      "feature character data",
      `${SIMPLE_IDENTITY}<feature var="urn:example:feature">hidden</feature>`,
    ],
    [
      "nested FORM_TYPE value",
      `${SIMPLE_IDENTITY}<x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>before<hidden/>after</value></field></x>`,
    ],
    [
      "nested field value",
      `${SIMPLE_IDENTITY}<x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>form</value></field><field var="value"><value>before<hidden/>after</value></field></x>`,
    ],
    ["no identity", '<feature var="urn:example:feature"/>'],
    [
      "conflicting identity names",
      '<identity category="client" type="pc" name="One"/><identity category="client" type="pc" name="Two"/>',
    ],
    [
      "duplicate FORM_TYPE fields",
      `${SIMPLE_IDENTITY}<x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>form</value></field><field var="FORM_TYPE" type="hidden"><value>form</value></field></x>`,
    ],
    [
      "FORM_TYPE without a value",
      `${SIMPLE_IDENTITY}<x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"/></x>`,
    ],
    [
      "duplicate ordinary field vars",
      `${SIMPLE_IDENTITY}<x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>form</value></field><field var="data"><value>one</value></field><field var="data"><value>two</value></field></x>`,
    ],
  ])(
    "§5.1 / XEP-0030 §3.1 / XEP-0004 §3.2: reject malformed input / %s",
    async (_name, content) => {
      const query = parseDocument(
        `<query xmlns="${INFO}">${content}</query>`,
      ) as Element;
      expect(() => canonicalize(query)).toThrow();
      await expect(verificationString(query)).rejects.toThrow();
    },
  );

  test.each([
    `<items xmlns="${INFO}">${SIMPLE_IDENTITY}</items>`,
    '<query xmlns="urn:foreign"><identity category="client" type="pc"/></query>',
  ])("§5.1: reject a non-disco-info query", async (source) => {
    const query = parseDocument(source);
    expect(() => canonicalize(query)).toThrow("discovery information query");
    await expect(verificationString(query)).rejects.toThrow(
      "discovery information query",
    );
  });

  test("§5.4: ignore malformed contents of an excluded form", () => {
    const query = parseDocument(`<query xmlns="${INFO}">${SIMPLE_IDENTITY}
      <x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="text-single"><value>one<invalid/></value><value>two</value></field><field><value>ignored</value></field></x>
    </query>`);
    expect(canonicalize(query)).toBe("client/pc//Exodus 0.9.1<");
  });

  test("§5.1 / XEP-0128 §2: a non-result form is not forbidden by the SHOULD", () => {
    const query = parseDocument(`<query xmlns="${INFO}">${SIMPLE_IDENTITY}
      <x xmlns="${DATA}" type="form"><field var="FORM_TYPE" type="hidden"><value>form</value></field><field var="empty"/></x>
    </query>`);
    expect(canonicalize(query)).toBe("client/pc//Exodus 0.9.1<form<empty<");
  });

  test("local verification boundary: anonymous fixed fields remain unverified", async () => {
    // XEP-0004 §3.2 permits this; XEP-0115 §5.1 defines no absent-var hash.
    const query = parseDocument(`<query xmlns="${INFO}">${SIMPLE_IDENTITY}
      <x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>form</value></field><field type="fixed"><value>Heading</value></field></x>
    </query>`);
    const before = query.toString();
    expect(() => canonicalize(query)).toThrow("Cannot verify");
    await expect(verificationString(query)).rejects.toThrow("Cannot verify");
    expect(query.toString()).toBe(before);
  });

  test.each([
    [
      '<field var="heading" type="fixed"><value>Heading</value></field>',
      "heading<Heading<",
    ],
    ['<field var=""><value>Empty key</value></field>', "<Empty key<"],
    ['<field var="data"/>', "data<"],
    ['<field var="data"><value/></field>', "data<<"],
  ])(
    "§5.1: named, empty and valueless fields remain distinct",
    (field, expected) => {
      const query = parseDocument(`<query xmlns="${INFO}">${SIMPLE_IDENTITY}
      <x xmlns="${DATA}" type="result"><field var="FORM_TYPE" type="hidden"><value>form</value></field>${field}</x>
    </query>`);
      expect(canonicalize(query)).toBe(
        `client/pc//Exodus 0.9.1<form<${expected}`,
      );
    },
  );

  test.each(["SHA-1", "sha-512", "toString", "__proto__"])(
    "local algorithm boundary: unsupported name %s cannot select a digest",
    async (algorithm) => {
      const query = parseDocument(SIMPLE_XML);
      // Exercise untyped callers without broadening the supported TS union.
      // @ts-expect-error Invalid identifiers must also be rejected at runtime.
      await expect(verificationString(query, algorithm)).rejects.toThrow(
        "Unsupported capability hash algorithm",
      );
    },
  );
});
