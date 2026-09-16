import { describe, expect, test } from "bun:test";
import jid, { JID, escapeLocal } from "../src/jid/index.js";

// RFC 7622 §§3–4, verified errata 4534/4560, RFC 9844 §3.
describe("RFC 7622 address structure and comparison", () => {
  for (const value of [
    "juliet@example.com",
    "juliet@example.com/foo",
    "juliet@example.com/foo bar",
    "juliet@example.com/foo@bar",
    String.raw`foo\20bar@example.com`,
    "fussball@example.com",
    "fußball@example.com",
    "π@example.com",
    "king@example.com/♚",
    "example.com",
    "example.com/foobar",
    "a.example.com/b@example.net",
    "juliet@example.com/ foo ",
    "juliet@example.com/foo/bar",
    "juliet@example.com/ ",
  ]) {
    test(`accepts ${JSON.stringify(value)}`, () => {
      expect(jid(value).toString()).toBe(value);
      expect(jid(jid(value).toString()).equals(jid(value))).toBe(true);
    });
  }

  for (const value of [
    '"juliet"@example.com',
    "foo bar@example.com",
    "@example.com/",
    "@example.com",
    "example.com/",
    "henryⅣ@example.com",
    "♚@example.com",
    "juliet@",
    "/foobar",
    "",
    "a@b@example.com",
    "a\u0000@example.com",
  ]) {
    test(`rejects malformed wire JID ${JSON.stringify(value)}`, () => {
      expect(() => jid(value)).toThrow(TypeError);
    });
  }

  test("normalizes equivalent identities without collapsing distinct ones", () => {
    expect(jid("É@EXAMPLE.COM/Re\u0301s").toString()).toBe("é@example.com/Rés");
    expect(jid("e\u0301@example.com").equals(jid("é@example.com"))).toBe(true);
    expect(jid("Σ@example.com").equals(jid("σ@example.com"))).toBe(true);
    expect(jid("ς@example.com").equals(jid("σ@example.com"))).toBe(false);
    expect(jid("fußball@example.com").equals(jid("fussball@example.com"))).toBe(
      false,
    );
    expect(jid("a@example.com/R").equals(jid("a@example.com/r"))).toBe(false);
  });

  test("keeps explicit escaping separate from parsing", () => {
    expect(jid(`${escapeLocal("a b")}@example.com`).local).toBe(
      String.raw`a\20b`,
    );
    expect(jid("a b", "example.com").local).toBe(String.raw`a\20b`);
    expect(() => jid("a b@example.com")).toThrow(TypeError);
    // Width mapping must not create an escaped, different identity.
    expect(() => jid("a＠b@example.com")).toThrow(TypeError);
    expect(() => jid("a／b@example.com")).toThrow(TypeError);
  });

  test("enforces post-preparation UTF-8 limits", () => {
    expect(jid(`${"a".repeat(1023)}@example.com`).local.length).toBe(1023);
    expect(() => jid(`${"a".repeat(1024)}@example.com`)).toThrow(TypeError);
    expect(jid(`${"e\u0301".repeat(511)}a@example.com`).local).toBe(
      `${"é".repeat(511)}a`,
    );
    expect(() => jid(`${"é".repeat(512)}@example.com`)).toThrow(TypeError);
    expect(jid(`example.com/${"😀".repeat(255)}abc`).resource.length).toBe(513);
    expect(() => jid(`example.com/${"😀".repeat(256)}`)).toThrow(TypeError);
    expect(jid(`example.com/${"a".repeat(1023)}`).resource.length).toBe(1023);
    expect(() => jid(`example.com/${"a".repeat(1024)}`)).toThrow(TypeError);
    const domain = `[v1.${"a".repeat(1018)}]`;
    const longest = `${"a".repeat(1023)}@${domain}/${"a".repeat(1023)}`;
    expect(new TextEncoder().encode(jid(longest).toString()).length).toBe(3071);
    expect(() => jid(`[v1.${"a".repeat(1019)}]`)).toThrow(TypeError);
  });

  test("setters validate atomically and preserve prepared values", () => {
    const address = new JID("a", "example.com", "R");
    address.local = "E\u0301";
    address.resource = "Re\u0301s";
    expect(address.toString()).toBe("é@example.com/Rés");
    expect(() => address.setDomain("")).toThrow(TypeError);
    expect(() => address.setResource("\u0000")).toThrow(TypeError);
    expect(address.toString()).toBe("é@example.com/Rés");
    expect(address.bare().toString()).toBe("é@example.com");
  });
});

