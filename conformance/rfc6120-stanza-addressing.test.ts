import { expect, test } from "bun:test";
import { once } from "node:events";
import { client, jid, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CLIENT = "jabber:client";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const EXTENSION = "urn:test:stanza-addressing";
const DOMAIN = "example.test";
const ACCOUNT = "élise@example.test";
const ANONYMOUS_ACCOUNT = "anon-91@example.test";
const FORMER_ACCOUNT = "former@example.test";
const RESOURCE = "server-resource";
const TIMEOUT_MS = 500;
const KINDS = ["iq", "message", "presence"] as const;
const SEND_METHODS = ["send", "sendMany"] as const;
const PROTOCOLS = ["sasl", "sasl2", "anonymous"] as const;
type Protocol = (typeof PROTOCOLS)[number];
type Phase = "authentication" | "binding" | "ready" | "resumption";
type Kind = (typeof KINDS)[number];
type SendMethod = (typeof SEND_METHODS)[number];
type XMPPClient = ReturnType<typeof client>;
type Context = {
  name: string;
  id: string;
  from: { toString(): string } | null;
  to: { toString(): string } | null;
  local: string;
  stanza: { attrs: Record<string, string> };
};
type Address = {
  from: string | null;
  to: string | null;
  local: string;
  rawFrom: string | undefined;
  rawTo: string | undefined;
};

// Literal server identities deliberately differ from the configured username.
function addressingPeer(protocol: Protocol, phase: Phase, account: string) {
  const paused = Promise.withResolvers<void>();
  let authenticated = false;
  let bindingId: string | undefined;
  let managed = false;
  let outbound = 0;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="${DOMAIN}" id="addressing" version="1.0" xml:lang="en"/>`,
      );
      if (authenticated) {
        offerBinding();
      } else {
        const ns = protocol === "sasl2" ? SASL2 : SASL;
        const feature = protocol === "sasl2" ? "authentication" : "mechanisms";
        const mechanism = protocol === "anonymous" ? "ANONYMOUS" : "PLAIN";
        const inline =
          protocol === "sasl2" && phase === "resumption"
            ? `<inline><sm xmlns="${SM}"/><bind xmlns="${BIND2}"><inline><feature var="${SM}"/></inline></bind></inline>`
            : "";
        remote.send(
          `<features xmlns="${STREAM}"><${feature} xmlns="${ns}"><mechanism>${mechanism}</mechanism>${inline}</${feature}></features>`,
        );
      }
    } else if (
      root.open === `{${SASL}}auth` ||
      root.open === `{${SASL2}}authenticate`
    ) {
      if (phase === "authentication") {
        paused.resolve();
      } else if (protocol === "sasl2" && phase === "resumption") {
        authenticated = true;
        managed = true;
        const resuming = readFrame(frame).some(
          (event) => "open" in event && event.open === `{${SM}}resume`,
        );
        remote.send(
          `<success xmlns="${SASL2}"><authorization-identifier>${account}/${RESOURCE}</authorization-identifier>${resuming ? `<resumed xmlns="${SM}" previd="address-session" h="0"/>` : `<bound xmlns="${BIND2}"><enabled xmlns="${SM}" id="address-session" resume="true"/></bound>`}</success>`,
        );
      } else {
        succeed();
      }
    } else if (root.open === `{${CLIENT}}iq` && frame.includes(BIND)) {
      bindingId = root.attributes["{}id"];
      if (phase === "binding") {
        paused.resolve();
      } else {
        finishBinding();
      }
    } else if (root.open === `{${SM}}enable`) {
      managed = true;
      remote.send(
        `<enabled xmlns="${SM}" id="address-session" resume="true"/>`,
      );
    } else if (root.open === `{${SM}}resume`) {
      managed = true;
      remote.send(`<resumed xmlns="${SM}" previd="address-session" h="0"/>`);
    } else if (root.open === `{${SM}}r`) {
      remote.send(`<a xmlns="${SM}" h="${outbound}"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    } else if (managed && root.open.startsWith(`{${CLIENT}}`)) {
      outbound += 1;
    }
  });

  function offerBinding() {
    peer.send(
      `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/>${phase === "resumption" ? `<sm xmlns="${SM}"/>` : ""}</features>`,
    );
  }
  function succeed() {
    authenticated = true;
    peer.send(
      protocol === "sasl2"
        ? `<success xmlns="${SASL2}"><authorization-identifier>${account}</authorization-identifier></success>`
        : `<success xmlns="${SASL}"/>`,
    );
    if (protocol === "sasl2") {
      offerBinding();
    }
  }
  function finishBinding() {
    if (bindingId === undefined) {
      throw new Error("No binding request to complete");
    }
    peer.send(
      `<iq xmlns="${CLIENT}" type="result" id="${bindingId}"><bind xmlns="${BIND}"><jid>${account}/${RESOURCE}</jid></bind></iq>`,
    );
  }
  return {
    peer,
    paused: paused.promise,
    complete: phase === "authentication" ? succeed : finishBinding,
  };
}

