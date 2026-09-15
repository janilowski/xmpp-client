import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test.each(["xmpp.js", "xmpp.min.js"])("classic bundle exports: %s", (file) => {
  const source = readFileSync(`dist/${file}`, "utf8");
  const exported = Function(`${source}\n; return XMPP;`)();
  expect(typeof exported?.client).toBe("function");
  expect(typeof exported?.xml).toBe("function");
  expect(typeof exported?.jid).toBe("function");
});