// RFC 8265 UsernameCaseMapped / OpaqueString and RFC 5892 Appendix A.
describe("RFC 7622 PRECIS profiles", () => {
  test("applies profile mappings before contextual and repertoire checks", () => {
    for (const [input, output] of [
      ["L·L", "l·l"],
      ["Å", "å"],
      ["\u1100\u1161", "가"],
    ]) {
      expect(() => jid(`${input}@example.com`)).not.toThrow();
      expect(jid(`${input}@example.com`).local).toBe(output);
    }
    expect(() => jid("example.com/\u1100\u1161")).not.toThrow();
    expect(jid("example.com/\u1100\u1161").resource).toBe("가");
  });
  for (const [input, output] of [
    ["ＦＯＯ", "foo"],
    ["ｶﾞ", "ガ"],
    ["İ", "i\u0307"],
    ["l·l", "l·l"],
    ["͵α", "͵α"],
    ["א׳", "א׳"],
    ["カ・a", "カ・a"],
    ["क्\u200dष", "क्\u200dष"],
    ["क्\u200cष", "क्\u200cष"],
    ["ب\u200cب", "ب\u200cب"],
    ["بَ\u200cَب", "بَ\u200cَب"],
    ["אב1", "אב1"],
  ]) {
    test(`prepares localpart ${JSON.stringify(input)}`, () => {
      expect(jid(`${input}@example.com`).local).toBe(output);
      expect(jid(`${output}@example.com`).local).toBe(output);
    });
  }
  for (const input of [
    "＂",
    "＆",
    "＇",
    "／",
    "：",
    "＜",
    "＞",
    "＠",
    "a·b",
    "͵a",
    "׳א",
    "a・b",
    "a\u200cb",
    "a\u200db",
    "אבa",
    "aאב",
    "אב1١",
    "אב-",
    "١۲",
    "Ⅳ",
    "ﬀ",
    "😀",
    "\u00ad",
    "\u034f",
    "\u200b",
    "\u202e",
    "\ue000",
    "\ufdd0",
    "\ud800",
    "\udc00",
    "\u0378",
    "\u1100",
    "a\t",
    "\u0640",
  ]) {
    test(`rejects localpart ${JSON.stringify(input)}`, () => {
      expect(() => jid(`${input}@example.com`)).toThrow(TypeError);
    });
  }
  for (const [input, output] of [
    ["Ｒ", "Ｒ"],
    ["Ⅳ", "Ⅳ"],
    ["ﬀ", "ﬀ"],
    ["😀", "😀"],
    ["A\u00a0B", "A B"],
    ["\u2003x\u3000", " x "],
    ["aאב", "aאב"],
    ["a@b/c", "a@b/c"],
  ]) {
    test(`prepares opaque resource ${JSON.stringify(input)}`, () => {
      expect(jid(`example.com/${input}`).resource).toBe(output);
      expect(jid(`example.com/${output}`).resource).toBe(output);
    });
  }
  for (const input of [
    "\u0000",
    "\t",
    "\u007f",
    "\u0085",
    "\u00ad",
    "\ue000",
    "\ud800",
    "\u0378",
    "a\u200db",
    "a·b",
  ]) {
    test(`rejects resource ${JSON.stringify(input)}`, () => {
      expect(() => jid(`example.com/${input}`)).toThrow(TypeError);
    });
  }
});

describe("RFC 7622 IDNA2008 domains", () => {
  for (const [input, output] of [
    ["EXAMPLE.COM.", "example.com"],
    ["XN--BCHER-KVA.example", "bücher.example"],
    ["BU\u0308CHER.example", "bücher.example"],
    ["ＥＸＡＭＰＬＥ。com", "example.com"],
    ["faß.de", "faß.de"],
    ["xn--fa-hia.de", "faß.de"],
    ["l·l.cat", "l·l.cat"],
    ["͵α.example", "͵α.example"],
    ["カ・a.example", "カ・a.example"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["[2001:db8::1]", "[2001:db8::1]"],
    ["[2001:0DB8:0:0:0:0:0:1]", "[2001:db8::1]"],
    ["[v1.example:address]", "[v1.example:address]"],
  ]) {
    test(`prepares domain ${JSON.stringify(input)}`, () => {
      expect(jid(input).domain).toBe(output);
      expect(jid(input).equals(jid(output))).toBe(true);
    });
  }
  for (const input of [
    "a..b",
    ".example",
    "example..",
    "-a.example",
    "a-.example",
    "ab--cd.example",
    "_xmpp.example",
    "a%20b.example",
    "a b.example",
    "example.com:80",
    "https://example.com",
    "[::gg]",
    "::1",
    "[::1%25eth0]",
    "xn--.example",
    "xn--abc-.example",
    "😀.example",
    "a·b.example",
    "\u0301a.example",
    "\ud800.example",
    "\u0378.example",
    "a\u200db.example",
    "אבa.example",
    "אב1١.example",
    "١۲.example",
    "\u00ad.example",
    "𜳰.example",
    "[v1.]",
    "[v1.a%25zone]",
    "[::1]:80",
    "[::1]/",
    "a".repeat(64),
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
  ]) {
    test(`rejects domain ${JSON.stringify(input)}`, () => {
      expect(() => jid(input)).toThrow(TypeError);
    });
  }
  test("accepts the DNS length boundary", () => {
    const domain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(jid(domain).domain).toBe(domain);
    // RFC 5890 limits the encoded A-label, not the number of U-label characters.
    expect(jid(`${"é".repeat(57)}.example`).domain).toBe(
      `${"é".repeat(57)}.example`,
    );
    expect(() => jid(`${"é".repeat(58)}.example`)).toThrow(TypeError);
  });

  test("checks bidi across all labels of an RTL domain", () => {
    expect(() => jid("123.אב.example")).toThrow(TypeError);
    expect(jid("a123.אב.example").domain).toBe("a123.אב.example");
    expect(() => jid("אב-.example")).toThrow(TypeError);
    expect(jid("אב\u05b0.example").domain).toBe("אב\u05b0.example");
  });
});
