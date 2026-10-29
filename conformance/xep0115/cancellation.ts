/* eslint-disable n/no-unsupported-features/node-builtins -- Tests exercise the supported browser/Bun Web Crypto API. */
import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { client } from "../../src/client/index.js";
import { INFO } from "./fixture.ts";
import {
  FULL_JID,
  OWN_NODE,
  ReceivingPeer,
  TIMEOUT_MS,
  capabilities,
  result,
} from "./receiving-fixture.ts";

const MAX_ACTIVE_JOBS = 4;
const WATCHDOG_MS = TIMEOUT_MS * 3;

// Local work policy: an aborted transport cannot cancel a native digest promise.
// Keep its slot charged until completion, but never publish/cache its stale result.
test("XEP-0115 local work budget: uncancellable old digests remain charged across a fresh connection", async () => {
  const first = new ReceivingPeer();
  const replacement = new ReceivingPeer();
  const xmpp = client({
    service: first.peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
    disco: { identities: [{ category: "client", type: "web", name: "Local" }] },
    caps: { node: OWN_NODE },
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  const staleEvents: string[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("capabilities", (value) => {
    if (value.jid.startsWith("old-") && value.status === "verified") {
      staleEvents.push(value.jid);
    }
  });

  const original = globalThis.crypto.subtle.digest.bind(
    globalThis.crypto.subtle,
  );
  const releases: Array<() => Promise<void>> = [];
  const digestsStarted = Promise.withResolvers<boolean>();
  let hold = true;
  const digest = spyOn(globalThis.crypto.subtle, "digest").mockImplementation(
    (algorithm, input) => {
      // Local advertised hashes remain real; only remote verification is gated.
      if (
        !hold ||
        !new TextDecoder().decode(input).startsWith("client/pc//Remote ")
      ) {
        return original(algorithm, input);
      }
      return new Promise<ArrayBuffer>((resolve, reject) => {
        releases.push(async () => {
          try {
            resolve(await original(algorithm, input));
          } catch (error) {
            reject(error);
          }
        });
        if (releases.length === MAX_ACTIVE_JOBS) {
          digestsStarted.resolve(true);
        }
      });
    },
  );
  const advertisements: Array<{ ver: string; source: string }> = [];
  for (let index = 0; index < MAX_ACTIVE_JOBS * 2; index++) {
    const name = `Remote ${index}`;
    advertisements.push({
      // Independent oracle: one identity and one feature, not production hashing.
      ver: createHash("sha1")
        .update(`client/pc//${name}<${INFO}<`, "utf8")
        .digest("base64"),
      source: `<query xmlns="${INFO}"><identity category="client" type="pc" name="${name}"/><feature var="${INFO}"/></query>`,
    });
  }
  first.onQuery = (request) => {
    const index = Number(request.to!.match(/old-([0-9]+)/)![1]);
    first.answer(request, advertisements[index].source);
  };
  replacement.onQuery = (request) => {
    const index = Number(request.to!.match(/fresh-([0-9]+)/)?.[1]);
    if (Number.isInteger(index)) {
      replacement.answer(
        request,
        advertisements[index + MAX_ACTIVE_JOBS].source,
      );
    }
  };

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(String(await xmpp.start())).toBe(FULL_JID);
    const api = capabilities(xmpp);
    for (let index = 0; index < MAX_ACTIVE_JOBS; index++) {
      first.advertise({
        jid: `old-${index}@remote.test/device`,
        ver: advertisements[index].ver,
      });
    }
    watchdog = setTimeout(() => digestsStarted.resolve(false), WATCHDOG_MS);
    expect(await digestsStarted.promise).toBe(true);
    clearTimeout(watchdog);
    expect(releases).toHaveLength(MAX_ACTIVE_JOBS);
    expect(first.queries).toHaveLength(MAX_ACTIVE_JOBS);

    await xmpp.disconnect();
    Object.assign(xmpp.options, { service: replacement.peer.url });
    const online = once(xmpp, "online");
    await xmpp.reconnect.reconnect();
    await online;
    for (let index = 0; index < MAX_ACTIVE_JOBS; index++) {
      expect(api.get(`old-${index}@remote.test/device`)).toBeUndefined();
      replacement.advertise({
        jid: `fresh-${index}@remote.test/device`,
        ver: advertisements[index + MAX_ACTIVE_JOBS].ver,
      });
    }
    await replacement.barrier();
    // Epoch cancellation must not falsely free four still-retained native jobs.
    expect(replacement.queries).toEqual([]);
    expect(releases).toHaveLength(MAX_ACTIVE_JOBS);
    for (let index = 0; index < MAX_ACTIVE_JOBS; index++) {
      expect(api.get(`fresh-${index}@remote.test/device`)).toMatchObject({
        status: "pending",
      });
    }

    hold = false;
    await Promise.all(releases.splice(0).map((release) => release()));
    for (let index = 0; index < MAX_ACTIVE_JOBS; index++) {
      await result(xmpp, `fresh-${index}@remote.test/device`, "verified");
    }
    expect(replacement.queries).toHaveLength(MAX_ACTIVE_JOBS);
    expect(staleEvents).toEqual([]);
    for (let index = 0; index < MAX_ACTIVE_JOBS; index++) {
      expect(api.get(`old-${index}@remote.test/device`)).toBeUndefined();
    }
    await replacement.barrier();

    // An old digest result must not silently enter the reusable global cache.
    replacement.advertise({
      jid: "retry-old@remote.test/device",
      ver: advertisements[0].ver,
    });
    const retry = await replacement.nextQuery();
    expect(retry.to).toBe("retry-old@remote.test/device");
    replacement.answer(retry, advertisements[0].source);
    await result(xmpp, "retry-old@remote.test/device", "verified");
    expect(replacement.queries).toHaveLength(MAX_ACTIVE_JOBS + 1);
    expect(errors).toEqual([]);
    expect(first.peer.errors).toEqual([]);
    expect(replacement.peer.errors).toEqual([]);
  } finally {
    clearTimeout(watchdog);
    try {
      await xmpp.stop();
    } finally {
      hold = false;
      await Promise.all(releases.splice(0).map((release) => release()));
      digest.mockRestore();
      await Promise.all([first.peer.stop(), replacement.peer.stop()]);
    }
  }
});
