import { describe, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { client, xml } from "../../src/client/index.js";
import { ScriptedPeer, waitForDisconnect } from "../peer.ts";
import { readFrame } from "../xml.ts";
import { INFO, SIMPLE_XML, SIMPLE_SHA1, COMPLEX_XML } from "./fixture.ts";
import {
  CAPS,
  CLIENT,
  FRAMING,
  STREAM,
  SASL,
  BIND,
  PING,
  NODE,
  OWN_NODE,
  TARGET,
  OTHER,
  FULL_JID,
  TIMEOUT_MS,
  result,
} from "./receiving-fixture.ts";
import {
  IDENTITY,
  INITIAL_SHA1,
  EXTRA_SHA1,
  annotation,
  query,
} from "./advertising-fixture.ts";

const SM = "urn:xmpp:sm:3";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const OLD_SESSION = "caps-session-before-loss";
const NEW_SESSION = "caps-session-after-failed-resume";
const WATCHDOG_MS = TIMEOUT_MS * 3;
type Mode = "initial" | "resume" | "fresh";
interface Request {
  id: string;
  to: string;
  node: string;
}

// An SM peer with literal authentication/binding/resumption responses. The handled
// count comes from observed client stanzas, never a manually injected client SM-ID.
class ManagedPeer {
  readonly peer: ScriptedPeer;
  readonly queries: Request[] = [];
  stanzas = 0;
  readonly #observers = new Set<() => void>();
  #barrierId = 0;

  constructor(mode: Mode, handled = 0) {
    let authenticated = false;
    let managed = false;
    this.peer = new ScriptedPeer((frame, remote) => {
      const events = readFrame(frame);
      const root = events[0];
      if (!("open" in root)) {
        throw new Error("Expected client element");
      }
      if (
        managed &&
        ["iq", "presence", "message"].some(
          (name) => root.open === `{${CLIENT}}${name}`,
        )
      ) {
        this.stanzas++;
      }
      if (root.open === `{${FRAMING}}open`) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="caps-${mode}"/>`,
        );
        remote.send(
          `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
        );
      } else if (root.open === `{${SASL}}auth`) {
        authenticated = true;
        remote.send(`<success xmlns="${SASL}"/>`);
      } else if (root.open === `{${SM}}resume`) {
        if (mode === "resume") {
          managed = true;
          this.stanzas = handled;
          remote.send(
            `<resumed xmlns="${SM}" previd="${OLD_SESSION}" h="${handled}"/>`,
          );
        } else {
          remote.send(
            `<failed xmlns="${SM}" h="${handled}"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></failed>`,
          );
        }
      } else if (root.open === `{${SM}}enable`) {
        managed = true;
        this.stanzas = 0;
        remote.send(
          `<enabled xmlns="${SM}" resume="true" id="${mode === "initial" ? OLD_SESSION : NEW_SESSION}"/>`,
        );
      } else if (root.open === `{${CLIENT}}iq`) {
        if (
          events.some(
            (event) => "open" in event && event.open === `{${BIND}}bind`,
          )
        ) {
          remote.send(
            `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${mode === "fresh" ? "user@example.test/fresh" : FULL_JID}</jid></bind></iq>`,
          );
        } else if (root.attributes["{}type"] === "get") {
          const query = events.find(
            (event) => "open" in event && event.open === `{${INFO}}query`,
          );
          if (query && "open" in query) {
            this.queries.push({
              id: root.attributes["{}id"],
              to: root.attributes["{}to"],
              node: query.attributes["{}node"],
            });
          }
        }
      } else if (root.open === `{${FRAMING}}close`) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
      for (const observe of this.#observers) {
        observe();
      }
    });
  }

  // Missing effects fail an assertion with a bounded observer, not a test timeout.
  async #observe<T>(read: () => T | undefined): Promise<T> {
    const current = read();
    if (current !== undefined) {
      return current;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: () => void;
    const value = await new Promise<T | undefined>((resolve) => {
      listener = () => {
        const value = read();
        if (value !== undefined) {
          resolve(value);
        }
      };
      this.#observers.add(listener);
      timer = setTimeout(() => resolve(read()), WATCHDOG_MS);
    }).finally(() => {
      clearTimeout(timer);
      this.#observers.delete(listener);
    });
    expect(value).toBeDefined();
    return value!;
  }

  frame(name: string, id?: string, occurrence = 0): Promise<string> {
    return this.#observe(
      () =>
        this.peer.transcript.filter((frame) => {
          const root = readFrame(frame)[0];
          return (
            "open" in root &&
            root.open === `{${CLIENT}}${name}` &&
            (id === undefined || root.attributes["{}id"] === id)
          );
        })[occurrence],
    );
  }

  nextQuery(index = 0): Promise<Request> {
    return this.#observe(() => this.queries[index]);
  }

  advertise(address = TARGET) {
    this.peer.send(
      `<presence xmlns="${CLIENT}" from="${address}"><c xmlns="${CAPS}" node="${NODE}" hash="sha-1" ver="${SIMPLE_SHA1}"/></presence>`,
    );
  }

  answer(request: Request, source = SIMPLE_XML) {
    const payload = source
      .replace(/ node="[^"]*"/, "")
      .replace("<query ", `<query node="${request.node}" `);
    this.peer.send(
      `<iq xmlns="${CLIENT}" type="result" from="${request.to}" id="${request.id}">${payload}</iq>`,
    );
  }

  async barrier() {
    const id = `caps-lifecycle-barrier-${++this.#barrierId}`;
    this.peer.send(
      `<iq xmlns="${CLIENT}" type="get" id="${id}" from="example.test"><ping xmlns="${PING}"/></iq>`,
    );
    expect(readFrame(await this.frame("iq", id))[0]).toMatchObject({
      attributes: { "{}type": "result" },
    });
  }
}

