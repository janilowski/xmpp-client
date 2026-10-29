import { expect, test } from "bun:test";
import type {
  DiscoOptions,
  Element,
  IQCaller,
  IQContext,
  IQHandler,
} from "../../types/index.js";
import xml from "../xml/index.js";
import disco from "./index.ts";
import { discoState } from "./state.ts";

const INFO = "http://jabber.org/protocol/disco#info";
const ITEMS = "http://jabber.org/protocol/disco#items";
const INSTALLED = "urn:test:installed";
const CAPS = "http://jabber.org/protocol/caps";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const MANAGED_NODE = "urn:test:protocol#version";
const IDENTITY = { category: "client", type: "web", name: "Example" };

// Unit scope: no requester or protocol transport is exercised by this bridge.
function registry(options: DiscoOptions = { identities: [IDENTITY] }) {
  const handlers = new Map<string, IQHandler>();
  const instance = disco(
    {
      iqCaller: {} as IQCaller,
      iqCallee: {
        get(namespace, _name, handler) {
          handlers.set(namespace, handler);
        },
        set() {},
      },
      features: [INSTALLED],
    },
    options,
  );
  const state = discoState.get(instance);
  expect(state).toBeDefined();
  return {
    instance,
    state: state!,
    respond(namespace = INFO, node?: string) {
      const handler = handlers.get(namespace);
      expect(handler).toBeDefined();
      const element = xml("query", { xmlns: namespace, node });
      const stanza = xml(
        "iq",
        { type: "get", from: "peer@example.test/r" },
        element,
      );
      return handler!(
        { element, stanza } as IQContext,
        async () => undefined,
      ) as Element;
    },
  };
}

test("disco bridge snapshots root information without authorization or mutable aliases", () => {
  let authorizations = 0;
  const { state } = registry({
    identities: [IDENTITY],
    features: ["urn:test:custom"],
    authorize() {
      authorizations++;
      return false;
    },
  });
  const expected = `<query xmlns="${INFO}"><identity category="client" type="web" name="Example"/><feature var="${INFO}"/><feature var="${ITEMS}"/><feature var="${INSTALLED}"/><feature var="urn:test:custom"/></query>`;
  const first = state.snapshot();
  expect(first.toString()).toBe(expected);
  first.getChild("identity", INFO)!.attrs.name = "Changed";
  first.children.length = 0;
  expect(state.snapshot().toString()).toBe(expected);
  expect(authorizations).toBe(0);
});

test("disco bridge notifies only root information payload changes", () => {
  const { instance, state } = registry();
  const snapshots: string[] = [];
  state.onChange(() => snapshots.push(state.snapshot().toString()));
  instance.addFeature(INSTALLED);
  instance.addFeature(INFO);
  instance.setIdentities([IDENTITY, IDENTITY]);
  instance.removeFeature("urn:test:absent");
  expect(snapshots).toEqual([]);

  instance.addFeature("urn:test:added");
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toContain('<feature var="urn:test:added"/>');
  instance.addFeature("urn:test:added");
  expect(snapshots).toHaveLength(1);
  instance.removeFeature("urn:test:added");
  expect(snapshots).toHaveLength(2);
  instance.setIdentities([{ ...IDENTITY, name: "Updated" }]);
  expect(snapshots).toHaveLength(3);
  expect(snapshots[2]).toContain('name="Updated"');
});

test("disco node and item changes neither alter root snapshots nor notify", () => {
  const { instance, state } = registry();
  const before = state.snapshot().toString();
  let changes = 0;
  state.onChange(() => {
    changes++;
  });
  instance.setItems([{ jid: "peer@example.test" }]);
  instance.setNode("node", {
    identities: [IDENTITY],
    features: ["urn:test:node"],
  });
  instance.setIdentities([{ ...IDENTITY, name: "Node" }], "node");
  instance.addFeature("urn:test:other", "node");
  instance.removeFeature("urn:test:other", "node");
  instance.setItems([{ jid: "peer@example.test/r" }], "node");
  instance.removeNode("node");
  expect(changes).toBe(0);
  expect(state.snapshot().toString()).toBe(before);
});

