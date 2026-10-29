import { describe, expect, test } from "bun:test";
import { client, xml } from "../../src/client/index.js";
import { readFrame } from "../xml.ts";
import {
  CAPS,
  INFO,
  ITEMS,
  CONTENT,
  NODE,
  FULL_JID,
  TARGET,
  IDENTITY,
  FEATURES,
  INITIAL_SHA1,
  EXTRA_SHA1,
  CHANGED_SHA1,
  LANGUAGES_SHA1,
  session,
  nextFrame,
  annotation,
  query,
} from "./advertising-fixture.ts";

describe("XEP-0115 v1.6.0 §§6–7 — generating entity", () => {
  test.each(["send", "sendMany", "directed", "unavailable"])(
    "§§5.1/6.1: %s presence carries the complete current fingerprint",
    async (method) => {
      await session(async (xmpp, peer) => {
        const presence = xml(
          "presence",
          {
            id: "available",
            ...(method === "directed" ? { to: TARGET } : {}),
            ...(method === "unavailable" ? { type: "unavailable" } : {}),
          },
          xml("status", {}, "Ready"),
        );
        if (method === "sendMany") {
          await xmpp.sendMany([presence]);
        } else {
          await xmpp.send(presence);
        }
        const frame = await nextFrame(peer, "presence", "available");
        expect(annotation(frame)).toEqual({
          "{}hash": "sha-1",
          "{}node": NODE,
          "{}ver": INITIAL_SHA1,
        });
        expect(readFrame(frame)).toContainEqual({ text: "Ready" });
        expect(readFrame(frame)[0]).toMatchObject({
          attributes: {
            "{}id": "available",
            ...(method === "directed" ? { "{}to": TARGET } : {}),
            ...(method === "unavailable" ? { "{}type": "unavailable" } : {}),
          },
        });
      });
    },
  );

  test("local opt-in policy: disabled caps neither annotates nor advertises support", async () => {
    await session(
      async (xmpp, peer) => {
        await xmpp.send(xml("presence", { id: "disabled" }));
        expect(
          readFrame(await nextFrame(peer, "presence", "disabled")),
        ).not.toContainEqual({
          open: `{${CAPS}}c`,
          attributes: expect.anything(),
        });
        expect(await query(peer, INFO)).not.toContainEqual({
          open: `{${INFO}}feature`,
          attributes: { "{}var": CAPS },
        });
      },
      { caps: undefined },
    );
  });

  test("§§6.2/7: matching node returns exact advertised data, never an items entry", async () => {
    await session(async (xmpp, peer) => {
      await xmpp.send(xml("presence", { id: "available" }));
      await nextFrame(peer, "presence", "available");
      const events = await query(peer, INFO, `${NODE}#${INITIAL_SHA1}`);
      expect(events[0]).toMatchObject({
        attributes: {
          "{}type": "result",
          "{}from": FULL_JID,
          "{}to": TARGET,
        },
      });
      expect(events).toContainEqual({
        open: `{${INFO}}query`,
        attributes: { "{}node": `${NODE}#${INITIAL_SHA1}` },
      });
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
      ]);
      expect(
        events
          .filter(
            (event) => "open" in event && event.open === `{${INFO}}feature`,
          )
          .map((event) => "open" in event && event.attributes["{}var"])
          .sort(),
      ).toEqual([...FEATURES].sort());
      expect(
        (await query(peer, ITEMS)).filter(
          (event) => "open" in event && event.open === `{${ITEMS}}item`,
        ),
      ).toEqual([]);
    });
  });

  test("§6.2: every hashed identity language survives a language-specific query", async () => {
    await session(
      async (xmpp, peer) => {
        await xmpp.send(xml("presence", { id: "available" }));
        expect(
          annotation(await nextFrame(peer, "presence", "available"))["{}ver"],
        ).toBe(LANGUAGES_SHA1);
        const events = await query(
          peer,
          INFO,
          `${NODE}#${LANGUAGES_SHA1}`,
          "en",
        );
        expect(
          events
            .filter(
              (event) => "open" in event && event.open === `{${INFO}}identity`,
            )
            .map((event) => "open" in event && event.attributes),
        ).toEqual([
          {
            "{}category": "client",
            "{}type": "web",
            "{}name": "English",
            "{http://www.w3.org/XML/1998/namespace}lang": "en",
          },
          {
            "{}category": "client",
            "{}type": "web",
            "{}name": "Polski",
            "{http://www.w3.org/XML/1998/namespace}lang": "pl",
          },
        ]);
      },
      {
        disco: {
          identities: [
            { ...IDENTITY, name: "English", lang: "en" },
            { ...IDENTITY, name: "Polski", lang: "pl" },
          ],
        },
      },
    );
  });

  test("§6.2 / local privacy policy: caps snapshots respect discovery authorization", async () => {
    await session(
      async (xmpp, peer) => {
        await xmpp.send(xml("presence", { id: "available" }));
        await nextFrame(peer, "presence", "available");
        const events = await query(peer, INFO, `${NODE}#${INITIAL_SHA1}`);
        expect(events[0]).toMatchObject({ attributes: { "{}type": "error" } });
        expect(events).toContainEqual({
          open: "{urn:ietf:params:xml:ns:xmpp-stanzas}service-unavailable",
          attributes: {},
        });
        expect(
          events.some(
            (event) => "open" in event && event.open === `{${INFO}}identity`,
          ),
        ).toBe(false);
      },
      { disco: { identities: [IDENTITY], authorize: () => false } },
    );
  });

  test.each(["feature", "identity"])(
    "§6.1: %s change refreshes only an existing broadcast and retains its payload",
    async (change) => {
      await session(async (xmpp, peer) => {
        await xmpp.send(
          xml(
            "presence",
            { id: "available" },
            xml("show", {}, "away"),
            xml("status", {}, "Lunch"),
          ),
        );
        await nextFrame(peer, "presence", "available");
        if (change === "feature") {
          xmpp.disco.addFeature("urn:example:extra");
        } else {
          xmpp.disco.setIdentities([{ ...IDENTITY, name: "Changed" }]);
        }
        const refreshed = await nextFrame(peer, "presence");
        expect(annotation(refreshed)["{}ver"]).toBe(
          change === "feature" ? EXTRA_SHA1 : CHANGED_SHA1,
        );
        expect(readFrame(refreshed)[0]).not.toMatchObject({
          attributes: { "{}to": expect.anything() },
        });
        expect(readFrame(refreshed)).toContainEqual({ text: "Lunch" });
        expect(readFrame(refreshed)).toContainEqual({ text: "away" });
        // The already advertised old version remains an immutable snapshot.
        const old = await query(peer, INFO, `${NODE}#${INITIAL_SHA1}`);
        expect(old[0]).toMatchObject({ attributes: { "{}type": "result" } });
        expect(old).toContainEqual({
          open: `{${INFO}}identity`,
          attributes: {
            "{}category": "client",
            "{}type": "web",
            "{}name": "Example",
          },
        });
        expect(old).not.toContainEqual({
          open: `{${INFO}}feature`,
          attributes: { "{}var": "urn:example:extra" },
        });
      });
    },
  );

  test.each(["no initial presence", "directed only", "unavailable"])(
    "local presence policy: registry change cannot invent availability / %s",
    async (state) => {
      await session(async (xmpp, peer) => {
        expect(
          peer.transcript.filter((frame) => {
            const root = readFrame(frame)[0];
            return "open" in root && root.open === `{${CONTENT}}presence`;
          }),
        ).toEqual([]);
        if (state !== "no initial presence") {
          await xmpp.send(
            xml("presence", {
              id: "before",
              ...(state === "directed only" ? { to: TARGET } : {}),
            }),
          );
          await nextFrame(peer, "presence", "before");
        }
        if (state === "unavailable") {
          await xmpp.send(
            xml("presence", { type: "unavailable", id: "offline" }),
          );
          await nextFrame(peer, "presence", "offline");
        }
        const before = peer.transcript.length;
        xmpp.disco.addFeature("urn:example:extra");
        // Awaited presence serialization is the completion barrier for updates.
        await xmpp.send(xml("presence", { to: TARGET, id: "barrier" }));
        const barrier = await nextFrame(peer, "presence", "barrier");
        expect(annotation(barrier)["{}ver"]).toBe(EXTRA_SHA1);
        expect(peer.transcript.slice(before)).toEqual([barrier]);
      });
    },
  );

  test("local snapshot policy: retain eight advertised versions; manual nodes coexist", async () => {
    await session(async (xmpp, peer) => {
      xmpp.disco.setNode("manual", { identities: [IDENTITY] });
      const versions: string[] = [];
      for (let version = 0; version < 9; version++) {
        xmpp.disco.setIdentities([{ ...IDENTITY, name: `Version ${version}` }]);
        await xmpp.send(
          xml("presence", { to: TARGET, id: `version-${version}` }),
        );
        versions.push(
          annotation(await nextFrame(peer, "presence", `version-${version}`))[
            "{}ver"
          ],
        );
      }
      expect(
        (await query(peer, INFO, `${NODE}#${versions[0]}`))[0],
      ).toMatchObject({ attributes: { "{}type": "error" } });
      for (const version of versions.slice(1)) {
        expect(
          (await query(peer, INFO, `${NODE}#${version}`))[0],
        ).toMatchObject({ attributes: { "{}type": "result" } });
      }
      expect((await query(peer, INFO, "manual"))[0]).toMatchObject({
        attributes: { "{}type": "result" },
      });
    });
  });

  test("local ownership policy: installed caps support cannot be removed from discovery", async () => {
    await session(async (xmpp, peer) => {
      expect(() => xmpp.disco.removeFeature(CAPS)).toThrow(TypeError);
      await xmpp.send(xml("presence", { id: "protected-feature" }));
      expect(
        annotation(await nextFrame(peer, "presence", "protected-feature"))[
          "{}ver"
        ],
      ).toBe(INITIAL_SHA1);
      const events = await query(peer, INFO);
      expect(events).toContainEqual({
        open: `{${INFO}}feature`,
        attributes: { "{}var": CAPS },
      });
    });
  });

  test.each(["replace", "remove"])(
    "local ownership policy: an advertised snapshot rejects public node %s",
    async (change) => {
      await session(async (xmpp, peer) => {
        await xmpp.send(xml("presence", { id: "protected-node" }));
        await nextFrame(peer, "presence", "protected-node");
        const node = `${NODE}#${INITIAL_SHA1}`;
        expect(() => {
          if (change === "replace") {
            xmpp.disco.setNode(node, {
              identities: [{ ...IDENTITY, name: "Forged snapshot" }],
              features: ["urn:example:forged"],
            });
          } else {
            xmpp.disco.removeNode(node);
          }
        }).toThrow(TypeError);
        const events = await query(peer, INFO, node);
        expect(events[0]).toMatchObject({ attributes: { "{}type": "result" } });
        expect(events).toContainEqual({
          open: `{${INFO}}identity`,
          attributes: {
            "{}category": "client",
            "{}type": "web",
            "{}name": "Example",
          },
        });
        expect(
          events
            .filter(
              (event) => "open" in event && event.open === `{${INFO}}feature`,
            )
            .map((event) => "open" in event && event.attributes["{}var"])
            .sort(),
        ).toEqual([...FEATURES].sort());
        // Ownership protection is scoped: ordinary application nodes stay mutable.
        xmpp.disco.setNode("ordinary", { identities: [IDENTITY] });
        xmpp.disco.removeNode("ordinary");
        expect((await query(peer, INFO, "ordinary"))[0]).toMatchObject({
          attributes: { "{}type": "error" },
        });
      });
    },
  );

  test("local privacy policy: an in-flight unavailable must suppress a simultaneous refresh", async () => {
    await session(async (xmpp, peer) => {
      await xmpp.send(xml("presence", { id: "available" }));
      await nextFrame(peer, "presence", "available");
      const before = peer.transcript.length;
      const unavailable = xmpp.send(
        xml("presence", { type: "unavailable", id: "offline" }),
      );
      xmpp.disco.addFeature("urn:example:extra");
      await unavailable;
      await nextFrame(peer, "presence", "offline");
      await xmpp.send(xml("presence", { to: TARGET, id: "privacy-barrier" }));
      const barrier = await nextFrame(peer, "presence", "privacy-barrier");
      expect(annotation(barrier)["{}ver"]).toBe(EXTRA_SHA1);
      expect(
        peer.transcript.slice(before).map((frame) => readFrame(frame)[0]),
      ).toEqual([
        expect.objectContaining({
          attributes: expect.objectContaining({
            "{}type": "unavailable",
            "{}id": "offline",
          }),
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({
            "{}to": TARGET,
            "{}id": "privacy-barrier",
          }),
        }),
      ]);
    });
  });

  // Receive-side resource limits are not restrictions on generated XML grammar.
  test.each(["size", "depth"])(
    "local output policy: caps preserves valid presence beyond the receive %s limit",
    async (boundary) => {
      await session(async (xmpp, peer) => {
        const presence = xml("presence", { id: "large-output" });
        const payload =
          boundary === "size" ? "x".repeat(1024 * 1024 + 1) : "Deep payload";
        if (boundary === "size") {
          presence.c("status").t(payload);
        } else {
          let parent = presence.c("extra", {
            xmlns: "urn:example:deep-output",
          });
          // presence + extra + 63 nested children = 65 element levels.
          for (let depth = 0; depth < 63; depth++) {
            parent = parent.c("x");
          }
          parent.t(payload);
        }
        const sent = await xmpp.send(presence).catch((error: Error) => error);
        expect(sent).toBeUndefined();
        const frame = await nextFrame(peer, "presence", "large-output");
        expect(annotation(frame)["{}ver"]).toBe(INITIAL_SHA1);
        const events = readFrame(frame);
        expect(events).toContainEqual({ text: payload });
        if (boundary === "depth") {
          expect(
            events.filter(
              (event) =>
                "open" in event && event.open === "{urn:example:deep-output}x",
            ),
          ).toHaveLength(63);
        }
      });
    },
  );

  test("local serialization policy: annotate one validated snapshot, not mutable object fields", async () => {
    await session(async (xmpp, peer) => {
      const presence = xml(
        "presence",
        { id: "serialized" },
        xml("status", {}, "Stale object payload"),
      );
      let serializations = 0;
      presence.toString = () => {
        serializations++;
        return `<presence xmlns="${CONTENT}" id="serialized"><status>Serialized actual</status></presence>`;
      };
      await xmpp.send(presence);
      const frame = await nextFrame(peer, "presence", "serialized");
      expect(serializations).toBe(1);
      expect(annotation(frame)["{}ver"]).toBe(INITIAL_SHA1);
      expect(readFrame(frame)).toContainEqual({ text: "Serialized actual" });
      expect(readFrame(frame)[0]).toMatchObject({
        attributes: { "{}id": "serialized" },
      });
    });
  });

  test("local envelope policy: annotation cannot authorize a serializer to change the presence ID", async () => {
    await session(async (xmpp, peer) => {
      const before = peer.transcript.length;
      const presence = xml("presence", { id: "object-not-wire" });
      let serializations = 0;
      presence.toString = () => {
        serializations++;
        return `<presence xmlns="${CONTENT}" id="serialized"/>`;
      };
      expect(
        await xmpp.send(presence).catch((error: Error) => error),
      ).toBeInstanceOf(TypeError);
      expect(serializations).toBe(1);
      expect(peer.transcript).toHaveLength(before);
    });
  });

  test("local serialization policy: validate the original once before annotation and SM admission", async () => {
    await session(
      async (xmpp, peer) => {
        const before = peer.transcript.length;
        const queue = xmpp.streamManagement.outbound_q.length;
        const presence = xml("presence", { id: "hostile" });
        let serializations = 0;
        presence.toString = () => {
          serializations++;
          return `<presence xmlns="${CONTENT}"><!-- forbidden --></presence>`;
        };
        const rejected = await xmpp
          .send(presence)
          .catch((error: Error) => error);
        expect(rejected).toBeInstanceOf(TypeError);
        expect(serializations).toBe(1);
        expect(xmpp.streamManagement.outbound_q).toHaveLength(queue);
        expect(peer.transcript).toHaveLength(before);
        await xmpp.send(xml("presence", { id: "recovery" }));
        expect(
          annotation(await nextFrame(peer, "presence", "recovery"))["{}ver"],
        ).toBe(INITIAL_SHA1);
      },
      {},
      true,
    );
  });
});

