import { expect, test } from "bun:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { client } from "../src/client/index.js";
import { ScriptedPeer, waitForDisconnect } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const CLIENT = "jabber:client";
const CLOSE = `<close xmlns="${FRAMING}"/>`;
const AUTH = `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`;
const AUTH2 = `<authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism></authentication>`;
const INLINE_AUTH2 = `<authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><inline><bind xmlns="${BIND2}"/></inline></authentication>`;
const BINDING = `<bind xmlns="${BIND}"/>`;
const FULL_JID = "user@example.test/r";
const WATCHDOG_MS = 500;
const CLOSE_TIMEOUT_MS = 300;
const EARLY_CLOSE_CHECK_MS = 75;
const CLOCK_TOLERANCE_MS = 5;

type Stage =
  | "initial classic"
  | "initial SASL2"
  | "classic restart"
  | "SASL2 success"
  | "inline SASL2 success"
  | "bound";

function featurePeer(
  stage: Stage,
  offer: string,
  followup: "none" | "valid",
  closeReply: "reply" | "omit" = "reply",
) {
  let authenticated = false;
  return new ScriptedPeer((frame, peer) => {
    const events = readFrame(frame);
    const root = events[0];
    if (!root || !("open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="${authenticated ? "restart" : "initial"}"/>`,
      );
      const valid = `<features xmlns="${STREAM}">${authenticated ? BINDING : stage === "inline SASL2 success" ? INLINE_AUTH2 : stage.includes("SASL2") ? AUTH2 : AUTH}</features>`;
      const selected = authenticated
        ? stage === "classic restart"
        : stage === "initial classic" || stage === "initial SASL2";
      peer.send(selected ? offer : valid);
      if (selected && followup === "valid") {
        peer.send(valid);
      }
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      peer.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${SASL2}}authenticate`) {
      authenticated = true;
      peer.send(
        `<success xmlns="${SASL2}"><authorization-identifier>${stage === "inline SASL2 success" ? FULL_JID : "user@example.test"}</authorization-identifier>${stage === "inline SASL2 success" ? `<bound xmlns="${BIND2}"/>` : ""}</success>`,
      );
      // Inline binding is already ready; its final offer is sent by the test.
      if (stage === "inline SASL2 success") {
        return;
      }
      const valid = `<features xmlns="${STREAM}">${BINDING}</features>`;
      peer.send(stage === "SASL2 success" ? offer : valid);
      if (stage === "SASL2 success" && followup === "valid") {
        peer.send(valid);
      }
    } else if (
      root.open === `{${CLIENT}}iq` &&
      events.some((event) => "open" in event && event.open === `{${BIND}}bind`)
    ) {
      peer.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${FULL_JID}</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      peer.send(`<enabled xmlns="${SM}"/>`);
    } else if (root.open === `{${FRAMING}}close` && closeReply === "reply") {
      peer.send(CLOSE);
    }
  });
}

// RFC 6120 §§4.4/4.9.1.1 and RFC 7395 §§3.5–3.6 retain reciprocal closure
// after fatal errors. The bounded silent-peer wait and its duration are policy.
for (const stage of ["initial classic", "classic restart"] as const) {
  for (const failure of [
    "malformed features",
    "received stream error",
  ] as const) {
    const responses =
      failure === "malformed features"
        ? ([
            "delayed reciprocal",
            "missing reciprocal",
            "further malformed XML",
          ] as const)
        : (["delayed reciprocal", "missing reciprocal"] as const);
    test.each([...responses])(
      `RFC 6120 §§4.4/4.9.1.1: ${stage} ${failure} preserves stream-close wait / %s`,
      async (response) => {
        const offer =
          failure === "malformed features"
            ? `<features xmlns="${STREAM}">${stage === "initial classic" ? AUTH : BINDING}<future/></features>`
            : `<error xmlns="${STREAM}"><policy-violation xmlns="${ERRORS}"/></error>`;
        const peer = featurePeer(stage, offer, "none", "omit");
        const xmpp = client({
          service: peer.url,
          domain: "example.test",
          username: "user",
          password: "secret",
          timeout: CLOSE_TIMEOUT_MS,
        });
        xmpp.reconnect.stop();
        const errors: Error[] = [];
        const online: string[] = [];
        let disconnected = 0;
        let closingAt = 0;
        let closedAt = 0;
        xmpp.on("error", (error: Error) => errors.push(error));
        xmpp.on("online", (address: { toString(): string }) =>
          online.push(address.toString()),
        );
        xmpp.on("disconnect", () => {
          disconnected++;
        });
        xmpp.on("closing", () => {
          closingAt = performance.now();
        });
        const transportClosed = peer.waitForClose().then(() => {
          closedAt = performance.now();
          return undefined;
        });
        const started = xmpp.start().catch((error: Error) => error);
        try {
          // Observe the actual footer, without providing its reciprocal response.
          for (;;) {
            const root = readFrame(await peer.next())[0];
            if ("open" in root && root.open === `{${FRAMING}}close`) {
              break;
            }
          }
          const result = await started;
          expect(result).toBeInstanceOf(Error);
          expect(errors).toEqual([result]);
          expect(result).toMatchObject(
            failure === "malformed features"
              ? { message: "Invalid stream feature namespace" }
              : { condition: "policy-violation" },
          );
          expect(online).toEqual([]);
          const expected = [
            `{${FRAMING}}open`,
            ...(stage === "classic restart"
              ? [`{${SASL}}auth`, `{${FRAMING}}open`]
              : []),
            ...(failure === "malformed features" ? [`{${STREAM}}error`] : []),
            `{${FRAMING}}close`,
          ];
          expect(
            peer.transcript
              .map((frame) => readFrame(frame)[0])
              .map((root) => ("open" in root ? root.open : "")),
          ).toEqual(expected);

          // Let premature WebSocket closure become observable before asserting.
          await setImmediate();
          await setImmediate();
          expect(xmpp.status).toBe("closing");
          expect(closedAt).toBe(0);
          expect(disconnected).toBe(0);
          if (response === "delayed reciprocal") {
            peer.send(CLOSE);
          } else {
            if (response === "further malformed XML") {
              peer.send("<message>");
            }
            await delay(EARLY_CLOSE_CHECK_MS);
            expect(xmpp.status).toBe("closing");
            expect(closedAt).toBe(0);
            expect(disconnected).toBe(0);
            expect(errors).toEqual([result]);
          }
          await transportClosed;
          expect(await waitForDisconnect(xmpp)).toBe(true);
          expect(xmpp.status).toBe("disconnect");
          expect(disconnected).toBe(1);
          expect(errors).toEqual([result]);
          if (response !== "delayed reciprocal") {
            // Allow clock granularity, not an earlier replacement deadline.
            expect(closedAt - closingAt).toBeGreaterThanOrEqual(
              CLOSE_TIMEOUT_MS - CLOCK_TOLERANCE_MS,
            );
          }
          expect(
            peer.transcript
              .map((frame) => readFrame(frame)[0])
              .map((root) => ("open" in root ? root.open : "")),
          ).toEqual(expected);
          expect(readFrame(peer.transcript.at(-1)!)).toEqual([
            { open: `{${FRAMING}}close`, attributes: {} },
            { close: `{${FRAMING}}close` },
          ]);
          expect(peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await started;
          await peer.stop();
          await transportClosed;
        }
      },
    );
  }
}

test("RFC 6120 §§4.3/4.9.1.1: a fresh transport can negotiate after fatal features", async () => {
  const failedPeer = featurePeer(
    "initial classic",
    `<features xmlns="${STREAM}">${AUTH}<future/></features>`,
    "none",
  );
  const nextPeer = featurePeer(
    "initial classic",
    `<features xmlns="${STREAM}">${AUTH}</features>`,
    "none",
  );
  const xmpp = client({
    service: failedPeer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  const online: string[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("online", (address: { toString(): string }) =>
    online.push(address.toString()),
  );
  try {
    const failed = await xmpp.start().catch((error: Error) => error);
    expect(failed).toMatchObject({
      message: "Invalid stream feature namespace",
    });
    await failedPeer.waitForClose();
    expect(await waitForDisconnect(xmpp)).toBe(true);
    expect(online).toEqual([]);
    expect(xmpp.status).toBe("disconnect");
    await xmpp.stop();

    // Recovery uses another transport, never another offer on the failed stream.
    Object.assign(xmpp.options, { service: nextPeer.url });
    expect((await xmpp.start()).toString()).toBe(FULL_JID);
    expect(xmpp.status).toBe("online");
    expect(online).toEqual([FULL_JID]);
    expect(errors).toEqual([failed]);
    expect(
      nextPeer.transcript
        .map((frame) => readFrame(frame)[0])
        .map((root) => ("open" in root ? root.open : "")),
    ).toEqual([
      `{${FRAMING}}open`,
      `{${SASL}}auth`,
      `{${FRAMING}}open`,
      `{${CLIENT}}iq`,
    ]);
    expect(failedPeer.errors).toEqual([]);
    expect(nextPeer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await failedPeer.stop();
    await nextPeer.stop();
  }
});

// RFC 6120 §§4.3.2/4.9.1.1/4.9.2 require distinct feature namespaces and
// a defined stream error before closure. RFC 7395 §§3.5–3.6 supplies framing.
// Rejecting namespace-less features and selecting bad-format are local policy.
for (const stage of [
  "initial classic",
  "initial SASL2",
  "classic restart",
  "SASL2 success",
  "inline SASL2 success",
  "bound",
] as const) {
  test.each([
    [
      "stream namespace",
      `<features xmlns="${STREAM}">`,
      "<future/>",
      "</features>",
      "none",
    ],
    [
      "content namespace",
      `<features xmlns="${STREAM}">`,
      `<future xmlns="${CLIENT}"/>`,
      "</features>",
      "none",
    ],
    [
      "explicit empty namespace",
      `<features xmlns="${STREAM}">`,
      '<future xmlns=""/>',
      "</features>",
      "none",
    ],
    [
      "inherited empty namespace",
      `<s:features xmlns:s="${STREAM}" xmlns="">`,
      "<future/>",
      "</s:features>",
      "none",
    ],
    [
      "stream namespace alias",
      `<features xmlns="${STREAM}">`,
      `<bad:future xmlns:bad="${STREAM}"/>`,
      "</features>",
      "none",
    ],
    [
      "valid offer immediately after invalid",
      `<features xmlns="${STREAM}">`,
      "<future/>",
      "</features>",
      "valid",
    ],
  ] as const)(
    `RFC 6120 §§4.3.2/4.9.1.1: malformed ${stage} features report error before close / %s`,
    async (_namespace, opening, invalid, closing, followup) => {
      const valid =
        stage === "initial classic"
          ? AUTH
          : stage === "initial SASL2"
            ? INLINE_AUTH2
            : BINDING + `<sm xmlns="${SM}"/>`;
      const malformed = opening + valid + invalid + closing;
      const peer = featurePeer(stage, malformed, followup);
      const xmpp = client({
        service: peer.url,
        domain: "example.test",
        username: "user",
        password: "secret",
      });
      xmpp.reconnect.stop();
      const errors: Error[] = [];
      const online: string[] = [];
      const failure = Promise.withResolvers<Error>();
      let disconnected = 0;
      xmpp.on("error", (error: Error) => {
        errors.push(error);
        failure.resolve(error);
      });
      xmpp.on("online", (address: { toString(): string }) =>
        online.push(address.toString()),
      );
      xmpp.on("disconnect", () => {
        disconnected++;
      });
      const started = xmpp.start().catch((error: Error) => error);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ready = stage === "bound" || stage === "inline SASL2 success";
        if (ready) {
          expect((await started).toString()).toBe(FULL_JID);
          peer.send(malformed);
          if (followup === "valid") {
            peer.send(
              `<features xmlns="${STREAM}"><sm xmlns="${SM}"/></features>`,
            );
          }
        }
        const result = await Promise.race([
          ready ? failure.promise : started,
          new Promise<Error>((resolve) => {
            timer = setTimeout(
              () =>
                resolve(new Error("test watchdog: malformed features ignored")),
              WATCHDOG_MS,
            );
          }),
        ]);
        // The guard never substitutes for observing the specific rejection.
        expect(result).toMatchObject({
          message: "Invalid stream feature namespace",
        });
        await peer.waitForClose();
        expect(await waitForDisconnect(xmpp)).toBe(true);
        expect(online).toEqual(ready ? [FULL_JID] : []);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBe(result);
        expect(disconnected).toBe(1);
        expect(xmpp.status).toBe("disconnect");
        expect(xmpp.streamManagement.enabled).toBe(false);
        const roots = peer.transcript.map((frame) => readFrame(frame)[0]);
        const prefix =
          stage === "initial classic" || stage === "initial SASL2"
            ? [`{${FRAMING}}open`]
            : stage.includes("SASL2")
              ? [`{${FRAMING}}open`, `{${SASL2}}authenticate`]
              : [
                  `{${FRAMING}}open`,
                  `{${SASL}}auth`,
                  `{${FRAMING}}open`,
                  ...(stage === "bound" ? [`{${CLIENT}}iq`] : []),
                ];
        // This exact wire sequence rejects silent closure and further negotiation.
        expect(roots.map((root) => ("open" in root ? root.open : ""))).toEqual([
          ...prefix,
          `{${STREAM}}error`,
          `{${FRAMING}}close`,
        ]);
        const reported = readFrame(peer.transcript[prefix.length]);
        expect(reported[0]).toEqual({
          open: `{${STREAM}}error`,
          attributes: {},
        });
        expect(reported.at(-1)).toEqual({ close: `{${STREAM}}error` });
        // Optional RFC text/application detail does not change the defined condition.
        expect(
          reported.filter(
            (event) =>
              "open" in event &&
              event.open.startsWith(`{${ERRORS}}`) &&
              event.open !== `{${ERRORS}}text`,
          ),
        ).toEqual([{ open: `{${ERRORS}}bad-format`, attributes: {} }]);
        expect(readFrame(peer.transcript[prefix.length + 1])).toEqual([
          { open: `{${FRAMING}}close`, attributes: {} },
          { close: `{${FRAMING}}close` },
        ]);
        expect(peer.errors).toEqual([]);
      } finally {
        clearTimeout(timer);
        await xmpp.stop();
        await started;
        await peer.stop();
      }
    },
  );
}

for (const stage of ["initial classic", "initial SASL2"] as const) {
  const required = stage === "initial classic" ? AUTH : AUTH2;
  const namespace = stage === "initial classic" ? SASL : SASL2;
  const feature = stage === "initial classic" ? "mechanisms" : "authentication";
  test.each([
    [
      "foreign optional before required",
      `<features xmlns="${STREAM}"><future xmlns="urn:test:optional"/>${required}</features>`,
      "none",
    ],
    [
      "foreign optional after required",
      `<features xmlns="${STREAM}">${required}<future xmlns="urn:test:optional"/></features>`,
      "none",
    ],
    [
      "foreign feature payload is not a direct stream feature",
      `<features xmlns="${STREAM}">${required}<future xmlns="urn:test:optional"><child xmlns="${STREAM}"/><child xmlns="${CLIENT}"/><child xmlns=""/></future></features>`,
      "none",
    ],
    [
      "namespace prefix alternatives",
      `<s:features xmlns:s="${STREAM}"><a:${feature} xmlns:a="${namespace}"><a:mechanism>PLAIN</a:mechanism></a:${feature}><optional:future xmlns:optional="urn:test:optional"/></s:features>`,
      "none",
    ],
    [
      "ignore forbidden content prefix before a valid offer",
      `<features xmlns="${STREAM}">${required}<bad:future xmlns:bad="${CLIENT}"/></features>`,
      "valid",
    ],
  ] as const)(
    `RFC 6120 §§4.3.2/4.8.5: valid ${stage} feature alternatives remain usable / %s`,
    async (_case, offer, followup) => {
      const peer = featurePeer(stage, offer, followup);
      const xmpp = client({
        service: peer.url,
        domain: "example.test",
        username: "user",
        password: "secret",
      });
      xmpp.reconnect.stop();
      const errors: Error[] = [];
      const online: string[] = [];
      xmpp.on("error", (error: Error) => errors.push(error));
      xmpp.on("online", (address: { toString(): string }) =>
        online.push(address.toString()),
      );
      try {
        expect((await xmpp.start()).toString()).toBe(FULL_JID);
        expect(xmpp.status).toBe("online");
        expect(online).toEqual([FULL_JID]);
        expect(errors).toEqual([]);
        expect(
          peer.transcript
            .map((frame) => readFrame(frame)[0])
            .map((root) => ("open" in root ? root.open : "")),
        ).toEqual([
          `{${FRAMING}}open`,
          stage === "initial classic"
            ? `{${SASL}}auth`
            : `{${SASL2}}authenticate`,
          ...(stage === "initial classic" ? [`{${FRAMING}}open`] : []),
          `{${CLIENT}}iq`,
        ]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}
