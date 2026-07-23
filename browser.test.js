import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { jid } from "./src/client/index.js";
import debug from "./src/debug/index.js";
import server from "./server/index.js";

const username = "client";
const password = "foobar";
const credentials = { username, password };
const domain = "localhost";
const JID = jid(username, domain).toString();
const service = "ws://localhost:5280/xmpp-websocket";

const xmppClientBundle = readFileSync("./dist/xmpp.js", {
  encoding: "utf8",
});

let xmpp;

beforeEach(async () => {
  await server.restart();
});

afterEach(async () => {
  await xmpp?.stop();
});

test("client ws://", async () => {
  // Evaluate the classic browser bundle as a script. If it contains an
  // unresolved import or expects a Node-specific module global, this fails
  // before the connection is attempted.
  const XMPP = Function(`${xmppClientBundle}; return XMPP;`)();

  xmpp = XMPP.client({
    credentials,
    service,
  });
  debug(xmpp);

  const address = await xmpp.start();
  expect(address.bare().toString()).toBe(JID);
});