test("rejected root changes do not notify or replace the snapshot", () => {
  const { instance, state } = registry();
  const before = state.snapshot().toString();
  let changes = 0;
  state.onChange(() => {
    changes++;
  });
  expect(() =>
    instance.setIdentities([{ ...IDENTITY, lang: "en_US" }]),
  ).toThrow();
  expect(() => instance.setIdentities([])).toThrow();
  expect(() => instance.addFeature("")).toThrow();
  expect(() => instance.removeFeature(INSTALLED)).toThrow();
  expect(changes).toBe(0);
  expect(state.snapshot().toString()).toBe(before);
});

test("disco bridge unsubscribe removes only its observer", () => {
  const { instance, state } = registry();
  let first = 0;
  let second = 0;
  const remove = state.onChange(() => {
    first++;
  });
  state.onChange(() => {
    second++;
  });
  instance.addFeature("urn:test:first");
  remove();
  remove();
  instance.addFeature("urn:test:second");
  expect(first).toBe(1);
  expect(second).toBe(2);
});

test("disco protocol ownership uses private feature and node registration", () => {
  const { state } = registry();
  expect(state).toHaveProperty("installFeature", expect.any(Function));
  expect(state).toHaveProperty("setNode", expect.any(Function));
  expect(state).toHaveProperty("removeNode", expect.any(Function));
});

test("private feature installation protects root advertisement and notifies only changed payload", () => {
  const { instance, state } = registry();
  let changes = 0;
  state.onChange(() => {
    changes++;
  });
  state.installFeature(CAPS);
  expect(changes).toBe(1);
  expect(
    state
      .snapshot()
      .getChildren("feature", INFO)
      .filter((element) => element.attrs.var === CAPS),
  ).toHaveLength(1);
  state.installFeature(CAPS);
  state.installFeature(INSTALLED);
  expect(changes).toBe(1);
  expect(() => instance.removeFeature(CAPS)).toThrow(TypeError);
  instance.addFeature(CAPS);
  expect(changes).toBe(1);
  expect(() => state.installFeature("")).toThrow(TypeError);
  expect(() => state.installFeature("invalid\u0000feature")).toThrow();
  expect(changes).toBe(1);
  expect(
    state
      .snapshot()
      .getChildren("feature", INFO)
      .filter((element) => element.attrs.var === CAPS),
  ).toHaveLength(1);
});

test("public mutators cannot alter protocol-owned node snapshots", () => {
  const { instance, state, respond } = registry();
  state.setNode(MANAGED_NODE, {
    identities: [IDENTITY],
    features: [CAPS],
    items: [{ jid: "peer@example.test" }],
  });
  const before = respond(INFO, MANAGED_NODE).toString();
  for (const mutate of [
    () =>
      instance.setNode(MANAGED_NODE, {
        identities: [{ ...IDENTITY, name: "Changed" }],
      }),
    () => instance.removeNode(MANAGED_NODE),
    () =>
      instance.setIdentities([{ ...IDENTITY, name: "Changed" }], MANAGED_NODE),
    () => instance.addFeature("urn:test:changed", MANAGED_NODE),
    () => instance.removeFeature(CAPS, MANAGED_NODE),
    () => instance.setItems([], MANAGED_NODE),
  ]) {
    expect(mutate).toThrow(TypeError);
    expect(respond(INFO, MANAGED_NODE).toString()).toBe(before);
  }
  expect(
    respond(ITEMS, MANAGED_NODE)
      .getChildren("item", ITEMS)
      .map((element) => element.attrs.jid),
  ).toEqual(["peer@example.test"]);
});

