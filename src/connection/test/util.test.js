import { expect, test } from "bun:test";

import { parseRedirectTarget } from "../lib/util.js";

test.each([
  ["example.test", "example.test", "example.test", ""],
  ["example.test:80", "example.test", "example.test", "80"],
  ["[2001:db8::1]", "[2001:db8::1]", "[2001:db8::1]", ""],
  ["[2001:db8::1]:80", "[2001:db8::1]", "[2001:db8::1]", "80"],
])("parses see-other-host target %s", (value, domain, hostname, port) => {
  expect(parseRedirectTarget(value)).toEqual({ domain, hostname, port });
});
