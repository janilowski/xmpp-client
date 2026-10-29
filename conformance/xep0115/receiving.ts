import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import type { Element } from "../../types/index.js";
import { waitForDisconnect } from "../peer.ts";
import { readFrame } from "../xml.ts";
import {
  COMPLEX_SHA1,
  COMPLEX_XML,
  FEATURES,
  INFO,
  SIMPLE_IDENTITY,
  SIMPLE_SHA1,
  SIMPLE_XML,
} from "./fixture.ts";
import {
  CAPS,
  CLIENT,
  NODE,
  TARGET,
  OTHER,
  ReceivingPeer,
  capabilities,
  receivingSession,
  result,
} from "./receiving-fixture.ts";

// XEP-0115 v1.6.0 §§5.4/6.2/6.3/8/9. Verified describes the hash, not identity
// authentication or permission to invoke a feature. Bounds are local policy.
describe("XEP-0115 — receiving and querying capabilities", () => {
  test("opt-in policy: disabled by default means no discovery traffic", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      await remote.barrier();
      expect(remote.queries).toEqual([]);
      expect(api.get(TARGET)).toBeUndefined();
    }, "disabled");
  });

  test.each([
    TARGET,
    "peer@remote.test/OtherCase",
    "remote.test",
    "room@remote.test",
  ])("§6.2: query the exact explicitly advertised JID / %s", async (jid) => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      const events: unknown[] = [];
      xmpp.on("capabilities", (value) => events.push(value));
      remote.advertise({ jid });
      const request = await remote.nextQuery();
      expect(api.get(jid)).toMatchObject({
        jid,
        node: NODE,
        ver: SIMPLE_SHA1,
        hash: "sha-1",
        status: "pending",
      });
      expect(request.to).toBe(jid);
      expect(request.node).toBe(`${NODE}#${SIMPLE_SHA1}`);
      expect(readFrame(request.frame)[0]).toMatchObject({
        open: `{${CLIENT}}iq`,
        attributes: { "{}type": "get", "{}id": request.id, "{}to": jid },
      });
      expect(readFrame(request.frame).slice(1)).toEqual([
        {
          open: `{${INFO}}query`,
          attributes: { "{}node": `${NODE}#${SIMPLE_SHA1}` },
        },
        { close: `{${INFO}}query` },
        { close: `{${CLIENT}}iq` },
      ]);
      remote.answer(request);
      const verified = await result(xmpp, jid, "verified");
      expect(verified.info?.identities).toEqual([
        { category: "client", type: "pc", name: "Exodus 0.9.1" },
      ]);
      expect(verified.info?.features).toEqual([...FEATURES]);
      expect(events).toContainEqual(
        expect.objectContaining({ jid, status: "verified" }),
      );
    });
  });

  test("§6.2: preserve the entire advertised node before appending #ver", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      const node = "https://example.test/Software/%2f#existing";
      remote.advertise({ node });
      const request = await remote.nextQuery();
      expect(request.node).toBe(`${node}#${SIMPLE_SHA1}`);
      remote.answer(request);
      expect(await result(xmpp, TARGET, "verified")).toMatchObject({ node });
    });
  });

  test("§6.3: server stream caps query the opening from only after authentication and binding", async () => {
    const annotation = `<c xmlns="${CAPS}" hash="sha-1" node="${NODE}" ver="${SIMPLE_SHA1}"/>`;
    await receivingSession(
      async (xmpp, remote) => {
        capabilities(xmpp);
        const request = await remote.nextQuery();
        expect(request.to).toBe("example.test");
        expect(request.node).toBe(`${NODE}#${SIMPLE_SHA1}`);
        const roots = remote.peer.transcript.map(
          (frame) => readFrame(frame)[0],
        );
        const queryIndex = remote.peer.transcript.indexOf(request.frame);
        expect(
          roots
            .slice(0, queryIndex)
            .filter(
              (root) =>
                "open" in root &&
                root.open === "{urn:ietf:params:xml:ns:xmpp-sasl}auth",
            ),
        ).toHaveLength(1);
        expect(
          roots
            .slice(0, queryIndex)
            .filter((root) => "open" in root && root.open === `{${CLIENT}}iq`),
        ).toHaveLength(1);
        remote.answer(request);
        await result(xmpp, "example.test", "verified");
        expect(remote.queries).toHaveLength(1);
      },
      "enabled",
      annotation,
    );
  });

  test("§5.4: SHA-256 validates against the independent known digest", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      remote.advertise({
        hash: "sha-256",
        ver: "Wr6IGEKhx6b9627gBmi/cCmpxXBc/GYq5zWuYfWGWoc=",
      });
      remote.answer(await remote.nextQuery());
      expect(await result(xmpp, TARGET, "verified")).toMatchObject({
        hash: "sha-256",
      });
    });
  });

  test("§5.4: a forged IQ sender cannot supply the capability result", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      const request = await remote.nextQuery();
      remote.answer(request, SIMPLE_XML, OTHER);
      await remote.barrier();
      expect(api.get(TARGET)).toMatchObject({ status: "pending" });
      remote.answer(request);
      await result(xmpp, TARGET, "verified");
    });
  });

  test("§4: deprecated ext and unknown attributes do not override modern verification", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      remote.peer.send(
        `<presence xmlns="${CLIENT}" from="${TARGET}"><c xmlns="${CAPS}" hash="sha-1" node="${NODE}" ver="${SIMPLE_SHA1}" ext="legacy-bundle" xmlns:future="urn:example:future" future:value="ignored"/></presence>`,
      );
      remote.answer(await remote.nextQuery());
      await result(xmpp, TARGET, "verified");
      expect(remote.queries).toHaveLength(1);
    });
  });
});

