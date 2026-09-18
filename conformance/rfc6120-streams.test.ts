import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const AUTH = `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`;
const BINDING = `<bind xmlns="${BIND}"/>`;
const OPTIONAL = '<future xmlns="urn:test:optional"/>';
const WATCHDOG_MS = 500;

function negotiationPeer(before: string, after: string) {
  let authenticated = false;
  return new ScriptedPeer((frame, peer) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="${authenticated ? "second" : "first"}"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}">${authenticated ? after : before}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      peer.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === "{jabber:client}iq") {
      peer.send(
        `<iq xmlns="jabber:client" id="${root.attributes["{}id"]}" type="result"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
      peer.send(`<features xmlns="${STREAM}"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

test("RFC 6120 §§4.3.5/4.4: completion features cannot poison immediate stop", async () => {
  const peer = negotiationPeer(AUTH, BINDING);
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    await xmpp.start();
    await xmpp.stop();
    expect(errors).toEqual([]);
    expect(xmpp.status).toBe("offline");
  } finally {
    await peer.stop();
  }
});

test.each(["before", "after"])(
  "RFC 6120 §§4.3.2–4.3.5/7: optional features %s mandatory features",
  async (order) => {
    const offer = (required: string) =>
      order === "before" ? OPTIONAL + required : required + OPTIONAL;
    const peer = negotiationPeer(offer(AUTH), offer(BINDING));
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    const online: string[] = [];
    xmpp.on("online", (address: { toString(): string }) =>
      online.push(address.toString()),
    );
    try {
      expect((await xmpp.start()).toString()).toBe("user@example.test/r");
      expect(online).toEqual(["user@example.test/r"]);
      expect(peer.requests).toHaveLength(1);
      expect(
        peer.transcript
          .map((frame) => readFrame(frame)[0])
          .map((root) => ("open" in root ? root.open : "")),
      ).toEqual([
        `{${FRAMING}}open`,
        `{${SASL}}auth`,
        `{${FRAMING}}open`,
        "{jabber:client}iq",
      ]);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each([
  ["empty before authentication", "", BINDING],
  ["unknown before authentication", OPTIONAL, BINDING],
  [
    "unknown required convention",
    '<future xmlns="urn:test:future"><required/></future>',
    BINDING,
  ],
  ["empty before binding", AUTH, ""],
  ["unknown before binding", AUTH, OPTIONAL],
  ["stream namespace child", AUTH + "<future/>", BINDING],
  [
    "content namespace child",
    AUTH + '<future xmlns="jabber:client"/>',
    BINDING,
  ],
] as const)(
  "RFC 6120 §§4.3.2/7: fail incomplete negotiation / %s",
  async (_name, before, after) => {
    const peer = negotiationPeer(before, after);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    let online = 0;
    xmpp.on("online", () => online++);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = xmpp.start().catch((error: Error) => error);
    try {
      const result = await Promise.race([
        started,
        new Promise<Error>((resolve) => {
          timer = setTimeout(
            () => resolve(new Error("test watchdog: negotiation stalled")),
            WATCHDOG_MS,
          );
        }),
      ]);
      // A watchdog is only a test guard: timeout alone never proves rejection.
      expect(result.message).toMatch(
        /^(Unsupported stream features|Invalid stream feature namespace)$/,
      );
      expect(online).toBe(0);
      await peer.waitForClose();
      expect(peer.transcript.at(-1)).toBe(`<close xmlns="${FRAMING}"/>`);
      expect(peer.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
        false,
      );
      expect(errors).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      clearTimeout(timer);
      await xmpp.stop();
      await started;
      await peer.stop();
    }
  },
);

test.each([
  ["normal", `<policy-violation xmlns="${ERRORS}"/>`, "policy-violation"],
  ["unknown", `<future-condition xmlns="${ERRORS}"/>`, "undefined-condition"],
  [
    "wrong namespace",
    '<policy-violation xmlns="urn:test:application"/>',
    "undefined-condition",
  ],
  ["missing condition", "", "undefined-condition"],
] as const)(
  "RFC 6120 §§4.9.1–4.9.2: stream error closes without a loop / %s",
  async (_name, condition, expected) => {
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open")) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" id="failure" version="1.0"/>`,
        );
        remote.send(
          `<error xmlns="${STREAM}"><text xmlns="${ERRORS}" xml:lang="en">Diagnostic</text>${condition}<detail xmlns="urn:test:detail"/></error>`,
        );
      } else if (frame.startsWith("<close")) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
    const xmpp = client({ service: peer.url, domain: "example.test" });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      const result = await xmpp.start().catch((error: Error) => error);
      expect(result.name).toBe("StreamError");
      expect(result.condition).toBe(expected);
      expect(result.text).toBe("Diagnostic");
      await peer.waitForClose();
      expect(peer.transcript).toHaveLength(2);
      expect(peer.transcript[1]).toBe(`<close xmlns="${FRAMING}"/>`);
      expect(errors).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
