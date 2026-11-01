import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer, waitForDisconnect } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const APP = "urn:test:namespace-uris";
const CLOSE_TIMEOUT_MS = 250;
const OBSERVATION_TIMEOUT_MS = 500;
const METHODS: ("send" | "sendMany")[] = ["send", "sendMany"];
const OPTIONS = {
  domain: "example.test",
  username: "user",
  password: "secret",
};

// Namespaces 1.0 §§3/7 require declaration values to be URI references or empty.
// The §8 processor checking exemption is not a sender-generation exemption.
// RFC 6120 §11.3 rule 4 separately forbids accepting nonconforming XMPP input;
// generic HTTP XML processing is outside this suite.
// https://www.w3.org/TR/REC-xml-names/#ns-decl
// https://www.rfc-editor.org/rfc/rfc6120.html#section-11.3
async function session(
  exercise: (
    xmpp: ReturnType<typeof client>,
    peer: ScriptedPeer,
    errors: Error[],
  ) => Promise<void>,
  ending: "online" | "disconnect" = "online",
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
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="namespace-uris"/>`,
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
      remote.send(
        `<enabled xmlns="${SM}" id="namespace-uris-sm" resume="true"/>`,
      );
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
    ...OPTIONS,
    service: peer.url,
    timeout: CLOSE_TIMEOUT_MS,
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
    await barrier(xmpp);
    expect(xmpp.streamManagement.enabled).toBe(true);
    await exercise(xmpp, peer, errors);
    if (ending === "online") {
      expect(errors).toEqual([]);
    }
    expect(peer.errors).toEqual([]);
    expect(xmpp.status).toBe(ending);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
}

// A matching reply observes preceding writes without an arbitrary sleep.
async function barrier(xmpp: ReturnType<typeof client>) {
  await xmpp.iqCaller.request(
    xml("iq", { id: "barrier", type: "get" }, xml("query", APP)),
  );
}

const invalid = [
  [
    "literal Unicode rather than an RFC 3986 URI reference",
    () => xml("p:body", { "xmlns:p": "urn:żółć" }),
  ],
  [
    "prefixed descendant with space",
    () => xml("p:body", { "xmlns:p": "urn:bad space" }),
  ],
  [
    "default descendant with malformed percent escape",
    () => xml("body", { xmlns: "urn:bad%ZZ" }),
  ],
  [
    "unused declaration with incomplete percent escape",
    () => xml("body", { "xmlns:unused": "urn:bad%2" }),
  ],
  [
    "unused ancestor declaration with reverse solidus",
    () => xml("body", { "xmlns:unused": "urn:bad\\path" }, xml("label")),
  ],
  [
    "relative authority with unmatched bracket",
    () => xml("body", { xmlns: "//[broken/path" }),
  ],
  [
    "relative first segment with forbidden colon",
    () => xml("body", { "xmlns:p": "1bad:relative" }),
  ],
] as const;

for (const [name, payload] of invalid) {
  test.each(METHODS)(
    `RFC 6120 §11.3 / Namespaces §3: %s rejects ${name} before admission`,
    async (method) => {
      await session(async (xmpp, peer) => {
        const sent: string[] = [];
        xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
        const before = [...xmpp.streamManagement.outbound_q];
        const stanza = xml("message", { id: "invalid" }, payload());
        const result = await (
          method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza])
        ).then(
          () => undefined,
          (error: Error) => error,
        );
        expect(result).toBeInstanceOf(TypeError);
        expect(sent).toEqual([]);
        expect(xmpp.streamManagement.outbound_q).toEqual(before);
        await barrier(xmpp);
        expect(
          peer.transcript.some((frame) => frame.includes('id="invalid"')),
        ).toBe(false);
        expect(sent).toEqual(["barrier"]);
      });
    },
  );
}

// Relative references are deprecated, not prohibited. Comparison is lexical:
// Namespaces §2.3 forbids case folding and percent-decoding namespace identity.
const valid = [
  "urn:%C5%BC%C3%B3%C5%82%C4%87",
  "relative/path",
  "../relative",
  "#fragment",
  "urn:Example:%2f",
  "urn:example:%2F",
  "//example.test/path",
];
for (const namespace of valid) {
  test.each(METHODS)(
    `Namespaces §§2.2/2.3/3: %s preserves URI reference ${namespace}`,
    async (method) => {
      await session(async (xmpp, peer) => {
        const stanza = xml(
          "message",
          { id: "valid" },
          xml("p:body", { "xmlns:p": namespace }, "text"),
        );
        await (method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza]));
        await barrier(xmpp);
        expect(
          peer.transcript.filter((frame) => frame.includes('id="valid"')),
        ).toEqual([
          `<message id="valid" xmlns="${CONTENT}"><p:body xmlns:p="${namespace}">text</p:body></message>`,
        ]);
      });
    },
  );
}

test.each(METHODS)(
  "Namespaces §6.2: %s preserves empty default namespace cancellation",
  async (method) => {
    await session(async (xmpp, peer) => {
      const stanza = xml(
        "message",
        { id: "cancel" },
        xml("extra", { xmlns: APP }, xml("plain", { xmlns: "" })),
      );
      await (method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza]));
      await barrier(xmpp);
      expect(
        peer.transcript.filter((frame) => frame.includes('id="cancel"')),
      ).toEqual([
        `<message id="cancel" xmlns="${CONTENT}"><extra xmlns="${APP}"><plain xmlns=""/></extra></message>`,
      ]);
    });
  },
);

for (const method of METHODS) {
  test(`RFC 6120 §11.3: ${method} rejects namespace whitespace hidden by a character reference`, async () => {
    await session(async (xmpp, peer) => {
      const stanza = xml("message", { id: "invalid" });
      stanza.write = (writer: (part: string) => void) => {
        writer(
          `<message id="invalid" xmlns="${CONTENT}" xmlns:unused="urn:bad&#x20;space"/>`,
        );
      };
      const before = [...xmpp.streamManagement.outbound_q];
      const result = await (
        method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza])
      ).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(result).toBeInstanceOf(TypeError);
      expect(xmpp.streamManagement.outbound_q).toEqual(before);
      await barrier(xmpp);
      expect(
        peer.transcript.some((frame) => frame.includes('id="invalid"')),
      ).toBe(false);
    });
  });

  test(`RFC 6120 §11.3: ${method} rejects a foreign nonza root's invalid namespace`, async () => {
    await session(async (xmpp, peer) => {
      const nonza = xml("notice", { id: "invalid", xmlns: "urn:bad space" });
      const result = await (
        method === "send" ? xmpp.send(nonza) : xmpp.sendMany([nonza])
      ).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(result).toBeInstanceOf(TypeError);
      await barrier(xmpp);
      expect(
        peer.transcript.some((frame) => frame.includes('id="invalid"')),
      ).toBe(false);
    });
  });

  test(`RFC 6120 §11.3: ${method} rejects custom writer's unused invalid declaration once`, async () => {
    await session(async (xmpp, peer) => {
      const stanza = xml(
        "message",
        { id: "invalid" },
        xml("body", { xmlns: APP }),
      );
      let writes = 0;
      stanza.write = (writer: (part: string) => void) => {
        writes += 1;
        writer(
          `<message id="invalid" xmlns="${CONTENT}"><body xmlns="${APP}" xmlns:unused="urn:bad space"/></message>`,
        );
      };
      const before = [...xmpp.streamManagement.outbound_q];
      const result = await (
        method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza])
      ).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(result).toBeInstanceOf(TypeError);
      expect(writes).toBe(1);
      expect(xmpp.streamManagement.outbound_q).toEqual(before);
      await barrier(xmpp);
      expect(
        peer.transcript.some((frame) => frame.includes('id="invalid"')),
      ).toBe(false);
    });
  });

  test(`RFC 6120 §11.3: ${method} does not reuse callback-mutated namespace authority`, async () => {
    await session(async (xmpp, peer) => {
      const body = xml("p:body", { "xmlns:p": APP });
      const stanza = xml("message", { id: "snapshot" }, body);
      const sent: string[] = [];
      xmpp.on("send", (element: Element) => {
        sent.push(element.attrs.id);
        if (element === stanza) {
          body.attrs["xmlns:p"] = "urn:bad space";
        }
      });
      await (method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza]));
      const before = [...xmpp.streamManagement.outbound_q];
      const result = await (
        method === "send" ? xmpp.send(stanza) : xmpp.sendMany([stanza])
      ).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(result).toBeInstanceOf(TypeError);
      expect(xmpp.streamManagement.outbound_q).toEqual(before);
      await barrier(xmpp);
      expect(sent).toEqual(["snapshot", "barrier"]);
      expect(
        peer.transcript.filter((frame) => frame.includes('id="snapshot"')),
      ).toEqual([
        `<message id="snapshot" xmlns="${CONTENT}"><p:body xmlns:p="${APP}"/></message>`,
      ]);
    });
  });
}

