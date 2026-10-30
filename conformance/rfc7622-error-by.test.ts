import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { Element as XMLElement } from "../src/xml/index.js";
import { outgoingPresence } from "../src/connection/lib/outgoingPresence.ts";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const SM = "urn:xmpp:sm:3";
const APP = "urn:test:error-by";
type Path = "send" | "sendMany" | "generated IQ error";
const PATHS: Path[] = ["send", "sendMany", "generated IQ error"];
const PAYLOAD = `<query xmlns="${APP}"/>`;
const FALLBACK = `<error type="cancel"><internal-server-error xmlns="${STANZAS}"/></error>`;

// RFC 6120 §8.3.1 rule 5 defines by as a JID. RFC 7622 §4 is a client
// SHOULD; these tests enforce the project's strict outgoing preparation policy.
// https://www.rfc-editor.org/rfc/rfc7622.html#section-4
async function session(
  exercise: (
    xmpp: ReturnType<typeof client>,
    peer: ScriptedPeer,
    errors: Error[],
  ) => Promise<void>,
) {
  let authenticated = false;
  const enabled = Promise.withResolvers<void>();
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="by" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CONTENT}}iq` && frame.includes(BIND)) {
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}" id="by-sm" resume="true"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      root.attributes["{}id"] === "barrier"
    ) {
      remote.send(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  xmpp.streamManagement.requestAckInterval = 0;
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  xmpp.on("nonza", (element: Element) => {
    if (element.is("enabled", SM)) {
      enabled.resolve();
    }
  });
  try {
    await xmpp.start();
    await enabled.promise;
    await xmpp.iqCaller.request(
      xml("iq", { id: "barrier", type: "get" }, xml("query", APP)),
    );
    expect(xmpp.streamManagement.enabled).toBe(true);
    await flushWire(xmpp, peer);
    await exercise(xmpp, peer, errors);
    expect(xmpp.status).toBe("online");
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
}

// A foreign nonza orders wire observations without adding an SM queue entry.
async function flushWire(xmpp: ReturnType<typeof client>, peer: ScriptedPeer) {
  await xmpp.send(xml("sync", APP));
  while (true) {
    const root = readFrame(await peer.next())[0];
    if ("open" in root && root.open === `{${APP}}sync`) {
      return;
    }
  }
}

function errorElement(by?: unknown) {
  const error = new XMLElement("error", {
    type: "cancel",
    ...(by === undefined ? {} : { by }),
  });
  error.append(xml("forbidden", STANZAS));
  return error;
}

// One real peer exercises public sends and the callee's generated-error path.
async function exchange(
  xmpp: ReturnType<typeof client>,
  peer: ScriptedPeer,
  path: Path,
  error: Element,
) {
  if (path === "generated IQ error") {
    xmpp.iqCallee.get(APP, "query", () => error);
    peer.send(
      `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="by-test" type="get">${PAYLOAD}</iq>`,
    );
    // Missing fallback replies must fail an assertion, not escape as a timeout.
    const response = await peer.next().catch((error: Error) => error);
    expect(response).toBeString();
    return undefined;
  }
  const value = xml(
    path === "send" ? "message" : "presence",
    { id: "by-test", type: "error" },
    error,
  );
  return (path === "send" ? xmpp.send(value) : xmpp.sendMany([value])).then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

function expectedFrame(path: Path, body: string, type = "error") {
  if (path === "generated IQ error") {
    return readFrame(
      `<iq xmlns="${CONTENT}" to="sender@remote.test/s" from="user@example.test/r" id="by-test" type="${type}">${PAYLOAD}${body}</iq>`,
    );
  }
  const kind = path === "send" ? "message" : "presence";
  return readFrame(
    `<${kind} xmlns="${CONTENT}" id="by-test" type="${type}">${body}</${kind}>`,
  );
}

function frames(peer: ScriptedPeer, offset: number) {
  return peer.transcript
    .slice(offset)
    .filter((frame) => {
      const root = readFrame(frame)[0];
      return "open" in root && root.attributes["{}id"] === "by-test";
    })
    .map(readFrame);
}

// Expected strings are independent literals, not values prepared by production.
const valid = [
  { name: "absent optional by", input: undefined, expected: undefined },
  {
    name: "Unicode bare JID",
    input: "E\u0301@XN--BCHER-KVA.example",
    expected: "é@bücher.example",
  },
  {
    name: "Unicode full JID",
    input: "E\u0301@XN--BCHER-KVA.example/R\u00a0X",
    expected: "é@bücher.example/R X",
  },
  {
    name: "1023-byte resourcepart",
    input: `user@example.test/${"😀".repeat(255)}abc`,
    expected: `user@example.test/${"😀".repeat(255)}abc`,
  },
  {
    name: "NFC contraction before byte limit",
    input: `${"e\u0301".repeat(511)}a@example.test`,
    expected: `${"é".repeat(511)}a@example.test`,
  },
];

for (const vector of valid) {
  test.each(PATHS)(
    `RFC 7622 §§3/4: %s prepares error ${vector.name}`,
    async (path) => {
      await session(async (xmpp, peer, errors) => {
        const offset = peer.transcript.length;
        const queued = xmpp.streamManagement.outbound_q.length;
        expect(
          await exchange(xmpp, peer, path, errorElement(vector.input)),
        ).toBeUndefined();
        await flushWire(xmpp, peer);
        const by =
          vector.expected === undefined ? "" : ` by="${vector.expected}"`;
        expect(frames(peer, offset)).toEqual([
          expectedFrame(
            path,
            `<error type="cancel"${by}><forbidden xmlns="${STANZAS}"/></error>`,
          ),
        ]);
        expect(xmpp.streamManagement.outbound_q).toHaveLength(queued + 1);
        expect(errors).toEqual([]);
      });
    },
  );
}

const invalid = [
  { name: "empty localpart", input: "@example.test" },
  { name: "1024-byte localpart", input: `${"a".repeat(1024)}@example.test` },
  {
    name: "1024-byte resourcepart",
    input: `user@example.test/${"😀".repeat(256)}`,
  },
];

async function rejectsBeforeAdmission(path: Path, create: () => Element) {
  await session(async (xmpp, peer, errors) => {
    const offset = peer.transcript.length;
    const queued = xmpp.streamManagement.outbound_q.length;
    const sent: Element[] = [];
    xmpp.on("send", (element: Element) => {
      if (element.attrs.id === "by-test") {
        sent.push(element);
      }
    });
    const outcome = await exchange(xmpp, peer, path, create());
    await flushWire(xmpp, peer);
    if (path === "generated IQ error") {
      // Invalid callback output is replaced by a safe error, not left unanswered.
      expect(frames(peer, offset)).toEqual([expectedFrame(path, FALLBACK)]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(sent).toHaveLength(1);
      expect(xmpp.streamManagement.outbound_q).toHaveLength(queued + 1);
    } else {
      expect(outcome).toBeInstanceOf(Error);
      expect(frames(peer, offset)).toEqual([]);
      expect(sent).toEqual([]);
      expect(xmpp.streamManagement.outbound_q).toHaveLength(queued);
      expect(errors).toEqual([]);
    }
  });
}

for (const vector of invalid) {
  test.each(PATHS)(
    `RFC 7622 §§3/4: %s rejects error by ${vector.name} before write/SM`,
    async (path) => {
      await rejectsBeforeAdmission(path, () => errorElement(vector.input));
    },
  );
}

test.each(PATHS)(
  "RFC 7622 §4: %s converts scalar error by once",
  async (path) => {
    await session(async (xmpp, peer, errors) => {
      let calls = 0;
      const by = {
        toString() {
          calls += 1;
          return calls === 1 ? "EXAMPLE.TEST." : "@example.test";
        },
      };
      const offset = peer.transcript.length;
      expect(
        await exchange(xmpp, peer, path, errorElement(by)),
      ).toBeUndefined();
      await flushWire(xmpp, peer);
      expect(frames(peer, offset)).toEqual([
        expectedFrame(
          path,
          `<error type="cancel" by="example.test"><forbidden xmlns="${STANZAS}"/></error>`,
        ),
      ]);
      expect(calls).toBe(1);
      expect(errors).toEqual([]);
    });
  },
);

for (const change of ["earlier scalar", "custom writer"]) {
  test.each(PATHS)(
    `RFC 7622 §4: %s validates error by emitted by ${change}`,
    async (path) => {
      await rejectsBeforeAdmission(path, () => {
        const error = errorElement("example.test");
        if (change === "earlier scalar") {
          const scalar = {
            toString() {
              error.attrs.by = "@example.test";
              return "detail";
            },
          };
          error.attrs = { type: "cancel", detail: scalar, by: "example.test" };
        } else {
          (
            error as Element & {
              write: (writer: (source: string) => void) => void;
            }
          ).write = (writer) => {
            writer(
              `<error type="cancel" by="@example.test"><forbidden xmlns="${STANZAS}"/></error>`,
            );
          };
        }
        return error;
      });
    },
  );
}

test("RFC 6120 §§8.3.1/8.4: sends preserve opaque foreign error by", async () => {
  for (const method of ["send", "sendMany"] as const) {
    await session(async (xmpp, peer, errors) => {
      const value = xml(
        "message",
        { id: "by-test" },
        xml("error", { xmlns: APP, by: "@example.test" }),
      );
      const offset = peer.transcript.length;
      await (method === "send" ? xmpp.send(value) : xmpp.sendMany([value]));
      await flushWire(xmpp, peer);
      expect(frames(peer, offset)).toEqual([
        readFrame(
          `<message xmlns="${CONTENT}" id="by-test"><error xmlns="${APP}" by="@example.test"/></message>`,
        ),
      ]);
      expect(errors).toEqual([]);
    });
  }
});

test("RFC 6120 §8.4: generated foreign error by stays an opaque IQ result", async () => {
  await session(async (xmpp, peer, errors) => {
    const foreign = xml("error", { xmlns: APP, by: "@example.test" });
    const offset = peer.transcript.length;
    await exchange(xmpp, peer, "generated IQ error", foreign);
    await flushWire(xmpp, peer);
    // The request payload is not copied into a result.
    expect(frames(peer, offset)).toEqual([
      readFrame(
        `<iq xmlns="${CONTENT}" to="sender@remote.test/s" from="user@example.test/r" id="by-test" type="result"><error xmlns="${APP}" by="@example.test"/></iq>`,
      ),
    ]);
    expect(errors).toEqual([]);
  });
});

test.each(PATHS)(
  "RFC 7622 §4: %s validates writer output without evaluating discarded tree by",
  async (path) => {
    for (const treeBy of ["@example.test", "throwing scalar"]) {
      await session(async (xmpp, peer, errors) => {
        let calls = 0;
        let writes = 0;
        const by =
          treeBy === "throwing scalar"
            ? {
                toString() {
                  calls += 1;
                  throw new Error(
                    "Discarded tree attribute must not be evaluated",
                  );
                },
              }
            : treeBy;
        const error = errorElement(by) as Element & {
          write: (writer: (source: string) => void) => void;
        };
        error.write = (writer) => {
          writes += 1;
          writer(
            `<error type="cancel" by="example.test"><forbidden xmlns="${STANZAS}"/></error>`,
          );
        };
        const offset = peer.transcript.length;
        expect(await exchange(xmpp, peer, path, error)).toBeUndefined();
        await flushWire(xmpp, peer);
        expect(frames(peer, offset)).toEqual([
          expectedFrame(
            path,
            `<error type="cancel" by="example.test"><forbidden xmlns="${STANZAS}"/></error>`,
          ),
        ]);
        expect(calls).toBe(0);
        expect(writes).toBe(1);
        expect(errors).toEqual([]);
      });
    }
  },
);

test.each(PATHS)(
  "RFC 7622 §4: %s prepares a single captured writer snapshot",
  async (path) => {
    await session(async (xmpp, peer, errors) => {
      const error = errorElement("example.test") as Element & {
        write: (writer: (source: string) => void) => void;
      };
      let writes = 0;
      error.write = (writer) => {
        writes += 1;
        writer(
          `<error type="cancel" by="E\u0301@XN--BCHER-KVA.example/R\u00a0X"><forbidden xmlns="${STANZAS}"/></error>`,
        );
      };
      const offset = peer.transcript.length;
      expect(await exchange(xmpp, peer, path, error)).toBeUndefined();
      await flushWire(xmpp, peer);
      expect(frames(peer, offset)).toEqual([
        expectedFrame(
          path,
          `<error type="cancel" by="é@bücher.example/R X"><forbidden xmlns="${STANZAS}"/></error>`,
        ),
      ]);
      expect(writes).toBe(1);
      expect(errors).toEqual([]);
    });
  },
);

test("RFC 6120 §§8.3.1/8.4: rewriting core by leaves qualified and nested extension attributes opaque", async () => {
  await session(async (xmpp, peer, errors) => {
    const error = xml(
      "error",
      {
        type: "cancel",
        by: "EXAMPLE.TEST.",
        "xmlns:app": APP,
        "app:by": "@example.test",
      },
      xml("forbidden", STANZAS),
      xml(
        "detail",
        { xmlns: APP, by: "@example.test" },
        xml("error", { xmlns: CONTENT, by: "@example.test" }),
      ),
    );
    const value = xml(
      "message",
      { id: "by-test", type: "error" },
      xml("error", { xmlns: APP, by: "@example.test" }),
      error,
    );
    const offset = peer.transcript.length;
    await xmpp.send(value);
    await flushWire(xmpp, peer);
    expect(frames(peer, offset)).toEqual([
      readFrame(
        `<message xmlns="${CONTENT}" id="by-test" type="error"><error xmlns="${APP}" by="@example.test"/><error xmlns:app="${APP}" type="cancel" by="example.test" app:by="@example.test"><forbidden xmlns="${STANZAS}"/><detail xmlns="${APP}" by="@example.test"><error xmlns="${CONTENT}" by="@example.test"/></detail></error></message>`,
      ),
    ]);
    expect(errors).toEqual([]);
  });
});

test("RFC 7622 §4: sendMany rejects unprepared error by introduced during presence preparation", async () => {
  await session(async (xmpp, peer, errors) => {
    const previous = outgoingPresence.get(xmpp);
    const sent: Element[] = [];
    let calls = 0;
    let replacementBy = "example.test";
    xmpp.on("send", (element: Element) => {
      if (element.attrs.id === "by-test") {
        sent.push(element);
      }
    });
    outgoingPresence.set(xmpp, async (_source, original) => {
      calls += 1;
      expect(original.is("presence", CONTENT)).toBe(true);
      return xml(
        "presence",
        { xmlns: CONTENT, id: "by-test", type: "error" },
        errorElement(replacementBy),
      );
    });
    try {
      const value = xml(
        "presence",
        { id: "by-test", type: "error" },
        errorElement("example.test"),
      );
      const controlOffset = peer.transcript.length;
      await expect(xmpp.sendMany([value])).resolves.toBeUndefined();
      await flushWire(xmpp, peer);
      expect(frames(peer, controlOffset)).toEqual([
        expectedFrame(
          "sendMany",
          `<error type="cancel" by="example.test"><forbidden xmlns="${STANZAS}"/></error>`,
        ),
      ]);
      expect(sent).toHaveLength(1);
      sent.length = 0;
      replacementBy = "EXAMPLE.TEST.";
      const queued = [...xmpp.streamManagement.outbound_q];
      const offset = peer.transcript.length;
      const outcome = await xmpp.sendMany([value]).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      await flushWire(xmpp, peer);
      expect(calls).toBe(2);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).cause).toMatchObject({
        message: "Unprepared stanza error by address",
      });
      expect(frames(peer, offset)).toEqual([]);
      expect(sent).toEqual([]);
      expect(xmpp.streamManagement.outbound_q).toEqual(queued);
      expect(errors).toEqual([]);
    } finally {
      if (previous) {
        outgoingPresence.set(xmpp, previous);
      } else {
        outgoingPresence.delete(xmpp);
      }
    }
  });
});
