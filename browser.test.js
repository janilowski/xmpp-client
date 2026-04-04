import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { jid } from "./src/client/index.js";
import debug from "./src/debug/index.js";
import server from "./server/index.js";

const username = "client";
const password = "foobar";
const credentials = { username, password };
const domain = "localhost";
const JID = jid(username, domain).toString();
const service = "ws://localhost:5280/xmpp-websocket";

const xmppclient = readFileSync("./dist/xmpp-client", {
  encoding: "utf8",
});

let window;
let xmpp;

beforeEach(async () => {
  ({ window } = new JSDOM(``, { runScripts: "dangerously" }));
  const { document } = window;
  const scriptEl = document.createElement("script");
  scriptEl.textContent = xmppclient;
  document.body.append(scriptEl);
  await server.restart();
});

afterEach(async () => {
  await xmpp?.stop();
});

test("client ws://", async () => {
  xmpp = window.XMPP.client({
    credentials,
    service,
  });
  debug(xmpp);

  const address = await xmpp.start();
  expect(address.bare().toString()).toBe(JID);
});
