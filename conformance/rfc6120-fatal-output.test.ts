import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer, waitForDisconnect } from "./peer.ts";
import { readFrame } from "./xml.ts";
import { outgoingPresence } from "../src/connection/lib/outgoingPresence.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const CONTENT = "jabber:client";
const SM = "urn:xmpp:sm:3";
const FOREIGN = "urn:example:fatal-output";
const ACCOUNT = "user@example.test/r";
const TIMEOUT_MS = 500;
const MAX_FATAL_FRAMES = 4;
const CLOSE = `<close xmlns="${FRAMING}"/>`;

function peer(mode: "plain" | "managed" = "plain") {
  let authenticated = false;
  return new ScriptedPeer((frame, remote) => {
    const events = readFrame(frame);
    const root = events[0];
    if (!(root && "open" in root)) {
      throw new Error("Expected a client element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="fatal-output" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>${mode === "managed" ? `<sm xmlns="${SM}"/>` : ""}` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      events.some((event) => "open" in event && event.open === `{${BIND}}bind`)
    ) {
      remote.send(
        `<iq xmlns="${CONTENT}" id="${root.attributes["{}id"]}" type="result"><bind xmlns="${BIND}"><jid>${ACCOUNT}</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(CLOSE);
    }
  });
}

test("RFC 6120 §4.9.1.1: a delayed generation-bound owned error cannot write or close a replacement transport", async () => {
  const first = peer();
  const next = peer();
  const xmpp = client({
    service: first.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<unknown>();
  const send = xmpp.send.bind(xmpp);
  let held = false;
  xmpp.send = async (element: Element) => {
    if (!element.is("error", STREAM) || held) {
      return send(element);
    }
    // Delay the owned Element before the original send consumes its permission.
    held = true;
    entered.resolve(true);
    await release.promise;
    try {
      await send(element);
      completed.resolve("sent");
    } catch (error) {
      completed.resolve(error);
      throw error;
    }
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(String(await xmpp.start())).toBe(ACCOUNT);
    await xmpp.send(xml("notice", { xmlns: FOREIGN, id: "before-failure" }));
    while (
      !readFrame(await first.next()).some(
        (event) =>
          "open" in event && event.attributes["{}id"] === "before-failure",
      )
    ) {
      // The original authenticated transport receives its successful control.
    }
    const firstBefore = first.transcript.length;
    first.send(`<message xmlns="${CONTENT}"><body></message>`);
    watchdog = setTimeout(() => entered.resolve(false), TIMEOUT_MS);
    expect(await entered.promise).toBe(true);
    clearTimeout(watchdog);
    expect(first.transcript.slice(firstBefore)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "XMLError",
      condition: "not-well-formed",
    });
    first.terminate();
    expect(await waitForDisconnect(xmpp, TIMEOUT_MS)).toBe(true);
    await first.waitForClose();
    await xmpp.stop();

    Object.assign(xmpp.options, { service: next.url });
    expect(String(await xmpp.start())).toBe(ACCOUNT);
    await xmpp.send(xml("notice", { xmlns: FOREIGN, id: "before-release" }));
    while (
      !readFrame(await next.next()).some(
        (event) =>
          "open" in event && event.attributes["{}id"] === "before-release",
      )
    ) {
      // Authenticate and prove the replacement transport writable before release.
    }
    const nextBefore = next.transcript.length;
    release.resolve();
    const result = await completed.promise;
    await xmpp.send(
      xml("message", { id: "recovered", to: "peer@remote.test/r" }),
    );
    while (
      !readFrame(await next.next()).some(
        (event) => "open" in event && event.attributes["{}id"] === "recovered",
      )
    ) {
      // A later application frame bounds any stale-error write on this socket.
    }
    expect({ result, wire: next.transcript.slice(nextBefore) }).toMatchObject({
      result: expect.any(Error),
    });
    expect(
      next.transcript.slice(nextBefore).map((frame) => readFrame(frame)[0]),
    ).toEqual([
      {
        open: `{${CONTENT}}message`,
        attributes: { "{}id": "recovered", "{}to": "peer@remote.test/r" },
      },
    ]);
    expect(first.transcript.slice(firstBefore)).toEqual([]);
    expect(xmpp.status).toBe("online");
    expect(errors).toHaveLength(1);
    expect(first.errors).toEqual([]);
    expect(next.errors).toEqual([]);
  } finally {
    clearTimeout(watchdog);
    release.resolve();
    if (held) {
      await completed.promise;
    }
    xmpp.send = send;
    await xmpp.stop();
    await first.stop();
    await next.stop();
  }
});

for (const method of ["send", "sendMany"] as const) {
  test(`RFC 6120 §4.9.1.1: generic ${method} cannot send an error and remain writable`, async () => {
    const remote = peer();
    const xmpp = client({
      service: remote.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    try {
      expect(String(await xmpp.start())).toBe(ACCOUNT);
      await xmpp.send(xml("notice", { xmlns: FOREIGN, id: "before-failure" }));
      while (
        !readFrame(await remote.next()).some(
          (event) =>
            "open" in event && event.attributes["{}id"] === "before-failure",
        )
      ) {
        // Drain setup before examining the public stream-error operation.
      }
      const before = remote.transcript.length;
      const error = xml(
        "stream:error",
        { "xmlns:stream": STREAM },
        xml("resource-constraint", { xmlns: ERRORS }),
      );
      const inside = xml("notice", { xmlns: FOREIGN, id: "forbidden-inside" });
      const first = await (
        method === "send" ? xmpp.send(error) : xmpp.sendMany([error, inside])
      ).then(
        () => "sent",
        (error: Error) => error,
      );
      const next = await xmpp
        .send(xml("notice", { xmlns: FOREIGN, id: "after-error" }))
        .then(
          () => "sent",
          (error: Error) => error,
        );
      if (next === "sent") {
        while (
          !readFrame(await remote.next()).some(
            (event) =>
              "open" in event && event.attributes["{}id"] === "after-error",
          )
        ) {
          // A valid final frame exposes earlier writes without a quiet-time wait.
        }
        // Rejection is allowed only if it preserves the healthy stream and writes
        // no stream error or partial batch; accepted errors must make it terminal.
        expect({
          method,
          first,
          next,
          wire: remote.transcript.slice(before),
        }).toMatchObject({ first: expect.any(Error) });
        expect(
          remote.transcript.slice(before).map((frame) => readFrame(frame)[0]),
        ).toEqual([
          { open: `{${FOREIGN}}notice`, attributes: { "{}id": "after-error" } },
        ]);
        expect(xmpp.status).toBe("online");
      } else {
        expect(next).toBeInstanceOf(Error);
        expect(await waitForDisconnect(xmpp, TIMEOUT_MS)).toBe(true);
        await remote.waitForClose();
        expect(
          remote.transcript.slice(before).map((frame) => readFrame(frame)[0]),
        ).toEqual([
          { open: `{${STREAM}}error`, attributes: {} },
          { open: `{${FRAMING}}close`, attributes: {} },
        ]);
        expect(readFrame(remote.transcript[before])).toContainEqual({
          open: `{${ERRORS}}resource-constraint`,
          attributes: {},
        });
      }
      expect(remote.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await remote.stop();
    }
  });

  test(`RFC 6120 §4.9.1.1: ${method} cannot repurpose the owned error Element as a foreign nonza`, async () => {
    const remote = peer();
    const xmpp = client({
      service: remote.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    let attempted: Promise<unknown> | undefined;
    xmpp.on("send", (element: Element) => {
      if (!element.is("error", STREAM) || attempted) {
        return;
      }
      element.name = "notice";
      element.attrs = { xmlns: FOREIGN, id: "forbidden" };
      element.children = [];
      attempted = (
        method === "send" ? xmpp.send(element) : xmpp.sendMany([element])
      ).then(
        () => "sent",
        (error: Error) => error,
      );
    });
    try {
      expect(String(await xmpp.start())).toBe(ACCOUNT);
      await xmpp.send(xml("notice", { xmlns: FOREIGN, id: "before-failure" }));
      while (
        !readFrame(await remote.next()).some(
          (event) =>
            "open" in event && event.attributes["{}id"] === "before-failure",
        )
      ) {
        // The peer observes setup before the fatal transition and mutation.
      }
      const before = remote.transcript.length;
      remote.send(`<message xmlns="${CONTENT}"><body></message>`);
      expect(await waitForDisconnect(xmpp, TIMEOUT_MS)).toBe(true);
      await remote.waitForClose();
      expect(attempted).toBeDefined();
      expect(await attempted).toBeInstanceOf(Error);
      expect(
        remote.transcript.slice(before).map((frame) => readFrame(frame)[0]),
      ).toEqual([
        { open: `{${STREAM}}error`, attributes: {} },
        { open: `{${FRAMING}}close`, attributes: {} },
      ]);
      expect(readFrame(remote.transcript[before])).toContainEqual({
        open: `{${ERRORS}}not-well-formed`,
        attributes: {},
      });
      expect(remote.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await remote.stop();
    }
  });
}

// Receipt is terminal before error, element and nonza listeners are notified.
// The receiving client closes without echoing the peer's stream error.
for (const callback of ["error", "element", "nonza"] as const) {
  for (const method of ["send", "sendMany"] as const) {
    for (const payload of ["stanza", "nonza"] as const) {
      test(`RFC 6120 §4.9.1.1: ${method} refuses ${payload} reentry from received stream error ${callback}`, async () => {
        const remote = peer();
        const xmpp = client({
          service: remote.url,
          domain: "example.test",
          username: "user",
          password: "secret",
          timeout: TIMEOUT_MS,
        });
        xmpp.reconnect.stop();
        const errors: Error[] = [];
        const sent: string[] = [];
        let armed = false;
        let attempted: Promise<unknown> | undefined;
        const attempt = () => {
          if (!armed || attempted) {
            return;
          }
          const value =
            payload === "stanza"
              ? xml("message", { id: "forbidden", to: "peer@remote.test/r" })
              : xml("notice", { xmlns: FOREIGN, id: "forbidden" });
          attempted = (
            method === "send"
              ? xmpp.send(value)
              : xmpp.sendMany([
                  value,
                  xml("notice", { xmlns: FOREIGN, id: "forbidden-last" }),
                ])
          ).then(
            () => "sent",
            (error: Error) => error,
          );
        };
        xmpp.on("error", (error: Error) => {
          errors.push(error);
          if (callback === "error") {
            attempt();
          }
        });
        xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
        if (callback !== "error") {
          xmpp.on(callback, (element: Element) => {
            if (element.is("error", STREAM)) {
              attempt();
            }
          });
        }
        try {
          expect(String(await xmpp.start())).toBe(ACCOUNT);
          await xmpp.send(
            xml("message", { id: "before-failure", to: "peer@remote.test/r" }),
          );
          while (
            !readFrame(await remote.next()).some(
              (event) =>
                "open" in event &&
                event.attributes["{}id"] === "before-failure",
            )
          ) {
            // Bound the assertion by actual receipt of the positive control.
          }
          const before = remote.transcript.length;
          armed = true;
          remote.send(
            `<error xmlns="${STREAM}"><system-shutdown xmlns="${ERRORS}"/></error>`,
          );
          expect(await waitForDisconnect(xmpp, TIMEOUT_MS)).toBe(true);
          await remote.waitForClose();
          expect(attempted).toBeDefined();
          expect({
            callback,
            method,
            payload,
            result: await attempted,
            wire: remote.transcript.slice(before),
          }).toMatchObject({ result: expect.any(Error) });
          expect(remote.transcript.slice(before)).toEqual([CLOSE]);
          expect(sent).not.toContain("forbidden");
          expect(sent).not.toContain("forbidden-last");
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({
            name: "StreamError",
            condition: "system-shutdown",
          });
          expect(remote.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await remote.stop();
        }
      });
    }
  }
}

for (const method of ["send", "sendMany"] as const) {
  test(`RFC 6120 §4.9.1.1: ${method} cannot reuse the original owned error Element as permission`, async () => {
    const remote = peer();
    const xmpp = client({
      service: remote.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    let attempted: Promise<unknown> | undefined;
    xmpp.on("error", (error: Error) => errors.push(error));
    xmpp.on("send", (element: Element) => {
      if (!element.is("error", STREAM) || attempted) {
        return;
      }
      attempted = (
        method === "send" ? xmpp.send(element) : xmpp.sendMany([element])
      ).then(
        () => "sent",
        (error: Error) => error,
      );
    });
    try {
      expect(String(await xmpp.start())).toBe(ACCOUNT);
      await xmpp.send(xml("notice", { xmlns: FOREIGN, id: "before-failure" }));
      while (
        !readFrame(await remote.next()).some(
          (event) =>
            "open" in event && event.attributes["{}id"] === "before-failure",
        )
      ) {
        // The owned error is emitted only after setup traffic reaches the peer.
      }
      const before = remote.transcript.length;
      remote.send(`<message xmlns="${CONTENT}"><body></message>`);
      expect(await waitForDisconnect(xmpp, TIMEOUT_MS)).toBe(true);
      await remote.waitForClose();
      expect(attempted).toBeDefined();
      expect({
        method,
        result: await attempted,
        wire: remote.transcript.slice(before),
      }).toMatchObject({ result: expect.any(Error) });
      expect(
        remote.transcript.slice(before).map((frame) => readFrame(frame)[0]),
      ).toEqual([
        { open: `{${STREAM}}error`, attributes: {} },
        { open: `{${FRAMING}}close`, attributes: {} },
      ]);
      expect(errors).toHaveLength(1);
      expect(remote.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await remote.stop();
    }
  });

  test(`RFC 6120 §4.9.1.1 / XEP-0198: ${method} cannot admit a prepared presence after fatal error`, async () => {
    const remote = peer("managed");
    const xmpp = client({
      service: remote.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.streamManagement.requestAckInterval = 0;
    const enabled = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const errors: Error[] = [];
    const sent: string[] = [];
    xmpp.on("nonza", (element: Element) => {
      if (element.is("enabled", SM)) {
        enabled.resolve();
      }
    });
    xmpp.on("error", (error: Error) => {
      errors.push(error);
      release.resolve();
    });
    xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
    outgoingPresence.set(xmpp, async (_source, original) => {
      entered.resolve();
      await release.promise;
      return original;
    });
    let pending: Promise<unknown> | undefined;
    try {
      expect(String(await xmpp.start())).toBe(ACCOUNT);
      await enabled.promise;
      await xmpp.send(xml("notice", { xmlns: FOREIGN, id: "before-failure" }));
      while (
        !readFrame(await remote.next()).some(
          (event) =>
            "open" in event && event.attributes["{}id"] === "before-failure",
        )
      ) {
        // The queue is empty and SM is established before preparation is paused.
      }
      expect(xmpp.streamManagement.enabled).toBe(true);
      expect(xmpp.streamManagement.outbound_q).toEqual([]);
      const before = remote.transcript.length;
      const value = xml("presence", { id: "forbidden" });
      pending = (
        method === "send" ? xmpp.send(value) : xmpp.sendMany([value])
      ).then(
        () => "sent",
        (error: Error) => error,
      );
      await entered.promise;
      expect(xmpp.streamManagement.outbound_q).toEqual([]);
      expect(sent).not.toContain("forbidden");
      remote.send(`<message xmlns="${CONTENT}"><body></message>`);
      const result = await pending;
      expect(await waitForDisconnect(xmpp, TIMEOUT_MS)).toBe(true);
      await remote.waitForClose();
      expect({
        method,
        result,
        wire: remote.transcript.slice(before),
      }).toMatchObject({ result: expect.any(Error) });
      expect(sent).not.toContain("forbidden");
      expect(xmpp.streamManagement.outbound_q).toEqual([]);
      expect(
        remote.transcript.slice(before).map((frame) => readFrame(frame)[0]),
      ).toEqual([
        { open: `{${STREAM}}error`, attributes: {} },
        { open: `{${FRAMING}}close`, attributes: {} },
      ]);
      expect(errors).toHaveLength(1);
      expect(remote.errors).toEqual([]);
    } finally {
      release.resolve();
      await pending;
      outgoingPresence.delete(xmpp);
      await xmpp.stop();
      await remote.stop();
    }
  });
}

// RFC 6120 §4.9.1.1: once a fatal error is detected, send its one owned
// stream error and close, not application traffic reentered from callbacks.
// RFC 7395 §§3.5–3.6 retain that rule with separate error/close documents.
for (const callback of ["error", "owned error send"] as const) {
  for (const method of ["send", "sendMany"] as const) {
    for (const payload of ["stanza", "nonza"] as const) {
      test(`RFC 6120 §4.9.1.1 / RFC 7395 §§3.5–3.6: ${method} refuses ${payload} reentry from ${callback}`, async () => {
        const first = peer();
        const next = peer();
        const xmpp = client({
          service: first.url,
          domain: "example.test",
          username: "user",
          password: "secret",
          resource: "r",
          timeout: TIMEOUT_MS,
        });
        xmpp.reconnect.stop();
        const errors: Error[] = [];
        const sent: string[] = [];
        let armed = false;
        let attempted: Promise<unknown> | undefined;
        const attempt = () => {
          if (!armed || attempted) {
            return;
          }
          const first =
            payload === "stanza"
              ? xml(
                  "message",
                  { id: "forbidden", to: "peer@remote.test/r" },
                  xml("body", {}, "must not escape"),
                )
              : xml("notice", { xmlns: FOREIGN, id: "forbidden" });
          const last = xml("notice", { xmlns: FOREIGN, id: "forbidden-last" });
          attempted = (
            method === "send" ? xmpp.send(first) : xmpp.sendMany([first, last])
          ).then(
            () => "sent",
            (error: Error) => error,
          );
        };
        xmpp.on("error", (error: Error) => {
          errors.push(error);
          if (callback === "error") {
            attempt();
          }
        });
        xmpp.on("send", (element: Element) => {
          sent.push(element.attrs.id);
          if (callback === "owned error send" && element.is("error", STREAM)) {
            attempt();
          }
        });
        try {
          expect(String(await xmpp.start())).toBe(ACCOUNT);
          // Successful real-peer receipt establishes routing and a wire barrier.
          await xmpp.send(
            xml("message", { id: "before-failure", to: "peer@remote.test/r" }),
          );
          while (
            !readFrame(await first.next()).some(
              (event) =>
                "open" in event &&
                event.attributes["{}id"] === "before-failure",
            )
          ) {
            // Drain negotiation before recording the fatal-error transcript.
          }
          const before = first.transcript.length;
          armed = true;
          first.send(`<message xmlns="${CONTENT}"><body></message>`);
          const output: string[] = [];
          for (let index = 0; index < MAX_FATAL_FRAMES; index++) {
            const frame = await first.next();
            output.push(frame);
            if (frame === CLOSE) {
              break;
            }
          }
          expect(output.at(-1)).toBe(CLOSE);
          expect(await waitForDisconnect(xmpp, TIMEOUT_MS)).toBe(true);
          await first.waitForClose();
          expect(attempted).toBeDefined();
          const result = await attempted;
          expect({ callback, method, payload, result, output }).toMatchObject({
            result: expect.any(Error),
          });
          expect(sent).not.toContain("forbidden");
          expect(sent).not.toContain("forbidden-last");
          const roots = first.transcript
            .slice(before)
            .map((frame) => readFrame(frame)[0]);
          expect(roots).toEqual([
            { open: `{${STREAM}}error`, attributes: {} },
            { open: `{${FRAMING}}close`, attributes: {} },
          ]);
          expect(readFrame(first.transcript[before])).toContainEqual({
            open: `{${ERRORS}}not-well-formed`,
            attributes: {},
          });
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({
            name: "XMLError",
            condition: "not-well-formed",
          });
          expect(first.errors).toEqual([]);

          // Fatality belongs to the old transport, not every future session.
          armed = false;
          await xmpp.stop();
          Object.assign(xmpp.options, { service: next.url });
          expect(String(await xmpp.start())).toBe(ACCOUNT);
          await xmpp.send(
            xml("message", { id: "recovered", to: "peer@remote.test/r" }),
          );
          while (
            !readFrame(await next.next()).some(
              (event) =>
                "open" in event && event.attributes["{}id"] === "recovered",
            )
          ) {
            // Observe the new authenticated session's application traffic.
          }
          expect(
            next.transcript.some((frame) => frame.includes('id="recovered"')),
          ).toBe(true);
          expect(next.errors).toEqual([]);
          expect(errors).toHaveLength(1);
        } finally {
          await xmpp.stop();
          await first.stop();
          await next.stop();
        }
      });
    }
  }
}