describe("XEP-0115 §4 / local caps configuration policy", () => {
  test.each([
    "urn:example:software",
    "https://[v1.app]/client",
    "https://EXAMPLE.test/%2f#Software",
  ])("preserve valid software URI alternatives %s", async (node) => {
    await session(
      async (xmpp, peer) => {
        await xmpp.send(xml("presence", { id: "uri" }));
        expect(
          annotation(await nextFrame(peer, "presence", "uri"))["{}node"],
        ).toBe(node);
      },
      { caps: { node } },
    );
  });
  // RFC 9110 §§4.2.1–4.2.2 prohibit empty HTTP(S) hosts even for identifiers
  // that are never dereferenced. Generic RFC 3987 syntax alone is insufficient.
  test.each([
    "",
    "relative/path",
    "https://",
    "https://example.test/ bad",
    "urn:bad\u0000value",
  ])("reject invalid software node URI %j", (node) => {
    expect(() =>
      client({
        domain: "example.test",
        disco: { identities: [IDENTITY] },
        caps: { node },
      }),
    ).toThrow(TypeError);
  });
  test("enabling caps requires explicitly configured discovery identities", () => {
    expect(() =>
      client({ domain: "example.test", caps: { node: NODE } }),
    ).toThrow(TypeError);
  });
});
