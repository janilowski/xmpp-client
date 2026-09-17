import { afterEach, expect, test } from "bun:test";

import { client, jid } from "../src/client/index.js";
import debug from "../src/debug/index.js";
import server from "../server/index.js";

const NS_SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const NS_BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const NS_SASL2 = "urn:xmpp:sasl:2";
const NS_BIND2 = "urn:xmpp:bind:0";
const NS_FAST = "urn:xmpp:fast:0";

const username = "client";
const password = "foobar";
const credentials = { username, password };
const domain = "localhost";
const service = "ws://localhost:5280/xmpp-websocket";
const JID = jid(username, domain).toString();

let xmpp;

afterEach(async () => {
  await xmpp?.stop();
  await server.reset();
});

test("client online with sasl and resource binding", async () => {
  expect.assertions(7);

  await server.disableModules([
    "sasl2",
    "sasl2_bind2",
    "sasl2_sm",
    "sasl2_fast",
  ]);
  await server.enableModules(["saslauth"]);
  await server.restart();

  xmpp = client({ credentials, service });
  debug(xmpp);

  const features = [];
  const sent = [];

  xmpp.on("nonza", (element) => {
    if (!element.is("features")) return;

    const authentication = element.getChild("authentication", NS_SASL2);
    const mechanisms = element.getChild("mechanisms", NS_SASL);
    if (!authentication && !mechanisms) return;

    features.push({ authentication, mechanisms });
  });

  xmpp.on("send", (el) => {
    sent.push(el);
  });

  const address = await xmpp.start();
  expect(features.map(({ authentication }) => authentication)).toEqual([
    undefined,
  ]);
  expect(features[0]?.mechanisms).toBeDefined();
  expect(sent.some((el) => el.is("auth", NS_SASL))).toBe(true);
  expect(sent.find((el) => el.is("auth", NS_SASL))?.attrs.mechanism).toMatch(
    /^SCRAM-SHA-(1|256)$/,
  );
  expect(sent.some((el) => el.is("iq") && el.getChild("bind", NS_BIND))).toBe(
    true,
  );
  expect(address instanceof jid.JID).toBe(true);
  expect(address.bare().toString()).toBe(JID);
});

test("client online with sasl2 and bind2", async () => {
  expect.assertions(7);

  await server.disableModules(["saslauth"]);
  await server.enableModules(["sasl2", "sasl2_bind2"]);
  await server.restart();

  xmpp = client({ credentials, service });
  debug(xmpp);

  const features = [];
  const sent = [];

  xmpp.on("nonza", (element) => {
    if (!element.is("features")) return;

    const mechanisms = element.getChild("mechanisms", NS_SASL);
    const authentication = element.getChild("authentication", NS_SASL2);
    if (!mechanisms && !authentication) return;

    features.push({ authentication, mechanisms });
  });

  xmpp.on("send", (el) => {
    if (el.is("authenticate", NS_SASL2)) {
      sent.push(el);
    }
  });

  const address = await xmpp.start();
  expect(features.map(({ mechanisms }) => mechanisms)).toEqual([undefined]);
  expect(features[0]?.authentication).toBeDefined();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.attrs.mechanism).toMatch(/^SCRAM-SHA-(1|256)$/);
  expect(sent[0]?.getChild("bind", NS_BIND2)).toBeDefined();
  expect(address instanceof jid.JID).toBe(true);
  expect(address.bare().toString()).toBe(JID);
});

test("client online with sasl2 and fast", async () => {
  expect.assertions(3);

  await server.disableModules(["saslauth"]);
  await server.enableModules([
    "sasl2",
    "sasl2_bind2",
    "sasl2_sm",
    "sasl2_fast",
  ]);
  await server.restart();

  xmpp = client({
    ...credentials,
    service,
  });

  // Get token
  await xmpp.start();
  await xmpp.stop();

  debug(xmpp);

  const features = [];
  const sent = [];

  xmpp.on("nonza", (element) => {
    if (!element.is("features")) return;

    const authentication = element.getChild("authentication", NS_SASL2);
    if (!authentication) return;
    const inline = authentication.getChild("inline");
    features.push(inline?.getChild("fast", NS_FAST));
  });

  xmpp.on("send", (el) => {
    const authenticate = el.is("authenticate", NS_SASL2);
    if (!authenticate) return;

    sent.push(el);
  });

  await xmpp.start();
  expect(features[0]).toBeDefined();
  expect(sent.map((el) => el.attrs.mechanism)).toEqual(["HT-SHA-256-NONE"]);
  expect(sent[0]?.getChild("fast", NS_FAST)).toBeDefined();
});