describe("XEP-0115 — verified reuse and invalid responses", () => {
  test("§§5.4/8.2: globally reuse a verified hash across JIDs and software nodes", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      remote.advertise();
      remote.answer(await remote.nextQuery());
      await result(xmpp, TARGET, "verified");
      remote.advertise({ jid: OTHER, node: "https://different.test/software" });
      expect(await result(xmpp, OTHER, "verified")).toMatchObject({
        node: "https://different.test/software",
        hash: "sha-1",
        ver: SIMPLE_SHA1,
      });
      await remote.barrier();
      expect(remote.queries).toHaveLength(1);
    });
  });

  test("§5.4: the algorithm is part of a verified cache key", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      remote.advertise();
      remote.answer(await remote.nextQuery());
      await result(xmpp, TARGET, "verified");
      remote.advertise({ jid: OTHER, hash: "sha-256" });
      const second = await remote.nextQuery();
      expect(second.to).toBe(OTHER);
      remote.answer(second);
      await result(xmpp, OTHER, "invalid");
      expect(remote.queries).toHaveLength(2);
    });
  });

  test("§5.4: identical pending hints share discovery, not independent floods", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      remote.advertise();
      const request = await remote.nextQuery();
      remote.advertise();
      remote.advertise({ jid: OTHER });
      await remote.barrier();
      expect(remote.queries).toHaveLength(1);
      remote.answer(request);
      await result(xmpp, TARGET, "verified");
      await result(xmpp, OTHER, "verified");
    });
  });

  test("§5.4: unsupported hash discovery remains per-JID and unverified", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      remote.advertise({ hash: "sha-512" });
      remote.answer(await remote.nextQuery());
      const first = await result(xmpp, TARGET, "unverified");
      expect(first.info?.features).toEqual([...FEATURES]);
      remote.onQuery = (request) => remote.answer(request);
      remote.advertise({ jid: OTHER, hash: "sha-512" });
      await result(xmpp, OTHER, "unverified");
      await remote.barrier();
      expect(remote.queries).toHaveLength(2);
      expect(remote.queries[1].to).toBe(OTHER);
    });
  });

  test("§5.4: mismatch cannot poison a waiting second advertiser", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      remote.advertise();
      const first = await remote.nextQuery();
      remote.advertise({ jid: OTHER });
      await remote.barrier();
      remote.answer(
        first,
        SIMPLE_XML.replace(
          '<feature var="http://jabber.org/protocol/muc"/>',
          "",
        ),
      );
      await result(xmpp, TARGET, "invalid");
      const second = await remote.nextQuery();
      expect(second.to).toBe(OTHER);
      remote.answer(second);
      await result(xmpp, OTHER, "verified");
      expect(remote.queries).toHaveLength(2);
    });
  });

  test.each([
    [
      "duplicate identities",
      SIMPLE_XML.replace(SIMPLE_IDENTITY, SIMPLE_IDENTITY.repeat(2)),
    ],
    [
      "duplicate features",
      SIMPLE_XML.replace(
        "</query>",
        '<feature var="http://jabber.org/protocol/disco#info"/></query>',
      ),
    ],
    [
      "conflicting FORM_TYPE values",
      SIMPLE_XML.replace(
        "</query>",
        '<x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE" type="hidden"><value>one</value><value>two</value></field></x></query>',
      ),
    ],
    ...["", ' type="text-single"'].map((type) => [
      `ordinary field without var${type}`,
      SIMPLE_XML.replace(
        "</query>",
        `<x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:form</value></field><field${type}><value>bad</value></field></x></query>`,
      ),
    ]),
    ...[
      ["ordinary field without var", "<field><value>bad</value></field>"],
      [
        "duplicate field vars",
        '<field var="same"><value>one</value></field><field var="same"><value>two</value></field>',
      ],
      [
        "nested ordinary value",
        '<field var="nested"><value>before<nested/>after</value></field>',
      ],
    ].flatMap(([name, malformed]) => {
      const fixed = '<field type="fixed"><value>description</value></field>';
      return ["before", "after"].map((position) => [
        `${name} with anonymous fixed ${position}`,
        SIMPLE_XML.replace(
          "</query>",
          `<x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:form</value></field>${position === "before" ? fixed + malformed : malformed + fixed}</x></query>`,
        ),
      ]);
    }),
    ...["before", "after"].map((position) => {
      const fixed =
        '<x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:form</value></field><field type="fixed"><value>description</value></field></x>';
      const duplicate =
        '<x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:form</value></field></x>';
      return [
        `duplicate forms with anonymous fixed ${position}`,
        SIMPLE_XML.replace(
          "</query>",
          `${position === "before" ? fixed + duplicate : duplicate + fixed}</query>`,
        ),
      ];
    }),
    [
      "malformed anonymous fixed value",
      SIMPLE_XML.replace(
        "</query>",
        '<x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:form</value></field><field type="fixed"><value>before<nested/>after</value></field></x></query>',
      ),
    ],
  ])(
    "§5.4: malformed supported-hash information is invalid / %s",
    async (_name, payload) => {
      await receivingSession(async (xmpp, remote) => {
        capabilities(xmpp);
        remote.advertise();
        remote.answer(await remote.nextQuery(), payload);
        await result(xmpp, TARGET, "invalid");
        remote.advertise({ jid: OTHER });
        const next = await remote.nextQuery();
        expect(next.to).toBe(OTHER);
        remote.answer(next);
        await result(xmpp, OTHER, "verified");
      });
    },
  );

  test("local boundary: anonymous fixed forms are unverified, never globally reused", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      const payload = SIMPLE_XML.replace(
        "</query>",
        '<x xmlns="jabber:x:data" type="result"><field var="FORM_TYPE" type="hidden"><value>urn:example:form</value></field><field type="fixed"><value>description</value></field></x></query>',
      );
      remote.advertise();
      remote.answer(await remote.nextQuery(), payload);
      const first = await result(xmpp, TARGET, "unverified");
      expect(first.info?.query.getChild("x", "jabber:x:data")).toBeDefined();
      remote.advertise({ jid: OTHER });
      const next = await remote.nextQuery();
      expect(next.to).toBe(OTHER);
      remote.answer(next, payload);
      await result(xmpp, OTHER, "unverified");
    });
  });

  test.each(["IQ error", "timeout"])(
    "request failure is unverified, not a proven bad hash / %s",
    async (failure) => {
      await receivingSession(async (xmpp, remote) => {
        capabilities(xmpp);
        remote.advertise();
        const request = await remote.nextQuery();
        if (failure === "IQ error") {
          remote.peer.send(
            `<iq xmlns="${CLIENT}" type="error" id="${request.id}" from="${TARGET}"><query xmlns="${INFO}" node="${request.node}"/><error type="cancel"><service-unavailable xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>`,
          );
        }
        expect((await result(xmpp, TARGET, "unverified")).error).toBeInstanceOf(
          Error,
        );
      });
    },
  );

  test("local ownership: get snapshots cannot poison another JID's verified cache", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      remote.answer(await remote.nextQuery());
      await result(xmpp, TARGET, "verified");
      const exposed = api.get(TARGET)!;
      expect(exposed.info).toBeDefined();
      exposed.status = "invalid";
      exposed.info!.features.splice(
        0,
        exposed.info!.features.length,
        "urn:poisoned",
      );
      exposed.info!.identities[0].name = "Poisoned";
      exposed.info!.query.c("feature", { var: "urn:poisoned" });
      remote.advertise({ jid: OTHER });
      const verified = await result(xmpp, OTHER, "verified");
      expect(verified.info?.features).toEqual([...FEATURES]);
      expect(verified.info?.identities[0].name).toBe("Exodus 0.9.1");
      expect(
        verified.info?.query
          .getChildren("feature", INFO)
          .map((feature) => feature.attrs.var),
      ).toEqual([...FEATURES]);
      expect(api.get(TARGET)?.status).toBe("verified");
      expect(remote.queries).toHaveLength(1);
    });
  });

  test("§5.4 / XML Namespaces: cached queries retain ancestor prefix bindings without shared trees", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      const request = await remote.nextQuery();
      remote.peer
        .send(`<iq xmlns="${CLIENT}" xmlns:d="${INFO}" from="${TARGET}" type="result" id="${request.id}">
        <d:query node="${request.node}"><d:identity category="client" type="pc" name="Exodus 0.9.1"/>
          ${FEATURES.map((feature) => `<d:feature var="${feature}"/>`).join("")}
        </d:query></iq>`);
      await result(xmpp, TARGET, "verified");
      remote.advertise({ jid: OTHER });
      const cached = await result(xmpp, OTHER, "verified");
      expect(cached.info?.query.getNS()).toBe(INFO);
      expect(
        cached.info?.query
          .getChildren("feature", INFO)
          .map(({ attrs }) => attrs.var),
      ).toEqual([...FEATURES]);
      expect(cached.info?.query.root().attrs["xmlns:d"]).toBe(INFO);
      cached.info!.query.root().attrs["xmlns:d"] = "urn:poisoned";
      expect(api.get(TARGET)?.info?.query.getNS()).toBe(INFO);
      expect(api.get(OTHER)?.info?.query.getNS()).toBe(INFO);
      await remote.barrier();
      expect(remote.queries).toHaveLength(1);
    });
  });

  test("local ownership: capability event snapshots cannot poison get or shared cache", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      xmpp.on("capabilities", (value) => {
        if (value.status === "verified" && value.info) {
          value.info.features.length = 0;
          value.info.query.attrs.node = "poisoned";
        }
      });
      remote.advertise();
      remote.answer(await remote.nextQuery());
      await result(xmpp, TARGET, "verified");
      expect(api.get(TARGET)?.info?.features).toEqual([...FEATURES]);
      expect(api.get(TARGET)?.info?.query.attrs.node).toBe(
        `${NODE}#${SIMPLE_SHA1}`,
      );
      remote.advertise({ jid: OTHER });
      await result(xmpp, OTHER, "verified");
      expect(api.get(OTHER)?.info?.features).toEqual([...FEATURES]);
      expect(remote.queries).toHaveLength(1);
    });
  });
});