interface ManagedSession {
  xmpp: ReturnType<typeof client>;
  first: ManagedPeer;
  online: string[];
  replace(mode: "resume" | "fresh", handled: number): Promise<ManagedPeer>;
}

async function session(
  exercise: (session: ManagedSession) => Promise<void>,
  expectedError?: "system-shutdown",
) {
  const first = new ManagedPeer("initial");
  const peers = [first];
  const xmpp = client({
    service: first.peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
    disco: { identities: [IDENTITY] },
    caps: { node: OWN_NODE },
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  const online: string[] = [];
  const errors: (Error & { condition?: string })[] = [];
  const initial = Promise.withResolvers<boolean>();
  let replacement: ReturnType<typeof Promise.withResolvers<string>> | undefined;
  xmpp.on("online", (address) => online.push(address.toString()));
  xmpp.on("nonza", (element) => {
    if (element.is("enabled", SM)) {
      if (replacement) {
        replacement.resolve("enabled");
      } else {
        initial.resolve(true);
      }
    }
  });
  xmpp.streamManagement.on("resumed", () => replacement?.resolve("resumed"));
  xmpp.on("error", (error: Error) => {
    errors.push(error);
    replacement?.resolve("error");
  });
  xmpp.on("close", () => replacement?.resolve("closed"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(String(await xmpp.start())).toBe(FULL_JID);
    timer = setTimeout(() => initial.resolve(false), WATCHDOG_MS);
    expect(await initial.promise).toBe(true);
    clearTimeout(timer);
    await setImmediate();
    expect(xmpp.streamManagement.enabled).toBe(true);
    expect(xmpp.streamManagement.id).toBe(OLD_SESSION);
    await exercise({
      xmpp,
      first,
      online,
      replace: async (mode, handled) => {
        const next = new ManagedPeer(mode, handled);
        peers.push(next);
        Object.assign(xmpp.options, { service: next.peer.url });
        replacement = Promise.withResolvers<string>();
        timer = setTimeout(() => replacement?.resolve("timeout"), WATCHDOG_MS);
        await xmpp.reconnect
          .reconnect()
          .catch(() => replacement?.resolve("error"));
        const outcome = await replacement.promise;
        clearTimeout(timer);
        replacement = undefined;
        await setImmediate();
        expect(outcome).toBe(mode === "resume" ? "resumed" : "enabled");
        expect(xmpp.status).toBe("online");
        expect(xmpp.jid?.toString()).toBe(
          mode === "resume" ? FULL_JID : "user@example.test/fresh",
        );
        const resume = next.peer.transcript.find((frame) => {
          const root = readFrame(frame)[0];
          return "open" in root && root.open === `{${SM}}resume`;
        });
        expect(resume).toBeDefined();
        expect(readFrame(resume!)[0]).toMatchObject({
          open: `{${SM}}resume`,
          attributes: {
            "{}previd": OLD_SESSION,
            "{}h": expect.stringMatching(/^\d+$/),
          },
        });
        const names = next.peer.transcript
          .map((frame) => readFrame(frame)[0])
          .flatMap((root) => ("open" in root ? [root.open] : []));
        expect(
          names
            .filter((name) =>
              [
                `{${FRAMING}}open`,
                `{${SASL}}auth`,
                `{${SM}}resume`,
                `{${SM}}enable`,
                `{${CLIENT}}iq`,
              ].includes(name),
            )
            .slice(0, mode === "resume" ? 4 : 6),
        ).toEqual([
          `{${FRAMING}}open`,
          `{${SASL}}auth`,
          `{${FRAMING}}open`,
          `{${SM}}resume`,
          ...(mode === "fresh" ? [`{${CLIENT}}iq`, `{${SM}}enable`] : []),
        ]);
        return next;
      },
    });
    expect(errors.map((error) => error.condition)).toEqual(
      expectedError ? [expectedError] : [],
    );
    for (const remote of peers) {
      expect(remote.peer.errors).toEqual([]);
    }
  } finally {
    clearTimeout(timer);
    await xmpp.stop();
    await Promise.all(peers.map((remote) => remote.peer.stop()));
  }
}

// XEP-0115 v1.6.0 §8.2 and XEP-0198 v1.6.3 §5. Session ownership and
// cancellation are local policy; a verified content hash is not peer authentication.
describe("XEP-0115 — stream-management lifecycle", () => {
  test("§8.2 / XEP-0198 §5: verified hints survive actual resumption without a new online event or initial presence", async () => {
    await session(async ({ xmpp, first, online, replace }) => {
      first.advertise();
      first.answer(await first.nextQuery());
      await result(xmpp, TARGET, "verified");
      await first.barrier();
      first.peer.terminate();
      expect(await waitForDisconnect(xmpp)).toBe(true);
      expect(xmpp.caps.get(TARGET)?.status).toBe("verified");
      const next = await replace("resume", first.stanzas);
      expect(online).toEqual([FULL_JID]);
      expect(xmpp.caps.get(TARGET)?.status).toBe("verified");
      next.advertise(OTHER);
      await result(xmpp, OTHER, "verified");
      await next.barrier();
      expect(next.queries).toEqual([]);
      expect(
        next.peer.transcript.some((frame) => frame.startsWith("<presence")),
      ).toBe(false);
    });
  });

  test("local cancellation: pending lookup restarts after SM resume and old IQ replies cannot overwrite it", async () => {
    await session(async ({ xmpp, first, online, replace }) => {
      first.advertise();
      const old = await first.nextQuery();
      expect(xmpp.caps.get(TARGET)?.status).toBe("pending");
      first.peer.terminate();
      expect(await waitForDisconnect(xmpp)).toBe(true);
      expect(xmpp.caps.get(TARGET)?.status).toBe("pending");
      const next = await replace("resume", first.stanzas);
      const restarted = await next.nextQuery();
      expect(restarted).toMatchObject({
        to: TARGET,
        node: `${NODE}#${SIMPLE_SHA1}`,
      });
      expect(restarted.id).not.toBe(old.id);
      next.answer(old, COMPLEX_XML);
      await next.barrier();
      expect(xmpp.caps.get(TARGET)?.status).toBe("pending");
      next.answer(restarted);
      await result(xmpp, TARGET, "verified");
      next.answer(old, COMPLEX_XML);
      await next.barrier();
      expect(xmpp.caps.get(TARGET)).toMatchObject({
        status: "verified",
        ver: SIMPLE_SHA1,
        info: {
          identities: [
            { category: "client", type: "pc", name: "Exodus 0.9.1" },
          ],
        },
      });
      expect(next.queries).toHaveLength(1);
      expect(online).toEqual([FULL_JID]);
    });
  });

  test("§6.1 / XEP-0198 §5: replay retains original caps before refreshing changed app-owned presence", async () => {
    await session(async ({ xmpp, first, online, replace }) => {
      await xmpp.send(
        xml(
          "presence",
          { id: "owned" },
          xml("show", {}, "away"),
          xml("status", {}, "Lunch"),
        ),
      );
      const original = await first.frame("presence", "owned");
      expect(annotation(original)["{}ver"]).toBe(INITIAL_SHA1);
      expect(first.stanzas).toBe(1);
      first.peer.terminate();
      expect(await waitForDisconnect(xmpp)).toBe(true);
      xmpp.disco.addFeature("urn:example:extra");
      const next = await replace("resume", 0);
      const replay = await next.frame("presence", "owned");
      expect(replay).toBe(original);
      expect(annotation(replay)["{}ver"]).toBe(INITIAL_SHA1);
      const refresh = await next.frame("presence", "owned", 1);
      expect(annotation(refresh)["{}ver"]).toBe(EXTRA_SHA1);
      expect(readFrame(refresh)).toContainEqual({ text: "Lunch" });
      expect(readFrame(refresh)).toContainEqual({ text: "away" });
      const oldInfo = await query(
        next.peer,
        INFO,
        `${OWN_NODE}#${INITIAL_SHA1}`,
      );
      const newInfo = await query(next.peer, INFO, `${OWN_NODE}#${EXTRA_SHA1}`);
      expect(oldInfo[0]).toMatchObject({ attributes: { "{}type": "result" } });
      expect(newInfo[0]).toMatchObject({ attributes: { "{}type": "result" } });
      const extra = {
        open: `{${INFO}}feature`,
        attributes: { "{}var": "urn:example:extra" },
      };
      expect(oldInfo).not.toContainEqual(extra);
      expect(newInfo).toContainEqual(extra);
      expect(
        next.peer.transcript.filter((frame) => frame.startsWith("<presence")),
      ).toHaveLength(2);
      expect(online).toEqual([FULL_JID]);
    });
  });

  test("local fresh-session isolation: shutdown plus refused SM resume clears aliases but retains verified shared data", async () => {
    await session(async ({ xmpp, first, online, replace }) => {
      first.advertise();
      first.answer(await first.nextQuery());
      await result(xmpp, TARGET, "verified");
      await first.barrier();
      first.peer.send(
        `<error xmlns="${STREAM}"><system-shutdown xmlns="${ERRORS}"/></error>`,
      );
      expect(await waitForDisconnect(xmpp)).toBe(true);
      const next = await replace("fresh", first.stanzas);
      expect(online).toEqual([FULL_JID, "user@example.test/fresh"]);
      expect(xmpp.caps.get(TARGET)).toBeUndefined();
      next.advertise(OTHER);
      await result(xmpp, OTHER, "verified");
      await next.barrier();
      expect(next.queries).toEqual([]);
      expect(xmpp.caps.get(TARGET)).toBeUndefined();
      expect(
        next.peer.transcript.some((frame) => frame.startsWith("<presence")),
      ).toBe(false);
    }, "system-shutdown");
  });
});