function observeAddresses(xmpp: XMPPClient) {
  const addresses = new Map<string, Address>();
  const capture = (ctx: Context) => {
    addresses.set(ctx.id, {
      from: ctx.from?.toString() ?? null,
      to: ctx.to?.toString() ?? null,
      local: ctx.local,
      rawFrom: ctx.stanza.attrs.from,
      rawTo: ctx.stanza.attrs.to,
    });
    return true;
  };
  xmpp.iqCallee.get(EXTENSION, "query", capture);
  xmpp.middleware.use((ctx: Context, next: () => unknown) => {
    if (
      (ctx.name === "message" || ctx.name === "presence") &&
      ctx.id.startsWith("address-")
    ) {
      capture(ctx);
    }
    return next();
  });
  return addresses;
}

function waitForNonza(xmpp: XMPPClient, name: string, namespace: string) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      xmpp.off("nonza", handler);
      signal.removeEventListener("abort", aborted);
    };
    const handler = (element: {
      is(name: string, namespace: string): boolean;
    }) => {
      if (element.is(name, namespace)) {
        cleanup();
        resolve();
      }
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    xmpp.on("nonza", handler);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function probe(
  xmpp: XMPPClient,
  peer: ScriptedPeer,
  kind: Kind,
  id: string,
  from?: string,
  to?: string,
) {
  const barrier = waitForNonza(xmpp, "barrier", EXTENSION);
  const payload =
    kind === "iq"
      ? `<query xmlns="${EXTENSION}"/>`
      : kind === "message"
        ? "<body>sample</body>"
        : "<show>chat</show>";
  peer.send(
    `<${kind} xmlns="${CLIENT}" id="${id}" xml:lang="en"${kind === "iq" ? ' type="get"' : ""}${from === undefined ? "" : ` from="${from}"`}${to === undefined ? "" : ` to="${to}"`}>${payload}</${kind}>`,
  );
  peer.send(`<barrier xmlns="${EXTENSION}"/>`);
  await barrier;
  if (kind !== "iq") {
    return;
  }
  // Wait for the actual reply before teardown; no guessed sleep or absence check.
  while (true) {
    const root = readFrame(await peer.next())[0];
    if ("open" in root && root.attributes["{}id"] === id) {
      expect(root).toMatchObject({
        open: `{${CLIENT}}iq`,
        attributes: { "{}type": "result" },
      });
      return;
    }
  }
}

// RFC 6120 §§8.1.1.1/8.1.3: the application owns recipient intent and
// message/presence ID policy; the client preserves its explicit wire choices.
test.each([...SEND_METHODS])(
  "RFC 6120 §§8.1.1.1/8.1.3: %s preserves caller addressing and IDs",
  async (method: SendMethod) => {
    const remote = addressingPeer("sasl", "ready", ACCOUNT);
    const xmpp = client({
      service: remote.peer.url,
      domain: DOMAIN,
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      expect((await xmpp.start()).toString()).toBe(`${ACCOUNT}/${RESOURCE}`);
      const stanzas = [
        xml("message", {
          id: "message-recipient",
          to: "BOB@REMOTE.TEST/Other",
        }),
        xml("message", { to: "EXAMPLE.TEST" }),
        xml("presence", { id: "presence-broadcast" }),
        xml("presence", { to: "E\u0301LISE@EXAMPLE.TEST/Other" }),
      ];

      if (method === "send") {
        for (const stanza of stanzas) {
          await xmpp.send(stanza);
        }
      } else {
        await xmpp.sendMany(stanzas);
      }

      await xmpp.send(xml("barrier", { xmlns: EXTENSION }));
      let barrierSeen = false;
      const framesToRead = remote.peer.transcript.length + stanzas.length + 1;
      for (let index = 0; index < framesToRead; index += 1) {
        const root = readFrame(await remote.peer.next())[0];
        if ("open" in root && root.open === `{${EXTENSION}}barrier`) {
          barrierSeen = true;
          break;
        }
      }
      expect(barrierSeen).toBe(true);

      const frames = remote.peer.transcript
        .map((frame) => readFrame(frame)[0])
        .filter(
          (root) =>
            "open" in root &&
            (root.open === `{${CLIENT}}message` ||
              root.open === `{${CLIENT}}presence`),
        );
      expect(frames).toEqual([
        {
          open: `{${CLIENT}}message`,
          attributes: {
            "{}id": "message-recipient",
            "{}to": "bob@remote.test/Other",
          },
        },
        {
          open: `{${CLIENT}}message`,
          attributes: { "{}to": DOMAIN },
        },
        {
          open: `{${CLIENT}}presence`,
          attributes: { "{}id": "presence-broadcast" },
        },
        {
          open: `{${CLIENT}}presence`,
          attributes: { "{}to": `${ACCOUNT}/Other` },
        },
      ]);
      expect(errors).toEqual([]);
      expect(remote.peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await remote.peer.stop();
    }
  },
);

// RFC 6120 §§8.1.1.1/8.1.2.1: logical defaults do not rewrite raw wire attrs.
for (const protocol of PROTOCOLS) {
  test.each([...KINDS])(
    `RFC 6120 §8.1.2.1: confirmed sender and explicit addresses / ${protocol} / %s`,
    async (kind) => {
      const account = protocol === "anonymous" ? ANONYMOUS_ACCOUNT : ACCOUNT;
      const local = protocol === "anonymous" ? "anon-91" : "élise";
      const remote = addressingPeer(protocol, "ready", account);
      const xmpp = client({
        service: remote.peer.url,
        domain: DOMAIN,
        ...(protocol === "anonymous"
          ? {}
          : { username: "configured", password: "secret" }),
        timeout: TIMEOUT_MS,
      });
      xmpp.reconnect.stop();
      const errors: Error[] = [];
      xmpp.on("error", (error: Error) => errors.push(error));
      const addresses = observeAddresses(xmpp);
      try {
        expect((await xmpp.start()).toString()).toBe(`${account}/${RESOURCE}`);
        for (const [
          label,
          from,
          to,
          expectedFrom,
          expectedTo,
          expectedLocal,
        ] of [
          [
            "omitted",
            undefined,
            undefined,
            account,
            `${account}/${RESOURCE}`,
            local,
          ],
          ["server", DOMAIN, undefined, DOMAIN, `${account}/${RESOURCE}`, ""],
          [
            "account",
            account,
            `${account}/${RESOURCE}`,
            account,
            `${account}/${RESOURCE}`,
            local,
          ],
          [
            "peer",
            "BOB@REMOTE.TEST/Other",
            account,
            "bob@remote.test/Other",
            account,
            "bob",
          ],
          [
            "full",
            `${account}/Other`,
            undefined,
            `${account}/Other`,
            `${account}/${RESOURCE}`,
            local,
          ],
          [
            "hints",
            undefined,
            `${account}/${RESOURCE}`,
            account,
            `${account}/${RESOURCE}`,
            local,
          ],
        ] as const) {
          if (label === "hints") {
            xmpp.jid = jid("untrusted@other.test/hint");
            Object.assign(xmpp.options, { domain: "other.test" });
          }
          const id = `address-${label}`;
          await probe(xmpp, remote.peer, kind, id, from, to);
          expect(addresses.get(id)).toEqual({
            from: expectedFrom,
            to: expectedTo,
            local: expectedLocal,
            rawFrom: from,
            rawTo: to,
          });
        }
        expect(errors).toEqual([]);
        expect(remote.peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await remote.peer.stop();
      }
    },
  );
}

// §4.3.6: configured and former identities do not establish the current account.
for (const entry of ["initial", "replacement"] as const) {
  for (const protocol of PROTOCOLS) {
    test.each(["authentication", "binding"] as const)(
      `RFC 6120 §§4.3.6/8.1.2.1: implicit sender awaits confirmation / ${entry} / ${protocol} / %s`,
      async (phase) => {
        const account = protocol === "anonymous" ? ANONYMOUS_ACCOUNT : ACCOUNT;
        const first = addressingPeer(
          protocol === "anonymous" ? "anonymous" : "sasl",
          "ready",
          FORMER_ACCOUNT,
        );
        const current = addressingPeer(protocol, phase, account);
        const xmpp = client({
          service: entry === "replacement" ? first.peer.url : current.peer.url,
          domain: DOMAIN,
          ...(protocol === "anonymous"
            ? {}
            : { username: "configured", password: "secret" }),
          timeout: TIMEOUT_MS,
        });
        xmpp.reconnect.stop();
        const errors: Error[] = [];
        xmpp.on("error", (error: Error) => errors.push(error));
        const addresses = observeAddresses(xmpp);
        let started: Promise<unknown> | undefined;
        try {
          if (entry === "replacement") {
            expect((await xmpp.start()).toString()).toBe(
              `${FORMER_ACCOUNT}/${RESOURCE}`,
            );
            await xmpp.stop();
            expect(xmpp.status).toBe("offline");
            Object.assign(xmpp.options, { service: current.peer.url });
          }
          started = xmpp.start().catch((error: Error) => error);
          await current.paused;
          const confirmed = protocol === "sasl2" && phase === "binding";
          for (const kind of KINDS) {
            const id = `address-${kind}`;
            await probe(xmpp, current.peer, kind, id);
            expect(addresses.get(id)?.from).toBe(confirmed ? account : null);
            expect(addresses.get(id)?.local).toBe(confirmed ? "élise" : "");
            expect(addresses.get(id)?.rawFrom).toBeUndefined();
          }
          current.complete();
          expect((await started)?.toString()).toBe(`${account}/${RESOURCE}`);
          await probe(xmpp, current.peer, "message", "address-confirmed");
          expect(addresses.get("address-confirmed")?.from).toBe(account);
          expect(errors).toEqual([]);
          expect(current.peer.errors).toEqual([]);
          expect(first.peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await started;
          await first.peer.stop();
          await current.peer.stop();
        }
      },
    );
  }
}

test.each(["ordinary", "inline", "mutated-hints"] as const)(
  "RFC 6120 §8.1.2.1 / XEP-0198 §§5,9.2: verified resumption preserves the implicit account / %s",
  async (mode) => {
    const protocol = mode === "inline" ? "sasl2" : "sasl";
    const first = addressingPeer(protocol, "resumption", ACCOUNT);
    const current = addressingPeer(protocol, "resumption", ACCOUNT);
    const xmpp = client({
      service: first.peer.url,
      domain: DOMAIN,
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    if (mode === "mutated-hints") {
      xmpp.once("online", () => {
        // Run before SM enable: its snapshot must not copy this public hint.
        xmpp.jid = jid("untrusted@other.test/hint");
      });
    }
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    const addresses = observeAddresses(xmpp);
    const enabled = waitForNonza(
      xmpp,
      protocol === "sasl2" ? "success" : "enabled",
      protocol === "sasl2" ? SASL2 : SM,
    );
    try {
      expect((await xmpp.start()).toString()).toBe(`${ACCOUNT}/${RESOURCE}`);
      await enabled;
      await xmpp.send(xml("sync", { xmlns: EXTENSION }));
      while (true) {
        const root = readFrame(await first.peer.next())[0];
        if ("open" in root && root.open === `{${EXTENSION}}sync`) {
          break;
        }
      }
      const disconnected = once(xmpp, "disconnect", {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      first.peer.terminate();
      await disconnected;
      Object.assign(xmpp.options, { service: current.peer.url });
      const resumed = once(xmpp.streamManagement, "resumed", {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await xmpp.reconnect.reconnect();
      await resumed;
      expect(xmpp.status).toBe("online");
      expect(
        current.peer.transcript.some((frame) =>
          readFrame(frame).some(
            (event) => "open" in event && event.open === `{${SM}}resume`,
          ),
        ),
      ).toBe(true);
      if (protocol === "sasl2") {
        expect(
          first.peer.transcript.some((frame) =>
            readFrame(frame).some(
              (event) => "open" in event && event.open === `{${SM}}enable`,
            ),
          ),
        ).toBe(true);
      }
      for (const kind of KINDS) {
        const id = `address-resumed-${kind}`;
        const to =
          mode === "mutated-hints" ? `${ACCOUNT}/${RESOURCE}` : undefined;
        await probe(xmpp, current.peer, kind, id, undefined, to);
        expect(addresses.get(id)?.from).toBe(ACCOUNT);
        expect(addresses.get(id)?.to).toBe(`${ACCOUNT}/${RESOURCE}`);
      }
      expect(errors).toEqual([]);
      expect(first.peer.errors).toEqual([]);
      expect(current.peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await first.peer.stop();
      await current.peer.stop();
    }
  },
);