describe("XEP-0115 — presence validity and lifecycle", () => {
  test.each([
    [
      "missing hash",
      `<c xmlns="${CAPS}" node="${NODE}" ver="${SIMPLE_SHA1}"/>`,
    ],
    ["missing node", `<c xmlns="${CAPS}" hash="sha-1" ver="${SIMPLE_SHA1}"/>`],
    ["missing ver", `<c xmlns="${CAPS}" hash="sha-1" node="${NODE}"/>`],
    [
      "empty hash",
      `<c xmlns="${CAPS}" hash="" node="${NODE}" ver="${SIMPLE_SHA1}"/>`,
    ],
    [
      "empty node",
      `<c xmlns="${CAPS}" hash="sha-1" node="" ver="${SIMPLE_SHA1}"/>`,
    ],
    ["empty ver", `<c xmlns="${CAPS}" hash="sha-1" node="${NODE}" ver=""/>`],
    [
      "empty HTTP host",
      `<c xmlns="${CAPS}" hash="sha-1" node="https://" ver="${SIMPLE_SHA1}"/>`,
    ],
    [
      "foreign namespace",
      `<c xmlns="urn:foreign" hash="sha-1" node="${NODE}" ver="${SIMPLE_SHA1}"/>`,
    ],
    [
      "nested annotation",
      `<wrapper xmlns="urn:foreign"><c xmlns="${CAPS}" hash="sha-1" node="${NODE}" ver="${SIMPLE_SHA1}"/></wrapper>`,
    ],
    [
      "child content",
      `<c xmlns="${CAPS}" hash="sha-1" node="${NODE}" ver="${SIMPLE_SHA1}"><extra/></c>`,
    ],
    [
      "duplicate annotations",
      `<c xmlns="${CAPS}" hash="sha-1" node="${NODE}" ver="${SIMPLE_SHA1}"/>`.repeat(
        2,
      ),
    ],
  ])(
    "§4: unusable annotation leaves ordinary presence intact / %s",
    async (_name, annotation) => {
      await receivingSession(async (xmpp, remote) => {
        const api = capabilities(xmpp);
        const presence: string[] = [];
        xmpp.on("stanza", (stanza: Element) => {
          if (stanza.is("presence")) {
            presence.push(stanza.attrs.id);
          }
        });
        remote.peer.send(
          `<presence xmlns="${CLIENT}" from="${TARGET}" id="retained">${annotation}</presence>`,
        );
        await remote.barrier();
        expect(presence).toEqual(["retained"]);
        expect(api.get(TARGET)).toBeUndefined();
        expect(remote.queries).toEqual([]);
      });
    },
  );

  test.each([
    "",
    ' xmlns:fake="urn:foreign" fake:from="peer@remote.test/device"',
  ])(
    "§6.2: absent explicit from never falls back to the server / %s",
    async (attributes) => {
      await receivingSession(async (xmpp, remote) => {
        const api = capabilities(xmpp);
        remote.peer.send(
          `<presence xmlns="${CLIENT}"${attributes}><c xmlns="${CAPS}" hash="sha-1" node="${NODE}" ver="${SIMPLE_SHA1}"/></presence>`,
        );
        await remote.barrier();
        expect(remote.queries).toEqual([]);
        expect(api.get("example.test")).toBeUndefined();
        expect(api.get(TARGET)).toBeUndefined();
      });
    },
  );

  test("§6.2 / RFC 7622: malformed explicit from cannot invent a capability target", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.peer.send(
        `<presence xmlns="${CLIENT}" from="peer@"><c xmlns="${CAPS}" hash="sha-1" node="${NODE}" ver="${SIMPLE_SHA1}"/></presence>`,
      );
      await remote.barrier();
      expect(remote.queries).toEqual([]);
      expect(api.get("example.test")).toBeUndefined();
      expect(api.get(TARGET)).toBeUndefined();
    });
  });

  test("§8.4: later presence without c retains the established hint", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      remote.answer(await remote.nextQuery());
      await result(xmpp, TARGET, "verified");
      remote.peer.send(
        `<presence xmlns="${CLIENT}" from="${TARGET}"><show>away</show></presence>`,
      );
      await remote.barrier();
      expect(api.get(TARGET)).toMatchObject({
        status: "verified",
        ver: SIMPLE_SHA1,
      });
      expect(remote.queries).toHaveLength(1);
    });
  });

  test("local presence ownership: unavailable clears only that full JID", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      remote.answer(await remote.nextQuery());
      await result(xmpp, TARGET, "verified");
      remote.advertise({ jid: OTHER });
      await result(xmpp, OTHER, "verified");
      remote.peer.send(
        `<presence xmlns="${CLIENT}" from="${TARGET}" type="unavailable"/>`,
      );
      await remote.barrier();
      expect(api.get(TARGET)).toBeUndefined();
      expect(api.get(OTHER)).toMatchObject({ status: "verified" });
      remote.advertise();
      await result(xmpp, TARGET, "verified");
      expect(remote.queries).toHaveLength(1);
    });
  });

  test("local cancellation: unavailable while discovery is pending cannot be revived by a late reply", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      const verified: string[] = [];
      xmpp.on("capabilities", (value) => {
        if (value.status === "verified") {
          verified.push(value.jid);
        }
      });
      remote.advertise();
      const request = await remote.nextQuery();
      remote.peer.send(
        `<presence xmlns="${CLIENT}" from="${TARGET}" type="unavailable"/>`,
      );
      await remote.barrier();
      expect(api.get(TARGET)).toBeUndefined();
      remote.answer(request);
      await remote.barrier();
      expect(api.get(TARGET)).toBeUndefined();
      expect(verified).toEqual([]);
    });
  });

  test("local cancellation: changed advertisements cannot be overwritten by the previous request", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      const old = await remote.nextQuery();
      remote.advertise({ node: "https://example.test/new", ver: COMPLEX_SHA1 });
      const current = await remote.nextQuery();
      expect(current.node).toBe(`https://example.test/new#${COMPLEX_SHA1}`);
      remote.answer(current, COMPLEX_XML);
      await result(xmpp, TARGET, "verified");
      remote.answer(old);
      await remote.barrier();
      expect(api.get(TARGET)).toMatchObject({
        node: "https://example.test/new",
        ver: COMPLEX_SHA1,
        status: "verified",
      });
      expect(api.get(TARGET)?.info?.identities).toHaveLength(2);
    });
  });

  test("local session isolation: fresh authenticated connection clears old peer hints", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      remote.answer(await remote.nextQuery());
      await result(xmpp, TARGET, "verified");
      const replacement = new ReceivingPeer();
      try {
        await xmpp.disconnect();
        expect(await waitForDisconnect(xmpp)).toBe(true);
        Object.assign(xmpp.options, { service: replacement.peer.url });
        const online = once(xmpp, "online");
        await xmpp.reconnect.reconnect();
        await online;
        expect(api.get(TARGET)).toBeUndefined();
        replacement.advertise();
        await result(xmpp, TARGET, "verified");
        await replacement.barrier();
        expect(replacement.queries).toEqual([]);
        expect(replacement.peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await replacement.peer.stop();
      }
    });
  });

  test("local session isolation: stopped pending work cannot populate a later fresh session", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      const abandoned = await remote.nextQuery();
      await xmpp.stop();
      expect(api.get(TARGET)).toBeUndefined();
      const replacement = new ReceivingPeer();
      try {
        Object.assign(xmpp.options, { service: replacement.peer.url });
        await xmpp.start();
        replacement.answer(abandoned);
        await replacement.barrier();
        expect(api.get(TARGET)).toBeUndefined();
        expect(replacement.queries).toEqual([]);
        replacement.advertise();
        replacement.answer(await replacement.nextQuery());
        await result(xmpp, TARGET, "verified");
        expect(replacement.peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await replacement.peer.stop();
      }
    });
  });
});
