import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Element } from "../../types/index.js";
import { INFO, SIMPLE_SHA1, SIMPLE_XML } from "./fixture.ts";
import {
  NODE,
  TARGET,
  CAPS,
  capabilities,
  receivingSession,
  result,
} from "./receiving-fixture.ts";

// Approved local limits, not XEP-0115 protocol maxima or heap measurements.
const MAX_ACTIVE_QUERIES = 4;
const MAX_JOBS = 64;
const MAX_HINTS = 128;
const MAX_HINT_BYTES = 64 * 1024;
const MAX_RECORDS = 128;
const LARGE_RECORD_BYTES = 80 * 1024;

describe("XEP-0115 — local receiver resource policies", () => {
  test.each(["node", "ver", "hash"] as const)(
    "64 KiB hint metadata policy: oversized %s is ignored without dropping ordinary presence",
    async (field) => {
      await receivingSession(async (xmpp, remote) => {
        const api = capabilities(xmpp);
        const received: Element[] = [];
        xmpp.on("stanza", (element: Element) => {
          if (element.is("presence") && element.attrs.from === TARGET) {
            received.push(element);
          }
        });
        const oversized = "x".repeat(MAX_HINT_BYTES);
        const hint = {
          node: field === "node" ? `urn:example:${oversized}` : NODE,
          ver: field === "ver" ? oversized : SIMPLE_SHA1,
          hash: field === "hash" ? oversized : "sha-1",
        };
        remote.advertise(hint);
        await remote.barrier();
        expect(received).toHaveLength(1);
        expect(received[0].getChild("c", CAPS)?.attrs[field]).toBe(hint[field]);
        // Boolean avoids dumping attacker-sized strings when the policy is absent.
        expect(Boolean(api.get(TARGET))).toBe(false);
        expect(remote.queries).toHaveLength(0);
      });
    },
  );

  test("64 KiB aggregate hint metadata: UTF-8 charges evict oldest aliases before count exhaustion", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      remote.answer(await remote.nextQuery());
      await result(xmpp, TARGET, "verified");
      const encoder = new TextEncoder();
      const retained = [
        {
          jid: TARGET,
          node: NODE,
          ver: SIMPLE_SHA1,
          hash: "sha-1",
        },
      ];
      let charged = encoder.encode(
        JSON.stringify([TARGET, NODE, SIMPLE_SHA1, "sha-1"]),
      ).length;
      const advertised = [];
      for (let index = 0; index < 16; index++) {
        const hint = {
          jid: `metadata-${index}@remote.test/device`,
          // Each é is two UTF-8 octets: a UTF-16-length budget is insufficient.
          node: `urn:example:${"é".repeat(4096)}:${index}`,
          ver: SIMPLE_SHA1,
          hash: "sha-1",
        };
        const bytes = encoder.encode(
          JSON.stringify([hint.jid, hint.node, hint.ver, hint.hash]),
        ).length;
        while (charged + bytes > MAX_HINT_BYTES) {
          const oldest = retained.shift()!;
          charged -= encoder.encode(
            JSON.stringify([oldest.jid, oldest.node, oldest.ver, oldest.hash]),
          ).length;
        }
        retained.push(hint);
        charged += bytes;
        advertised.push(hint);
        remote.advertise(hint);
      }
      await remote.barrier();
      expect(retained).toHaveLength(7);
      expect(charged).toBeLessThanOrEqual(MAX_HINT_BYTES);
      expect(api.get(TARGET)).toBeUndefined();
      const expected = new Set(retained.map((hint) => hint.jid));
      const present = advertised.filter(
        (hint) => api.get(hint.jid) !== undefined,
      );
      expect(present.map((hint) => hint.jid)).toEqual([...expected]);
      for (const hint of retained) {
        expect(api.get(hint.jid)).toMatchObject({
          status: "verified",
          node: hint.node,
        });
      }
      expect(remote.queries).toHaveLength(1);
    });
  });

  test("128 peer hints: shared verified hash avoids a query flood after eviction", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      remote.advertise();
      remote.answer(await remote.nextQuery());
      expect((await result(xmpp, TARGET, "verified")).info).toBeDefined();
      for (let index = 0; index < MAX_HINTS + 1; index++) {
        remote.advertise({ jid: `shared-${index}@remote.test/device` });
      }
      await remote.barrier();
      expect(remote.queries).toHaveLength(1);
      expect(api.get(TARGET)).toBeUndefined();
      expect(api.get("shared-0@remote.test/device")).toBeUndefined();
      for (let index = 1; index < MAX_HINTS + 1; index++) {
        expect(api.get(`shared-${index}@remote.test/device`)).toMatchObject({
          status: "verified",
          ver: SIMPLE_SHA1,
          info: expect.anything(),
        });
      }
      // The hint limit must not destroy an independently reusable verified record.
      remote.advertise();
      await remote.barrier();
      expect(api.get(TARGET)?.status).toBe("verified");
      expect(remote.queries).toHaveLength(1);
    });
  });

  test("four active queries and 64 total jobs: overflow is explicit; settlement admits the next job", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      const peerCount = 80;
      for (let index = 0; index < peerCount; index++) {
        remote.advertise({
          jid: `queued-${index}@remote.test/device`,
          hash: "future-hash",
          ver: `distinct-${index}`,
        });
      }
      await remote.barrier();
      expect(remote.queries).toHaveLength(MAX_ACTIVE_QUERIES);
      expect(remote.queries.map((query) => query.to)).toEqual(
        Array.from(
          { length: MAX_ACTIVE_QUERIES },
          (_, index) => `queued-${index}@remote.test/device`,
        ),
      );
      for (let index = 0; index < MAX_JOBS; index++) {
        expect(api.get(`queued-${index}@remote.test/device`)).toMatchObject({
          status: "pending",
        });
      }
      for (let index = MAX_JOBS; index < peerCount; index++) {
        expect(api.get(`queued-${index}@remote.test/device`)).toMatchObject({
          status: "unverified",
          error: expect.any(Error),
        });
        expect(
          api.get(`queued-${index}@remote.test/device`)?.info,
        ).toBeUndefined();
      }
      remote.answer(remote.queries[0]);
      expect(
        (await result(xmpp, "queued-0@remote.test/device", "unverified")).info,
      ).toBeDefined();
      // A round trip barriers settlement; an absent query fails an assertion.
      await remote.barrier();
      expect(remote.queries).toHaveLength(MAX_ACTIVE_QUERIES + 1);
      expect(remote.queries.at(-1)?.to).toBe(
        `queued-${MAX_ACTIVE_QUERIES}@remote.test/device`,
      );
      expect(api.get("queued-79@remote.test/device")?.status).toBe(
        "unverified",
      );
    });
  });

  test("one MiB serialized cache: large unverified records evict information without losing peer hints", async () => {
    await receivingSession(async (xmpp, remote) => {
      const api = capabilities(xmpp);
      const payload = "x".repeat(LARGE_RECORD_BYTES);
      const source = SIMPLE_XML.replace(
        "</query>",
        `<metadata xmlns="urn:example:cache-limit">${payload}</metadata></query>`,
      );
      // Sixteen records exceed the byte budget while staying below record/hint limits.
      for (let index = 0; index < 16; index++) {
        const address = `large-${index}@remote.test/device`;
        remote.advertise({
          jid: address,
          hash: "future-hash",
          ver: `large-${index}`,
        });
        remote.answer(await remote.nextQuery(), source);
        const stored = await result(xmpp, address, "unverified");
        expect(stored.info).toBeDefined();
        expect(stored.error).toBeUndefined();
      }
      await remote.barrier();
      expect(remote.queries).toHaveLength(16);
      const evicted = api.get("large-0@remote.test/device");
      expect(evicted).toMatchObject({
        status: "unverified",
        error: expect.any(Error),
      });
      expect(evicted?.info).toBeUndefined();
      for (let index = 0; index < 16; index++) {
        const cached = api.get(`large-${index}@remote.test/device`);
        expect(cached?.status).toBe("unverified");
        if (index < 4) {
          expect(cached?.info).toBeUndefined();
          expect(cached?.error).toBeInstanceOf(Error);
        } else {
          expect(cached?.info).toBeDefined();
          expect(cached?.error).toBeUndefined();
        }
      }
      const last = api.get("large-15@remote.test/device");
      expect(last?.status).toBe("unverified");
      expect(last?.error).toBeUndefined();
      expect(
        last?.info?.query
          .getChild("metadata", "urn:example:cache-limit")
          ?.getText(),
      ).toBe(payload);
    });
  });

  test("128 records: distinct independently hashed snapshots evict the oldest reusable digest", async () => {
    await receivingSession(async (xmpp, remote) => {
      capabilities(xmpp);
      const digests: string[] = [];
      for (let index = 0; index < MAX_RECORDS + 1; index++) {
        const name = `Unique ${index}`;
        // Independent one-identity/one-feature oracle; no production canonicalizer.
        const canonical = `client/pc//${name}<${INFO}<`;
        const ver = createHash("sha1")
          .update(canonical, "utf8")
          .digest("base64");
        digests.push(ver);
        remote.advertise({ ver });
        remote.answer(
          await remote.nextQuery(),
          `<query xmlns="${INFO}"><identity category="client" type="pc" name="${name}"/><feature var="${INFO}"/></query>`,
        );
        expect(
          (await result(xmpp, TARGET, "verified")).info?.identities[0].name,
        ).toBe(name);
      }
      const count = remote.queries.length;
      // The newest record remains globally reusable without another request.
      remote.advertise({
        jid: "newest@remote.test/device",
        ver: digests.at(-1)!,
      });
      await remote.barrier();
      expect(remote.queries).toHaveLength(count);
      expect(capabilities(xmpp).get("newest@remote.test/device")?.status).toBe(
        "verified",
      );
      // Re-querying the oldest digest proves record eviction, not just hint eviction.
      remote.advertise({ jid: "oldest@remote.test/device", ver: digests[0] });
      await remote.barrier();
      expect(remote.queries).toHaveLength(count + 1);
      const request = remote.queries.at(-1)!;
      expect(request.to).toBe("oldest@remote.test/device");
      expect(request.node).toBe(`${NODE}#${digests[0]}`);
      expect(capabilities(xmpp).get("oldest@remote.test/device")?.status).toBe(
        "pending",
      );
    });
  });
});
