import { describe, expect, test } from "bun:test";
import { jid, xml } from "../../src/client/index.js";
import type { JID } from "../../types/index.js";
import { readFrame } from "../xml.ts";
import {
  INFO,
  ITEMS,
  CONTENT,
  TARGET,
  NODE,
  IDENTITY,
  IDENTITY_XML,
  FEATURE_XML,
  DEFAULT_INFO,
  discovery,
  nextIq,
  session,
  resultReply,
} from "./fixture.ts";

describe("XEP-0030 §§3–4 — requester", () => {
  test.each([
    ["info", INFO],
    ["items", ITEMS],
  ] as const)(
    "§§3.1/4.1: %s sends one empty IQ-get query",
    async (kind, namespace) => {
      await session(
        async (xmpp, peer) => {
          const api = discovery(xmpp);
          const result = await api[kind](TARGET, { node: NODE });
          expect(result.node).toBe(NODE);
          const events = readFrame(await nextIq(peer));
          const root = events[0];
          expect(root).toMatchObject({
            open: `{${CONTENT}}iq`,
            attributes: { "{}type": "get", "{}to": TARGET },
          });
          expect("open" in root && root.attributes["{}id"]).toBeTruthy();
          expect(events.slice(1)).toEqual([
            { open: `{${namespace}}query`, attributes: { "{}node": NODE } },
            { close: `{${namespace}}query` },
            { close: `{${CONTENT}}iq` },
          ]);
        },
        undefined,
        resultReply(
          `<query xmlns="${namespace}" node="${NODE}">${kind === "info" ? IDENTITY_XML + FEATURE_XML : ""}</query>`,
        ),
      );
    },
  );

  test("§3.1: omitted destination queries the connected server", async () => {
    await session(
      async (xmpp, peer) => {
        const result = await discovery(xmpp).info();
        expect(result.identities).toEqual([IDENTITY]);
        const root = readFrame(await nextIq(peer))[0];
        expect(root).toMatchObject({
          open: `{${CONTENT}}iq`,
          attributes: { "{}type": "get" },
        });
        expect("open" in root && root.attributes["{}to"]).toBeUndefined();
      },
      undefined,
      resultReply(DEFAULT_INFO),
    );
  });

  test("§3.1 / RFC 7622: a JID destination is serialized canonically", async () => {
    await session(
      async (xmpp, peer) => {
        await discovery(xmpp).info(jid(TARGET) as unknown as JID);
        expect(readFrame(await nextIq(peer))[0]).toMatchObject({
          attributes: { "{}to": TARGET },
        });
      },
      undefined,
      resultReply(DEFAULT_INFO),
    );
  });

  test("§3.1: infer omitted disco-info support without editing raw query", async () => {
    await session(
      async (xmpp) => {
        const result = await discovery(xmpp).info(TARGET);
        expect(result.identities).toEqual([IDENTITY]);
        expect(result.features).toEqual(["urn:example:feature", INFO]);
        expect(
          result.query
            .getChildren("feature", INFO)
            .map((feature) => feature.attrs.var),
        ).toEqual(["urn:example:feature"]);
      },
      undefined,
      resultReply(
        `<query xmlns="${INFO}">${IDENTITY_XML}<feature var="urn:example:feature"/></query>`,
      ),
    );
  });

  test("§3.1: retain identical remote duplicates for capability verification", async () => {
    await session(
      async (xmpp) => {
        const result = await discovery(xmpp).info(TARGET);
        expect(result.identities).toEqual([IDENTITY, IDENTITY]);
        expect(result.features).toEqual([INFO, INFO]);
        expect(result.query.getChildren("identity", INFO)).toHaveLength(2);
        expect(result.query.getChildren("feature", INFO)).toHaveLength(2);
      },
      undefined,
      resultReply(
        `<query xmlns="${INFO}">${IDENTITY_XML.repeat(2)}${FEATURE_XML.repeat(2)}</query>`,
      ),
    );
  });

  test("§3.1: localized and different identities remain valid alternatives", async () => {
    await session(
      async (xmpp) => {
        const result = await discovery(xmpp).info(TARGET);
        expect(result.identities).toEqual([
          { category: "client", type: "web", lang: "en", name: "Example" },
          { category: "client", type: "web", lang: "pl", name: "Przykład" },
          { category: "gateway", type: "custom", name: "Other" },
        ]);
      },
      undefined,
      resultReply(
        `<query xmlns="${INFO}"><identity category="client" type="web" xml:lang="en" name="Example"/><identity category="client" type="web" xml:lang="pl" name="Przykład"/><identity category="gateway" type="custom" name="Other"/>${FEATURE_XML}</query>`,
      ),
    );
  });

  test("§§2/4.1: ignore foreign item metadata, retain duplicates, never walk the tree", async () => {
    await session(
      async (xmpp, peer) => {
        const result = await discovery(xmpp).items(TARGET);
        expect(result.items).toEqual([
          { jid: "rooms.example.test", node: "A/B", name: "Rooms" },
          { jid: "rooms.example.test", node: "A/B", name: "Rooms" },
        ]);
        expect(result.query.getChildren("item", ITEMS)).toHaveLength(2);
        await xmpp.send(xml("probe", { xmlns: "urn:test:disco-barrier" }));
        for (;;) {
          const root = readFrame(await peer.next())[0];
          if ("open" in root && root.open === "{urn:test:disco-barrier}probe") {
            break;
          }
        }
        expect(
          peer.transcript.filter((frame) =>
            readFrame(frame).some(
              (event) =>
                "open" in event &&
                (event.open === `{${INFO}}query` ||
                  event.open === `{${ITEMS}}query`),
            ),
          ),
        ).toHaveLength(1);
      },
      undefined,
      resultReply(
        `<query xmlns="${ITEMS}"><item jid="rooms.example.test" node="A/B" name="Rooms"><extra xmlns="urn:example:metadata"/></item><item jid="rooms.example.test" node="A/B" name="Rooms"/><item xmlns="urn:foreign" jid="ignored.example.test"/></query>`,
      ),
    );
  });

  test("§3.1: infer disco-info when it was the only omitted feature", async () => {
    await session(
      async (xmpp) => {
        const result = await discovery(xmpp).info(TARGET);
        expect(result.features).toEqual([INFO]);
        expect(result.query.getChildren("feature", INFO)).toEqual([]);
      },
      undefined,
      resultReply(`<query xmlns="${INFO}">${IDENTITY_XML}</query>`),
    );
  });

  test("§2: foreign info extensions cannot replace identities or features", async () => {
    await session(
      async (xmpp) => {
        const result = await discovery(xmpp).info(TARGET);
        expect(result.identities).toEqual([IDENTITY]);
        expect(result.features).toEqual([INFO]);
        expect(result.query.getChild("x", "jabber:x:data")).toBeDefined();
      },
      undefined,
      resultReply(
        `<query xmlns="${INFO}">${IDENTITY_XML}${FEATURE_XML}<identity xmlns="urn:foreign" category="spoof"/><feature xmlns="urn:foreign" var="urn:spoof"/><x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE"><value>urn:example:form</value></field></x></query>`,
      ),
    );
  });

  test.each([
    ["wrong query namespace", `<query xmlns="${ITEMS}"/>`, undefined],
    ["missing query", "", undefined],
    [
      "missing identities",
      `<query xmlns="${INFO}">${FEATURE_XML}</query>`,
      undefined,
    ],
    [
      "missing category",
      `<query xmlns="${INFO}"><identity type="web"/>${FEATURE_XML}</query>`,
      undefined,
    ],
    [
      "empty category",
      `<query xmlns="${INFO}"><identity category="" type="web"/>${FEATURE_XML}</query>`,
      undefined,
    ],
    [
      "missing type",
      `<query xmlns="${INFO}"><identity category="client"/>${FEATURE_XML}</query>`,
      undefined,
    ],
    [
      "conflicting localized name",
      `<query xmlns="${INFO}">${IDENTITY_XML}<identity category="client" type="web" name="Conflict"/>${FEATURE_XML}</query>`,
      undefined,
    ],
    [
      "missing feature var",
      `<query xmlns="${INFO}">${IDENTITY_XML}<feature/></query>`,
      undefined,
    ],
    [
      "feature children",
      `<query xmlns="${INFO}">${IDENTITY_XML}<feature var="${INFO}"><extension xmlns="urn:example"/></feature></query>`,
      undefined,
    ],
    [
      "feature character data",
      `<query xmlns="${INFO}">${IDENTITY_XML}<feature var="${INFO}">not-empty</feature></query>`,
      undefined,
    ],
    [
      "unknown hierarchy type",
      `<query xmlns="${INFO}"><identity category="hierarchy" type="other"/>${FEATURE_XML}</query>`,
      undefined,
    ],
    ["missing requested node", DEFAULT_INFO, "expected"],
    [
      "different requested node",
      `<query xmlns="${INFO}" node="other">${IDENTITY_XML}${FEATURE_XML}</query>`,
      "expected",
    ],
    [
      "unsolicited node",
      `<query xmlns="${INFO}" node="other">${IDENTITY_XML}${FEATURE_XML}</query>`,
      undefined,
    ],
  ] as const)(
    "§§3.1–3.2/4.3: reject malformed info / %s",
    async (_name, payload, node) => {
      await session(
        async (xmpp) => {
          const result = await discovery(xmpp)
            .info(TARGET, { node })
            .catch((error: Error) => error);
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).name).not.toBe("TimeoutError");
        },
        undefined,
        resultReply(payload),
      );
    },
  );

  test.each([
    [
      "wrong query namespace",
      `<query xmlns="${INFO}">${IDENTITY_XML}${FEATURE_XML}</query>`,
    ],
    ["missing jid", `<query xmlns="${ITEMS}"><item/></query>`],
    ["malformed jid", `<query xmlns="${ITEMS}"><item jid="user@"/></query>`],
    [
      "item character data",
      `<query xmlns="${ITEMS}"><item jid="rooms.example.test">not-empty</item></query>`,
    ],
    [
      "empty item node",
      `<query xmlns="${ITEMS}"><item jid="rooms.example.test" node=""/></query>`,
    ],
  ] as const)(
    "§§4.1–4.2: reject malformed items / %s",
    async (_name, payload) => {
      await session(
        async (xmpp) => {
          const result = await discovery(xmpp)
            .items(TARGET)
            .catch((error: Error) => error);
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).name).not.toBe("TimeoutError");
        },
        undefined,
        resultReply(payload),
      );
    },
  );
});