test("private node registration copies inputs and rejected replacement is atomic", () => {
  const { state, respond } = registry();
  const identity = { ...IDENTITY };
  const feature = "urn:test:original";
  const value = {
    identities: [identity],
    features: [feature],
    items: [{ jid: "peer@example.test", name: "Original" }],
  };
  state.setNode(MANAGED_NODE, value);
  const before = respond(INFO, MANAGED_NODE).toString();
  const items = respond(ITEMS, MANAGED_NODE).toString();
  identity.name = "Changed";
  value.features[0] = "urn:test:changed";
  value.items[0].name = "Changed";
  expect(respond(INFO, MANAGED_NODE).toString()).toBe(before);
  expect(respond(ITEMS, MANAGED_NODE).toString()).toBe(items);
  expect(() =>
    state.setNode(MANAGED_NODE, {
      identities: [{ ...IDENTITY, lang: "en_US" }],
    }),
  ).toThrow(TypeError);
  expect(respond(INFO, MANAGED_NODE).toString()).toBe(before);
  state.setNode(MANAGED_NODE, {
    identities: [{ ...IDENTITY, name: "Updated" }],
  });
  expect(
    respond(INFO, MANAGED_NODE).getChild("identity", INFO)?.attrs.name,
  ).toBe("Updated");
});

test("private nodes preserve authorization without exposing known-node metadata", () => {
  const seen: string[] = [];
  const { state, respond } = registry({
    identities: [IDENTITY],
    authorize(request) {
      seen.push(`${request.type}:${request.node}`);
      return false;
    },
  });
  state.setNode(MANAGED_NODE, {
    identities: [IDENTITY],
    features: ["urn:test:secret"],
    items: [{ jid: "secret@example.test" }],
  });
  for (const namespace of [INFO, ITEMS]) {
    const known = respond(namespace, MANAGED_NODE);
    const missing = respond(namespace, "unknown");
    expect(known.toString()).toBe(missing.toString());
    expect(known.getChild("service-unavailable", STANZAS)).toBeDefined();
    expect(known.getChildElements()).toHaveLength(1);
    expect(known.toString()).not.toContain("secret");
  }
  expect(seen).toEqual([
    `info:${MANAGED_NODE}`,
    "info:unknown",
    `items:${MANAGED_NODE}`,
    "items:unknown",
  ]);
});

test("private registration rejects public-node collisions and removal releases only owned nodes", () => {
  const { instance, state, respond } = registry();
  instance.setNode("manual", { identities: [{ ...IDENTITY, name: "Manual" }] });
  const manual = respond(INFO, "manual").toString();
  expect(() => state.setNode("manual", { identities: [IDENTITY] })).toThrow(
    TypeError,
  );
  state.removeNode("manual");
  expect(respond(INFO, "manual").toString()).toBe(manual);
  state.setNode(MANAGED_NODE, { identities: [IDENTITY] });
  state.removeNode(MANAGED_NODE);
  expect(
    respond(INFO, MANAGED_NODE).getChild("item-not-found", STANZAS),
  ).toBeDefined();
  instance.setNode(MANAGED_NODE, {
    identities: [{ ...IDENTITY, name: "Now public" }],
  });
  expect(
    respond(INFO, MANAGED_NODE).getChild("identity", INFO)?.attrs.name,
  ).toBe("Now public");
  expect(() => state.setNode(MANAGED_NODE, { identities: [IDENTITY] })).toThrow(
    TypeError,
  );
  instance.removeNode(MANAGED_NODE);
  state.setNode(MANAGED_NODE, { identities: [IDENTITY] });
  expect(
    respond(INFO, MANAGED_NODE).getChild("identity", INFO)?.attrs.name,
  ).toBe(IDENTITY.name);
});

test("protocol-owned nodes neither notify root changes nor become root items", () => {
  const { state, respond } = registry();
  const before = state.snapshot().toString();
  let changes = 0;
  state.onChange(() => {
    changes++;
  });
  state.setNode(MANAGED_NODE, { identities: [IDENTITY], features: [CAPS] });
  expect(respond(ITEMS).getChildren("item", ITEMS)).toEqual([]);
  expect(state.snapshot().toString()).toBe(before);
  state.removeNode(MANAGED_NODE);
  expect(changes).toBe(0);
  expect(() => state.setNode("", { identities: [IDENTITY] })).toThrow(
    TypeError,
  );
  expect(() => state.removeNode("")).toThrow(TypeError);
});
