import { describe, expect, test } from "bun:test";
import { client } from "../../src/client/index.js";
import { readFrame } from "../xml.ts";
import {
  INFO,
  ITEMS,
  CONTENT,
  STANZAS,
  TARGET,
  TIMEOUT_MS,
  IDENTITY,
  DEFAULT_INFO,
  discovery,
  incoming,
  nextIq,
  session,
  resultReply,
} from "./fixture.ts";

describe("XEP-0030 — API validation and IQ lifecycle", () => {
  test.each([
    ["empty identities", { identities: [] }],
    ["missing identity category", { identities: [{ type: "web" }] }],
    [
      "unknown hierarchy type",
      { identities: [{ category: "hierarchy", type: "other" }] },
    ],
    [
      "malformed configured item",
      { identities: [IDENTITY], items: [{ jid: "user@" }] },
    ],
    [
      "malformed identity language en_US",
      { identities: [{ ...IDENTITY, lang: "en_US" }] },
    ],
    [
      "malformed identity language with spaces",
      { identities: [{ ...IDENTITY, lang: "not a tag" }] },
    ],
  ])("local configuration policy: reject %s", (_name, disco) => {
    expect(() => client({ domain: "example.test", disco })).toThrow(TypeError);
  });

  test.each(["info", "items"] as const)(
    "local node policy: %s rejects empty node before writing",
    async (kind) => {
      await session(
        async (xmpp, peer) => {
          const api = discovery(xmpp);
          const count = peer.transcript.length;
          const result = await Promise.resolve()
            .then<unknown>(() => api[kind](TARGET, { node: "" }))
            .catch((error: Error) => error);
          expect(result).toBeInstanceOf(TypeError);
          expect(peer.transcript).toHaveLength(count);
        },
        undefined,
        resultReply(DEFAULT_INFO),
      );
    },
  );

  test("local node policy: registry cannot register the empty node", async () => {
    await session(
      async (xmpp, peer) => {
        expect(() =>
          discovery(xmpp).setNode("", { identities: [IDENTITY] }),
        ).toThrow(TypeError);
        expect((await incoming(peer, INFO))[0]).toMatchObject({
          attributes: { "{}type": "result" },
        });
      },
      { identities: [IDENTITY] },
    );
  });

  test("IQ lifecycle: pre-aborted request writes nothing and next request succeeds", async () => {
    await session(
      async (xmpp, peer) => {
        const api = discovery(xmpp);
        const controller = new AbortController();
        controller.abort();
        const count = peer.transcript.length;
        const result = await api
          .info(TARGET, { signal: controller.signal })
          .catch((error: Error) => error);
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).name).toBe("AbortError");
        expect(peer.transcript).toHaveLength(count);
        expect((await api.info(TARGET)).identities).toEqual([IDENTITY]);
      },
      undefined,
      resultReply(DEFAULT_INFO),
    );
  });

  test("IQ lifecycle: abort after write ignores a late result and permits recovery", async () => {
    let calls = 0;
    await session(
      async (xmpp, peer) => {
        const api = discovery(xmpp);
        const controller = new AbortController();
        const pending = api
          .items(TARGET, { signal: controller.signal })
          .catch((error: Error) => error);
        const first = readFrame(await nextIq(peer))[0];
        expect(first).toMatchObject({
          open: `{${CONTENT}}iq`,
          attributes: { "{}type": "get" },
        });
        controller.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            pending,
            new Promise<Error>((resolve) => {
              timer = setTimeout(
                () => resolve(new Error("test watchdog: cancellation ignored")),
                TIMEOUT_MS,
              );
            }),
          ]);
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).name).toBe("AbortError");
          if (!("open" in first)) {
            throw new Error("Expected IQ request");
          }
          peer.send(
            `<iq xmlns="${CONTENT}" type="result" id="${first.attributes["{}id"]}" from="${TARGET}"><query xmlns="${ITEMS}"><item jid="late.example.test"/></query></iq>`,
          );
          expect((await api.items(TARGET)).items).toEqual([]);
          expect(calls).toBe(2);
          expect(xmpp.status).toBe("online");
        } finally {
          clearTimeout(timer);
        }
      },
      undefined,
      (frame, peer) => {
        const root = readFrame(frame)[0];
        if (
          "open" in root &&
          root.open === `{${CONTENT}}iq` &&
          root.attributes["{}type"] === "get"
        ) {
          calls++;
          if (calls === 2) {
            peer.send(
              `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}" from="${TARGET}"><query xmlns="${ITEMS}"/></iq>`,
            );
          }
        }
      },
    );
  });

  test("IQ lifecycle: caller timeout rejects without closing the session", async () => {
    await session(async (xmpp) => {
      const api = discovery(xmpp);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          api.info(TARGET, { timeout: 5 }).catch((error: Error) => error),
          new Promise<Error>((resolve) => {
            timer = setTimeout(
              () => resolve(new Error("test watchdog: timeout ignored")),
              TIMEOUT_MS,
            );
          }),
        ]);
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).name).toBe("TimeoutError");
        expect(xmpp.status).toBe("online");
      } finally {
        clearTimeout(timer);
      }
    });
  });

  test("§7 / RFC 6120 §8.3: stanza denial remains structured and does not poison later requests", async () => {
    let calls = 0;
    await session(
      async (xmpp) => {
        const api = discovery(xmpp);
        const denied = await api.info(TARGET).catch((error: Error) => error);
        expect(denied).toMatchObject({ condition: "forbidden", type: "auth" });
        expect((await api.info(TARGET)).identities).toEqual([IDENTITY]);
      },
      undefined,
      (frame, peer) => {
        const root = readFrame(frame)[0];
        if ("open" in root && root.open === `{${CONTENT}}iq`) {
          calls++;
          peer.send(
            `<iq xmlns="${CONTENT}" type="${calls === 1 ? "error" : "result"}" id="${root.attributes["{}id"]}" from="${TARGET}">${calls === 1 ? `<query xmlns="${INFO}"/><error type="auth"><forbidden xmlns="${STANZAS}"/></error>` : DEFAULT_INFO}</iq>`,
          );
        }
      },
    );
  });
});