test("RFC 6120 §11.3: sendMany rejects invalid namespace without discarding prior admission", async () => {
  await session(async (xmpp, peer) => {
    const before = [...xmpp.streamManagement.outbound_q];
    const sent: string[] = [];
    xmpp.on("send", (element: Element) => sent.push(element.attrs.id));
    const result = await xmpp
      .sendMany([
        xml("message", { id: "first" }),
        xml("message", { id: "invalid", "xmlns:unused": "urn:bad space" }),
        xml("message", { id: "last" }),
      ])
      .then(
        () => undefined,
        (error: Error) => error,
      );
    expect(result).toBeInstanceOf(TypeError);
    expect(sent).toEqual(["first"]);
    expect(xmpp.streamManagement.outbound_q).toHaveLength(before.length + 1);
    expect(xmpp.streamManagement.outbound_q.slice(0, before.length)).toEqual(
      before,
    );
    await barrier(xmpp);
    expect(
      peer.transcript.filter((frame) =>
        /id="(?:first|invalid|last)"/.test(frame),
      ),
    ).toEqual([`<message id="first" xmlns="${CONTENT}"/>`]);
  });
});

for (const [name, source] of [
  [
    "nested space",
    `<message xmlns="${CONTENT}" id="bad-input"><p:body xmlns:p="urn:bad space"/></message>`,
  ],
  [
    "unused malformed escape",
    `<message xmlns="${CONTENT}" id="bad-input" xmlns:unused="urn:bad%ZZ"/>`,
  ],
  ["foreign root", '<notice xmlns="urn:bad space" id="bad-input"/>'],
] as const) {
  test(`RFC 6120 §11.3 rule 4: reject received ${name} before public delivery`, async () => {
    await session(async (xmpp, peer, errors) => {
      const delivered: string[] = [];
      const marker = Promise.withResolvers<"marker">();
      const observe = (element: Element) => {
        if (element.attrs.id === "bad-input") {
          delivered.push(element.name);
        }
        if (element.attrs.id === "after") {
          marker.resolve("marker");
        }
      };
      xmpp.on("stanza", observe);
      xmpp.on("nonza", observe);
      peer.send(source);
      peer.send(`<notice xmlns="${APP}" id="after"/>`);
      const result = await Promise.race([
        marker.promise,
        waitForDisconnect(xmpp, OBSERVATION_TIMEOUT_MS).then((closed) =>
          closed ? "closed" : "pending",
        ),
      ]);
      expect(delivered).toEqual([]);
      expect(result).toBe("closed");
      expect(errors).toHaveLength(1);
      const output = peer.transcript.filter(
        (frame) => frame.includes(STREAM) || frame.startsWith("<close"),
      );
      expect(output).toHaveLength(2);
      expect(readFrame(output[0])[0]).toMatchObject({
        open: `{${STREAM}}error`,
      });
      expect(output[1]).toBe(`<close xmlns="${FRAMING}"/>`);
    }, "disconnect");
  });
}

