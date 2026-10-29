/* eslint-disable n/no-unsupported-features/node-builtins -- Gate native browser/Bun Web Crypto without changing its digest results. */
import { expect, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { xml } from "../../src/client/index.js";
import { readFrame } from "../xml.ts";
import {
  INITIAL_SHA1,
  EXTRA_SHA1,
  TARGET,
  annotation,
  nextFrame,
  session,
} from "./advertising-fixture.ts";

const WATCHDOG_MS = 1000;

// XEP-0115 §6.1 permits automatic caps refresh, not overwriting the application's
// newer availability. Gate only scheduling; hashing and all wire I/O stay real.
test.each(["refresh waiting", "newer presence waiting"] as const)(
  "XEP-0115 local presence ownership: newer availability supersedes stale automatic refresh / %s",
  async (window) => {
    await session(async (xmpp, peer) => {
      await xmpp.send(
        xml("presence", { id: "old" }, xml("status", {}, "Old status")),
      );
      expect(
        annotation(await nextFrame(peer, "presence", "old"))["{}ver"],
      ).toBe(INITIAL_SHA1);
      const before = peer.transcript.length;
      const original = globalThis.crypto.subtle.digest.bind(
        globalThis.crypto.subtle,
      );
      const entered = Promise.withResolvers<boolean>();
      const release = Promise.withResolvers<void>();
      let holding = true;
      const digest = spyOn(
        globalThis.crypto.subtle,
        "digest",
      ).mockImplementation((algorithm, input) => {
        if (!holding) {
          return original(algorithm, input);
        }
        entered.resolve(true);
        return release.promise.then(() => original(algorithm, input));
      });
      let latest: Promise<unknown> | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        if (window === "newer presence waiting") {
          latest = xmpp.send(
            xml("presence", { id: "latest" }, xml("status", {}, "New status")),
          );
        }
        xmpp.disco.addFeature("urn:example:extra");
        watchdog = setTimeout(() => entered.resolve(false), WATCHDOG_MS);
        expect(await entered.promise).toBe(true);
        clearTimeout(watchdog);
        // The refresh microtask was queued before this continuation. Its digest
        // is still held; both windows retain the old broadcast on the wire.
        expect(peer.transcript.length).toBe(before);
        if (window === "refresh waiting") {
          latest = xmpp.send(
            xml("presence", { id: "latest" }, xml("status", {}, "New status")),
          );
        }
        holding = false;
        release.resolve();
        await latest;
        // Drain the completed digest's continuations before the wire barrier.
        await setImmediate();
        await xmpp.send(
          xml("presence", { to: TARGET, id: "availability-barrier" }),
        );
        await nextFrame(peer, "presence", "availability-barrier");
        const presences = peer.transcript
          .slice(before)
          .filter((frame) => frame.startsWith("<presence"));
        // A stale refresh must fail this exact wire assertion, not a timeout.
        expect(
          presences.map((frame) => {
            const root = readFrame(frame)[0];
            return "open" in root ? root.attributes["{}id"] : undefined;
          }),
        ).toEqual(["latest", "availability-barrier"]);
        expect(annotation(presences[0])["{}ver"]).toBe(EXTRA_SHA1);
        expect(annotation(presences[1])["{}ver"]).toBe(EXTRA_SHA1);
        expect(readFrame(presences[0])).toContainEqual({ text: "New status" });
        expect(readFrame(presences[0])).not.toContainEqual({
          text: "Old status",
        });
      } finally {
        clearTimeout(watchdog);
        holding = false;
        release.resolve();
        digest.mockRestore();
        await latest?.catch(() => {});
      }
    });
  },
);

// Local cancellation policy: once a newer manual intent exists, an automatic
// refresh still waiting in preparation must not write. This is not an RFC claim
// that every intermediate availability update is forbidden.
test("XEP-0115 local superseded-auto cancellation: newer availability supersedes stale automatic refresh / automatic preparer waiting", async () => {
  await session(async (xmpp, peer) => {
    await xmpp.send(
      xml("presence", { id: "old" }, xml("status", {}, "Old status")),
    );
    expect(annotation(await nextFrame(peer, "presence", "old"))["{}ver"]).toBe(
      INITIAL_SHA1,
    );
    const before = peer.transcript.length;
    const original = xmpp.send.bind(xmpp);
    const entered = Promise.withResolvers<boolean>();
    let intercepted = false;
    let latest: Promise<unknown> | undefined;
    const send = spyOn(xmpp, "send").mockImplementation((element, ...args) => {
      // Delegate first: automatic preparation reaches its awaited real digest
      // before the application's newer presence changes the current revision.
      const sending = original(element, ...args);
      if (
        !intercepted &&
        element.is("presence") &&
        element.attrs.id === "old"
      ) {
        intercepted = true;
        latest = original(
          xml("presence", { id: "latest" }, xml("status", {}, "New status")),
        );
        entered.resolve(true);
      }
      return sending;
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      xmpp.disco.addFeature("urn:example:extra");
      watchdog = setTimeout(() => entered.resolve(false), WATCHDOG_MS);
      expect(await entered.promise).toBe(true);
      clearTimeout(watchdog);
      expect(latest).toBeDefined();
      await latest;
      await setImmediate();
      await xmpp.send(
        xml("presence", { to: TARGET, id: "availability-barrier" }),
      );
      await nextFrame(peer, "presence", "availability-barrier");
      const presences = peer.transcript
        .slice(before)
        .filter((frame) => frame.startsWith("<presence"));
      expect(
        presences.map((frame) => {
          const root = readFrame(frame)[0];
          return "open" in root ? root.attributes["{}id"] : undefined;
        }),
      ).toEqual(["latest", "availability-barrier"]);
      expect(annotation(presences[0])["{}ver"]).toBe(EXTRA_SHA1);
      expect(readFrame(presences[0])).toContainEqual({ text: "New status" });
      expect(readFrame(presences[0])).not.toContainEqual({
        text: "Old status",
      });
    } finally {
      clearTimeout(watchdog);
      send.mockRestore();
      await latest?.catch(() => {});
    }
  });
});
