import { describe, expect, test } from "bun:test";
import { readFrame } from "../xml.ts";
import {
  INFO,
  ITEMS,
  PING,
  CONTENT,
  STANZAS,
  FULL_JID,
  TARGET,
  NODE,
  IDENTITY,
  discovery,
  incoming,
  nextIq,
  session,
} from "./fixture.ts";

describe("XEP-0030 §§3–4/7 — responder and local registry", () => {
  test("§3.1: configured root replies with identity and core features once", async () => {
    await session(
      async (_xmpp, peer) => {
        const events = await incoming(peer, INFO);
        expect(events[0]).toEqual({
          open: `{${CONTENT}}iq`,
          attributes: {
            "{}type": "result",
            "{}id": "discovery",
            "{}from": FULL_JID,
            "{}to": TARGET,
          },
        });
        expect(events.slice(1)).toEqual([
          { open: `{${INFO}}query`, attributes: {} },
          {
            open: `{${INFO}}identity`,
            attributes: {
              "{}category": "client",
              "{}type": "web",
              "{}name": "Example",
            },
          },
          { close: `{${INFO}}identity` },
          ...[INFO, ITEMS, PING].flatMap((feature) => [
            { open: `{${INFO}}feature`, attributes: { "{}var": feature } },
            { close: `{${INFO}}feature` },
          ]),
          { close: `{${INFO}}query` },
          { close: `{${CONTENT}}iq` },
        ]);
      },
      { identities: [IDENTITY] },
    );
  });

  test.each([
    [INFO, "error"],
    [ITEMS, "result"],
  ] as const)(
    "local identity policy: unconfigured root %s is not a fabricated client",
    async (namespace, type) => {
      await session(async (_xmpp, peer) => {
        const events = await incoming(peer, namespace);
        expect(events[0]).toMatchObject({ attributes: { "{}type": type } });
        expect(
          events.some(
            (event) => "open" in event && event.open === `{${INFO}}identity`,
          ),
        ).toBe(false);
        if (namespace === INFO) {
          expect(events).toContainEqual({
            open: `{${STANZAS}}service-unavailable`,
            attributes: {},
          });
        } else {
          expect(events.slice(1)).toEqual([
            { open: `{${ITEMS}}query`, attributes: {} },
            { close: `{${ITEMS}}query` },
            { close: `{${CONTENT}}iq` },
          ]);
        }
      });
    },
  );

  test("§§3.1/4.1: local duplicates collapse without changing insertion order", async () => {
    await session(
      async (xmpp, peer) => {
        const api = discovery(xmpp);
        api.setIdentities([
          IDENTITY,
          IDENTITY,
          { category: "gateway", type: "custom", name: "Gateway" },
        ]);
        api.addFeature("urn:example:z");
        api.addFeature("urn:example:a");
        api.addFeature("urn:example:z");
        api.addFeature(INFO);
        // The approved registry API rejects removal of installed core support.
        expect(() => api.removeFeature(INFO)).toThrow(TypeError);
        const events = await incoming(peer, INFO);
        expect(
          events.filter(
            (event) => "open" in event && event.open === `{${INFO}}identity`,
          ),
        ).toEqual([
          {
            open: `{${INFO}}identity`,
            attributes: {
              "{}category": "client",
              "{}type": "web",
              "{}name": "Example",
            },
          },
          {
            open: `{${INFO}}identity`,
            attributes: {
              "{}category": "gateway",
              "{}type": "custom",
              "{}name": "Gateway",
            },
          },
        ]);
        expect(
          events.filter(
            (event) => "open" in event && event.open === `{${INFO}}feature`,
          ),
        ).toEqual(
          [INFO, ITEMS, PING, "urn:example:z", "urn:example:a"].map(
            (feature) => ({
              open: `{${INFO}}feature`,
              attributes: { "{}var": feature },
            }),
          ),
        );
        api.removeFeature("urn:example:z");
        expect(
          (await incoming(peer, INFO)).some(
            (event) =>
              "open" in event && event.attributes["{}var"] === "urn:example:z",
          ),
        ).toBe(false);
      },
      { identities: [IDENTITY] },
    );
  });

  test.each([INFO, ITEMS])(
    "§§3.1/4.1: nonempty incoming query %s receives bad-request",
    async (namespace) => {
      await session(
        async (_xmpp, peer) => {
          peer.send(
            `<iq xmlns="${CONTENT}" type="get" id="nonempty" from="${TARGET}" to="${FULL_JID}"><query xmlns="${namespace}"><extra xmlns="urn:example:extension"/></query></iq>`,
          );
          const events = readFrame(await nextIq(peer, "nonempty"));
          expect(events[0]).toMatchObject({
            attributes: { "{}type": "error" },
          });
          expect(events).toContainEqual({
            open: `{${STANZAS}}bad-request`,
            attributes: {},
          });
        },
        { identities: [IDENTITY] },
      );
    },
  );

  test("§3.1: local identities retain independent language and name values", async () => {
    await session(
      async (xmpp, peer) => {
        discovery(xmpp).setIdentities([
          { ...IDENTITY, lang: "en" },
          { ...IDENTITY, name: "Przykład", lang: "pl" },
        ]);
        const events = await incoming(peer, INFO);
        expect(
          events.filter(
            (event) => "open" in event && event.open === `{${INFO}}identity`,
          ),
        ).toEqual([
          {
            open: `{${INFO}}identity`,
            attributes: {
              "{}category": "client",
              "{}type": "web",
              "{}name": "Example",
              "{http://www.w3.org/XML/1998/namespace}lang": "en",
            },
          },
          {
            open: `{${INFO}}identity`,
            attributes: {
              "{}category": "client",
              "{}type": "web",
              "{}name": "Przykład",
              "{http://www.w3.org/XML/1998/namespace}lang": "pl",
            },
          },
        ]);
      },
      { identities: [IDENTITY] },
    );
  });

  test("§§3.2/4.2: registry nodes stay separate from root and mirror opaque names", async () => {
    await session(
      async (xmpp, peer) => {
        const api = discovery(xmpp);
        api.setNode(NODE, {
          identities: [{ category: "hierarchy", type: "branch" }],
          features: ["urn:example:node"],
          items: [{ jid: "rooms.example.test", node: "child" }],
        });
        const info = await incoming(peer, INFO, NODE);
        expect(info).toContainEqual({
          open: `{${INFO}}query`,
          attributes: { "{}node": NODE },
        });
        expect(
          info.filter(
            (event) => "open" in event && event.open === `{${INFO}}feature`,
          ),
        ).toEqual(
          [INFO, ITEMS, "urn:example:node"].map((feature) => ({
            open: `{${INFO}}feature`,
            attributes: { "{}var": feature },
          })),
        );
        const items = await incoming(peer, ITEMS, NODE);
        expect(items).toContainEqual({
          open: `{${ITEMS}}item`,
          attributes: { "{}jid": "rooms.example.test", "{}node": "child" },
        });
        const root = await incoming(peer, INFO);
        expect(
          root.some(
            (event) =>
              "open" in event &&
              event.attributes["{}var"] === "urn:example:node",
          ),
        ).toBe(false);
        api.removeNode(NODE);
        expect(await incoming(peer, INFO, NODE)).toContainEqual({
          open: `{${STANZAS}}item-not-found`,
          attributes: {},
        });
      },
      { identities: [IDENTITY] },
    );
  });

  test("§4.1: explicit items are deduplicated by prepared JID and exact node", async () => {
    await session(
      async (xmpp, peer) => {
        discovery(xmpp).setItems([
          { jid: "ROOMS.EXAMPLE.TEST", name: "Rooms" },
          { jid: "rooms.example.test", name: "Rooms" },
          { jid: "rooms.example.test", node: "child", name: "Child" },
        ]);
        const events = await incoming(peer, ITEMS);
        expect(
          events.filter(
            (event) => "open" in event && event.open === `{${ITEMS}}item`,
          ),
        ).toEqual([
          {
            open: `{${ITEMS}}item`,
            attributes: { "{}jid": "rooms.example.test", "{}name": "Rooms" },
          },
          {
            open: `{${ITEMS}}item`,
            attributes: {
              "{}jid": "rooms.example.test",
              "{}node": "child",
              "{}name": "Child",
            },
          },
        ]);
      },
      { identities: [IDENTITY] },
    );
  });

  test.each([INFO, ITEMS])(
    "local node policy: unknown node %s returns item-not-found",
    async (namespace) => {
      await session(
        async (_xmpp, peer) => {
          const events = await incoming(peer, namespace, "unknown");
          expect(events[0]).toMatchObject({
            attributes: { "{}type": "error" },
          });
          expect(events).toContainEqual({
            open: `{${STANZAS}}item-not-found`,
            attributes: {},
          });
        },
        { identities: [IDENTITY] },
      );
    },
  );

  test.each([INFO, ITEMS])(
    "local empty-node policy: %s rejects empty node, not root",
    async (namespace) => {
      await session(
        async (_xmpp, peer) => {
          expect(await incoming(peer, namespace, "")).toContainEqual({
            open: `{${STANZAS}}bad-request`,
            attributes: {},
          });
          const root = await incoming(peer, namespace);
          expect(root[0]).toMatchObject({ attributes: { "{}type": "result" } });
        },
        { identities: [IDENTITY] },
      );
    },
  );

  test.each([INFO, ITEMS])(
    "§§7–8: denied %s is indistinguishable from unavailable service",
    async (namespace) => {
      const seen: unknown[] = [];
      await session(
        async (xmpp, peer) => {
          discovery(xmpp).setNode("private", {
            identities: [{ ...IDENTITY, name: "Do not disclose" }],
            features: ["urn:example:private"],
            items: [{ jid: "private.example.test", name: "Private" }],
          });
          const denials = [];
          for (const node of ["private", "missing"]) {
            const events = await incoming(peer, namespace, node);
            expect(events[0]).toMatchObject({
              attributes: { "{}type": "error" },
            });
            expect(events).toContainEqual({
              open: `{${STANZAS}}service-unavailable`,
              attributes: {},
            });
            expect(
              events.some(
                (event) =>
                  "open" in event &&
                  (event.open === `{${INFO}}identity` ||
                    event.open === `{${INFO}}feature` ||
                    event.open === `{${ITEMS}}item` ||
                    event.open === `{${STANZAS}}text`),
              ),
            ).toBe(false);
            const errorIndex = events.findIndex(
              (event) => "open" in event && event.open === `{${CONTENT}}error`,
            );
            expect(errorIndex).toBeGreaterThan(0);
            const error = events.slice(errorIndex, -1);
            expect(error).toHaveLength(4);
            denials.push(error);
          }
          expect(denials[0]).toEqual(denials[1]);
          expect(seen).toEqual(
            ["private", "missing"].map((node) => ({
              from: TARGET,
              to: FULL_JID,
              node,
              type: namespace === INFO ? "info" : "items",
            })),
          );
        },
        {
          identities: [IDENTITY],
          authorize: (request) => {
            seen.push(request);
            return false;
          },
        },
      );
    },
  );

  test("local registry policy: rejected replacement leaves the old response intact", async () => {
    await session(
      async (xmpp, peer) => {
        const api = discovery(xmpp);
        expect(() =>
          api.setIdentities([IDENTITY, { ...IDENTITY, name: "Conflicting" }]),
        ).toThrow(TypeError);
        expect(() =>
          api.setItems([{ jid: "valid.example.test" }, { jid: "user@" }]),
        ).toThrow(TypeError);
        api.setNode("safe", {
          identities: [{ category: "hierarchy", type: "leaf" }],
        });
        expect(() =>
          api.setNode("safe", { identities: [{ category: "", type: "leaf" }] }),
        ).toThrow(TypeError);
        const root = await incoming(peer, INFO);
        expect(
          root.filter(
            (event) => "open" in event && event.open === `{${INFO}}identity`,
          ),
        ).toEqual([
          {
            open: `{${INFO}}identity`,
            attributes: {
              "{}category": "client",
              "{}type": "web",
              "{}name": "Example",
            },
          },
        ]);
        expect(
          (await incoming(peer, ITEMS)).filter(
            (event) => "open" in event && event.open === `{${ITEMS}}item`,
          ),
        ).toEqual([]);
        expect(await incoming(peer, INFO, "safe")).toContainEqual({
          open: `{${INFO}}identity`,
          attributes: { "{}category": "hierarchy", "{}type": "leaf" },
        });
      },
      { identities: [IDENTITY] },
    );
  });

  test.each([
    ["setIdentities", "en_US"],
    ["setIdentities", "not a tag"],
    ["setNode", "en_US"],
    ["setNode", "not a tag"],
  ] as const)(
    "§3.1 / RFC 5646: %s rejects malformed language %s before replacing registry",
    async (method, lang) => {
      await session(
        async (xmpp, peer) => {
          const api = discovery(xmpp);
          api.setNode("stable", {
            identities: [
              { category: "hierarchy", type: "leaf", name: "Stable" },
            ],
          });
          const node = method === "setNode" ? "stable" : undefined;
          const expected =
            method === "setNode"
              ? {
                  "{}category": "hierarchy",
                  "{}type": "leaf",
                  "{}name": "Stable",
                }
              : {
                  "{}category": "client",
                  "{}type": "web",
                  "{}name": "Example",
                };
          const before = await incoming(peer, INFO, node);
          expect(before).toContainEqual({
            open: `{${INFO}}identity`,
            attributes: expected,
          });
          if (method === "setIdentities") {
            expect(() => api.setIdentities([{ ...IDENTITY, lang }])).toThrow(
              TypeError,
            );
          } else {
            expect(() =>
              api.setNode("stable", {
                identities: [{ ...IDENTITY, lang }],
                features: ["urn:must-not-publish"],
              }),
            ).toThrow(TypeError);
          }
          expect(await incoming(peer, INFO, node)).toEqual(before);
        },
        { identities: [IDENTITY] },
      );
    },
  );

  test.each(["", "x-example", "i-klingon"])(
    "§3.1 / XML §2.12: valid identity language %s survives construction and setters",
    async (lang) => {
      await session(
        async (xmpp, peer) => {
          const api = discovery(xmpp);
          const expected = {
            open: `{${INFO}}identity`,
            attributes: {
              "{}category": "client",
              "{}type": "web",
              "{}name": "Example",
              "{http://www.w3.org/XML/1998/namespace}lang": lang,
            },
          };
          expect(await incoming(peer, INFO)).toContainEqual(expected);
          api.setIdentities([{ ...IDENTITY, lang }]);
          expect(await incoming(peer, INFO)).toContainEqual(expected);
          api.setNode("localized", { identities: [{ ...IDENTITY, lang }] });
          expect(await incoming(peer, INFO, "localized")).toContainEqual(
            expected,
          );
        },
        { identities: [{ ...IDENTITY, lang }] },
      );
    },
  );

  test("local registry policy: caller input mutations cannot change published snapshots or invent items", async () => {
    const configuredIdentity = { ...IDENTITY };
    const configuredItem = {
      jid: "configured.example.test",
      name: "Configured",
    };
    const options = {
      identities: [configuredIdentity],
      features: ["urn:configured"],
      items: [configuredItem],
    };
    await session(async (xmpp, peer) => {
      const api = discovery(xmpp);
      configuredIdentity.name = "Changed";
      configuredItem.jid = "changed.example.test";
      options.identities.push({ ...IDENTITY, type: "bot" });
      options.features.push("urn:must-not-publish");
      options.items.push({ jid: "extra.example.test", name: "Extra" });
      const configured = await incoming(peer, INFO);
      expect(configured).toContainEqual({
        open: `{${INFO}}feature`,
        attributes: { "{}var": "urn:configured" },
      });
      expect(
        configured.filter(
          (event) => "open" in event && event.open === `{${INFO}}identity`,
        ),
      ).toEqual([
        {
          open: `{${INFO}}identity`,
          attributes: {
            "{}category": "client",
            "{}type": "web",
            "{}name": "Example",
          },
        },
      ]);
      expect(
        configured.some(
          (event) =>
            "open" in event &&
            event.attributes["{}var"] === "urn:must-not-publish",
        ),
      ).toBe(false);
      expect(
        (await incoming(peer, ITEMS)).filter(
          (event) => "open" in event && event.open === `{${ITEMS}}item`,
        ),
      ).toEqual([
        {
          open: `{${ITEMS}}item`,
          attributes: {
            "{}jid": "configured.example.test",
            "{}name": "Configured",
          },
        },
      ]);

      const identity = { ...IDENTITY, name: "Setter" };
      const identities = [identity];
      api.setIdentities(identities);
      identity.name = "Changed";
      identities.push({ ...IDENTITY, type: "bot" });
      const item = { jid: "setter.example.test", name: "Setter" };
      const items = [item];
      api.setItems(items);
      item.jid = "changed.example.test";
      items.push({ jid: "extra.example.test", name: "Extra" });

      const nodeIdentity = {
        category: "hierarchy",
        type: "leaf",
        name: "Node",
      };
      const nodeItem = { jid: "node.example.test", name: "Node item" };
      const node = {
        identities: [nodeIdentity],
        features: ["urn:node"],
        items: [nodeItem],
      };
      api.setNode("snapshot", node);
      nodeIdentity.name = "Changed";
      node.identities.push({ category: "client", type: "bot", name: "Extra" });
      node.features.push("urn:must-not-publish");
      nodeItem.jid = "changed.example.test";
      node.items.push({ jid: "extra.example.test", name: "Extra" });

      expect(
        (await incoming(peer, INFO)).filter(
          (event) => "open" in event && event.open === `{${INFO}}identity`,
        ),
      ).toEqual([
        {
          open: `{${INFO}}identity`,
          attributes: {
            "{}category": "client",
            "{}type": "web",
            "{}name": "Setter",
          },
        },
      ]);
      // Registering a node does not implicitly add it to the root's public items.
      expect(
        (await incoming(peer, ITEMS)).filter(
          (event) => "open" in event && event.open === `{${ITEMS}}item`,
        ),
      ).toEqual([
        {
          open: `{${ITEMS}}item`,
          attributes: { "{}jid": "setter.example.test", "{}name": "Setter" },
        },
      ]);
      const registered = await incoming(peer, INFO, "snapshot");
      expect(registered).toContainEqual({
        open: `{${INFO}}feature`,
        attributes: { "{}var": "urn:node" },
      });
      expect(
        registered.filter(
          (event) => "open" in event && event.open === `{${INFO}}identity`,
        ),
      ).toEqual([
        {
          open: `{${INFO}}identity`,
          attributes: {
            "{}category": "hierarchy",
            "{}type": "leaf",
            "{}name": "Node",
          },
        },
      ]);
      expect(
        registered.some(
          (event) =>
            "open" in event &&
            event.attributes["{}var"] === "urn:must-not-publish",
        ),
      ).toBe(false);
      expect(
        (await incoming(peer, ITEMS, "snapshot")).filter(
          (event) => "open" in event && event.open === `{${ITEMS}}item`,
        ),
      ).toEqual([
        {
          open: `{${ITEMS}}item`,
          attributes: { "{}jid": "node.example.test", "{}name": "Node item" },
        },
      ]);
    }, options);
  });

  test.each(["setIdentities", "addFeature", "setItems"] as const)(
    "local registry policy: %s cannot silently create an unknown node",
    async (method) => {
      await session(
        async (xmpp) => {
          const api = discovery(xmpp);
          if (method === "setIdentities") {
            expect(() => api.setIdentities([IDENTITY], "unknown")).toThrow();
          }
          if (method === "addFeature") {
            expect(() =>
              api.addFeature("urn:example:feature", "unknown"),
            ).toThrow();
          }
          if (method === "setItems") {
            expect(() => api.setItems([], "unknown")).toThrow();
          }
        },
        { identities: [IDENTITY] },
      );
    },
  );
});
