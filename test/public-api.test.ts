import { client, jid, xml } from "@janilowski/xmpp-client";
import type {
  AbortSignalLike,
  CapsResult,
  DiscoIdentity,
  DiscoInfo,
  DiscoItems,
  DiscoOptions,
} from "@janilowski/xmpp-client";
import xmlExport, { Element, createElement } from "@janilowski/xmpp-client/xml";
import { Fragment, jsx, jsxs } from "@janilowski/xmpp-client/xml/jsx-runtime";
import { jsxDEV } from "@janilowski/xmpp-client/xml/jsx-dev-runtime";

const address = jid("romeo@example.net/orchard");
const presence = xml("presence", { to: address.bare() });
const xmpp = client({
  service: "wss://example.net/xmpp-websocket",
  credentials: { username: "romeo", password: "secret" },
  streamManagement: { maxStanzas: 1024, maxBytes: 8 * 1024 * 1024 },
  disco: {
    identities: [
      { category: "client", type: "web", name: "Example", lang: "en" },
    ],
    features: ["urn:example:feature"],
    items: [{ jid: "rooms.example.net", node: "public", name: "Rooms" }],
    authorize: ({ type, from, to, node }) =>
      type === "info" || Boolean(from && to && node),
  },
  caps: { node: "https://example.net/client" },
});

xmpp.on("stanza", (stanza: typeof presence) => stanza.toString());
xmpp.on("capabilities", (result) => {
  const value: CapsResult = result;
  void [value.status, value.error?.message, value.info?.query.toString()];
});
const capabilities: CapsResult | undefined = xmpp.caps.get(address);
void capabilities?.info?.features;
void xmpp.caps.get("peer@example.net/device");
// @ts-expect-error Caps node is an application URI, not a boolean switch.
client({ caps: true });
if (capabilities) {
  // @ts-expect-error Verification status is not caller-owned mutable state.
  capabilities.status = "verified";
}
xmpp.once("capabilities", (result) => {
  const value: CapsResult = result;
  void value.status;
});
void xmpp.send(presence);
void xmpp.start().then((onlineAddress) => onlineAddress.bare().toString());

// Cancellation remains usable without DOM or Node global types.
const signal: AbortSignalLike = {
  aborted: false,
  reason: undefined,
  addEventListener: (_type, listener, options) => {
    void [listener, options?.once];
  },
  removeEventListener: (_type, listener) => {
    void listener;
  },
};
const identities = [{ category: "client", type: "bot" }] as const;
const features = ["urn:example:feature"] as const;
const items = [{ jid: "rooms.example.net", node: "public" }] as const;
const readonlyConfig: DiscoOptions = { identities, features, items };
client({ disco: readonlyConfig });

const info: Promise<DiscoInfo> = xmpp.disco.info(address, {
  node: "public",
  timeout: 1000,
  signal,
});
const discovered: Promise<DiscoItems> = xmpp.disco.items("example.net");
void xmpp.disco.info();
void xmpp.disco.items(undefined, { signal });
void info.then(({ identities, features, query, node }) => {
  const first: DiscoIdentity | undefined = identities[0];
  return [
    first?.lang,
    features.includes("urn:example:feature"),
    query.toString(),
    node,
  ];
});
void discovered.then(({ items, query }) => [items[0]?.jid, query.toString()]);
xmpp.disco.setIdentities(identities);
xmpp.disco.addFeature("urn:example:feature", "public");
xmpp.disco.removeFeature("urn:example:feature", "public");
xmpp.disco.setItems(items, "public");
xmpp.disco.setNode("public", readonlyConfig);
xmpp.disco.removeNode("public");

// Existing IQ helpers return an envelope or its optional matching child.
const query = xml("query", { xmlns: "urn:example:query" });
const envelope: Promise<Element> = xmpp.iqCaller.request(
  xml("iq", { type: "get" }, query),
  1000,
  signal,
);
const child: Promise<Element | undefined> = xmpp.iqCaller.get(
  query,
  address,
  1000,
  signal,
);
void xmpp.iqCaller.set(query, "example.net");
void [envelope, child];
xmpp.iqCallee.get("urn:example:query", "query", (context, next) => {
  const sender: string | undefined = context.from?.toString();
  const recipient: string | undefined = context.to?.toString();
  void [
    sender,
    recipient,
    context.entity,
    context.id,
    context.type,
    context.name,
  ];
  return context.element.is("query", "urn:example:query")
    ? context.element
    : next();
});
xmpp.iqCallee.set("urn:example:query", "query", async ({ stanza }) => {
  void stanza.attrs.id;
  return {};
});
xmpp.iqCallee.get("urn:example:empty", "query", () => true);

// Check every published entry point without suppressing declaration errors.
const element: Element = new Element("message");
const message: Element = xmlExport("message", {}, element);
const created: Element = createElement("presence", { to: address });
const jsxElement: Element = jsx("presence", { to: address });
const jsxElements: Element = jsxs("message", { children: "text" });
const developmentElement: Element = jsxDEV("presence", { to: address });
void [message, created, jsxElement, jsxElements, developmentElement, Fragment];

// @ts-expect-error Stanzas must be XML elements, not serialized strings.
void xmpp.send("<presence/>");
// @ts-expect-error Credentials require a string password.
client({ password: 123 });
// @ts-expect-error Service addresses must be strings.
client({ service: 123 });
// @ts-expect-error Queue budgets are numeric, not serialized configuration values.
client({ streamManagement: { maxBytes: "1024" } });
// @ts-expect-error Discovery configuration requires explicit identities.
client({ disco: { features: ["urn:example:feature"] } });
// @ts-expect-error Identity category and type are mandatory strings.
xmpp.disco.setIdentities([{ name: "Example" }]);
// @ts-expect-error Language identifiers are strings.
xmpp.disco.setIdentities([{ category: "client", type: "web", lang: 1 }]);
// @ts-expect-error Discovery authorization is synchronous.
const asyncAuthorization: DiscoOptions["authorize"] = async () => true;
void asyncAuthorization;
// @ts-expect-error Feature names are strings.
xmpp.disco.addFeature(123);
// @ts-expect-error Items require a JID string, not an arbitrary object.
xmpp.disco.setItems([{ jid: address }]);
// @ts-expect-error Discovery query destinations are addresses, not numbers.
void xmpp.disco.info(123);
// @ts-expect-error Discovery timeout is numeric.
void xmpp.disco.items(undefined, { timeout: "1000" });
void xmpp.disco.info(undefined, {
  // @ts-expect-error A cancellation signal must support listener removal.
  signal: { aborted: false, reason: undefined, addEventListener() {} },
});
// @ts-expect-error Discovery service identity is stable.
xmpp.disco = { ...xmpp.disco };
// @ts-expect-error IQ requests use XML elements, not strings.
void xmpp.iqCaller.request("<iq/>");
// @ts-expect-error A result IQ can omit the requested child.
const requiredChild: Promise<Element> = xmpp.iqCaller.get(query);
void requiredChild;
xmpp.iqCallee.get("urn:example:query", "query", (context) => {
  // @ts-expect-error Incoming IQ senders can be absent.
  return context.from.toString();
});