test("Namespaces §§2.2/2.3: receive relative and fragment namespace references without rewriting", async () => {
  await session(async (xmpp, peer) => {
    const received = Promise.withResolvers<Element>();
    xmpp.on("stanza", (element: Element) => received.resolve(element));
    peer.send(
      `<message xmlns="${CONTENT}" id="relative"><p:body xmlns:p="../relative"/><f:body xmlns:f="#fragment"/></message>`,
    );
    const stanza = await received.promise;
    expect(stanza.children.map((child) => (child as Element).getNS())).toEqual([
      "../relative",
      "#fragment",
    ]);
    await barrier(xmpp);
  });
});

test.each(["opening", "features"])(
  "RFC 6120 §11.3 rule 4: %s rejects unused invalid namespace declarations",
  async (stage) => {
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open")) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" version="1.0"${stage === "opening" ? ' xmlns:unused="urn:bad space"' : ""}/>`,
        );
        if (stage === "features") {
          remote.send(
            `<features xmlns="${STREAM}" xmlns:unused="urn:bad%ZZ"/>`,
          );
        }
      } else if (frame.startsWith("<close")) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
    const xmpp = client({
      ...OPTIONS,
      service: peer.url,
      timeout: CLOSE_TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    const delivered: string[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    xmpp.on("open", () => {
      if (stage === "opening") {
        delivered.push("opening");
      }
    });
    xmpp.on("nonza", (element: Element) => {
      if (stage === "features" && element.is("features", STREAM)) {
        delivered.push("features");
      }
    });
    try {
      await xmpp.connect(peer.url);
      await xmpp.open(OPTIONS).catch(() => undefined);
      const closed = await waitForDisconnect(xmpp, OBSERVATION_TIMEOUT_MS);
      expect(delivered).toEqual([]);
      expect(closed).toBe(true);
      expect(errors).toHaveLength(1);
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<close")),
      ).toEqual([`<close xmlns="${FRAMING}"/>`]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §11.3 / RFC 7395 §3.4: opening rejects an unused malformed namespace and permits retry", async () => {
  const peer = new ScriptedPeer((frame, remote) => {
    if (frame.startsWith("<open")) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="retry"/>`,
      );
    } else if (frame.startsWith("<close")) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
  const xmpp = client({ ...OPTIONS, service: peer.url });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  const original = xmpp.headerElement;
  xmpp.headerElement = function () {
    const header = original.call(this);
    header.attrs["xmlns:unused"] = "urn:bad space";
    return header;
  };
  try {
    await xmpp.connect(peer.url);
    const result = await xmpp.open(OPTIONS).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(result).toBeInstanceOf(TypeError);
    expect(peer.transcript).toEqual([]);
    xmpp.headerElement = original;
    await xmpp.open(OPTIONS);
    expect(await peer.next()).toBe(
      `<open version="1.0" xmlns="${FRAMING}" to="example.test" from="user@example.test"/>`,
    );
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    xmpp.headerElement = original;
    await xmpp.stop();
    await peer.stop();
  }
});
