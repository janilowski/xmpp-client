import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
// @ts-expect-error ltx ships no declarations for its ES module constructor.
import SourceElement from "ltx/src/Element.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const SERVER = "jabber:server";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const PING = "urn:xmpp:ping";
const FOREIGN = "urn:test:extension";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const METHODS: ("send" | "sendMany")[] = ["send", "sendMany"];

async function session(reply?: (frame: string, peer: ScriptedPeer) => void) {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="prefixes" version="1.0"/>`,
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
      remote.send(`<enabled xmlns="${SM}" id="prefix-sm" resume="true"/>`);
    } else if (
      root.open === `{${CONTENT}}iq` &&
      root.attributes["{}id"] === "barrier"
    ) {
      remote.send(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
    reply?.(frame, remote);
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  const enabled = new Promise<void>((resolve) => {
    const handler = (element: {
      is(name: string, namespace: string): boolean;
    }) => {
      if (element.is("enabled", SM)) {
        xmpp.off("nonza", handler);
        resolve();
      }
    };
    xmpp.on("nonza", handler);
  });
  try {
    await xmpp.start();
    await enabled;
  } catch (error) {
    await xmpp.stop();
    await peer.stop();
    throw error;
  }
  return { xmpp, peer, errors };
}

const prohibited = [
  {
    name: "external ES module ltx child",
    element: () =>
      xml(
        "message",
        { id: "invalid" },
        new SourceElement("c:body", { "xmlns:c": CONTENT }),
      ),
  },
  ...["root", "descendant"].map((scope) => ({
    name: `custom serializer ${scope}`,
    element: () => {
      const element = xml("message", { id: "invalid" });
      element.toString = () =>
        scope === "root"
          ? `<c:message xmlns:c="${CONTENT}" id="invalid"/>`
          : `<message xmlns="${CONTENT}" id="invalid"><c:body xmlns:c="${CONTENT}"/></message>`;
      return element;
    },
  })),
  ...["message", "presence", "iq", "custom"].map((name) => ({
    name: `root ${name}`,
    element: () => xml(`c:${name}`, { "xmlns:c": CONTENT, id: "invalid" }),
  })),
  {
    name: "body inherits its prefix binding",
    element: () =>
      xml(
        "message",
        { "xmlns:c": CONTENT, id: "invalid" },
        xml("c:body", {}, "body"),
      ),
  },
  {
    name: "error binds its prefix locally",
    element: () =>
      xml(
        "iq",
        { type: "error", id: "invalid" },
        xml(
          "c:error",
          { "xmlns:c": CONTENT, type: "cancel" },
          xml("service-unavailable", { xmlns: STANZAS }),
        ),
      ),
  },
  {
    name: "content element inside a foreign root",
    element: () =>
      xml(
        "extension",
        { xmlns: FOREIGN, id: "invalid" },
        xml("c:message", { "xmlns:c": CONTENT }),
      ),
  },
  {
    name: "prefix rebound from foreign to content",
    element: () =>
      xml(
        "message",
        { "xmlns:c": FOREIGN, id: "invalid" },
        xml("c:body", { "xmlns:c": CONTENT }, "body"),
      ),
  },
  {
    name: "content binding inherited through foreign descendants",
    element: () =>
      xml(
        "message",
        { "xmlns:c": CONTENT, id: "invalid" },
        xml(
          "extension",
          { xmlns: FOREIGN },
          xml("container", {}, xml("c:body", {}, "body")),
        ),
      ),
  },
  {
    name: "a foreign sibling rebinding does not change content binding",
    element: () =>
      xml(
        "message",
        { "xmlns:c": CONTENT, id: "invalid" },
        xml("c:notice", { "xmlns:c": FOREIGN }),
        xml("c:body", {}, "body"),
      ),
  },
];

// RFC 6120 §4.8.5 applies to every content-qualified element, not just roots.
// Local policy rejects invalid caller XML rather than silently rewriting it.
for (const { name, element } of prohibited) {
  test.each(METHODS)(
    `RFC 6120 §4.8.5: %s rejects a prefixed content element before writing / ${name}`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      const sent: string[] = [];
      xmpp.on("send", (stanza: { attrs: { id?: string } }) => {
        if (stanza.attrs.id) {
          sent.push(stanza.attrs.id);
        }
      });
      try {
        const pending =
          method === "send" ? xmpp.send(element()) : xmpp.sendMany([element()]);
        const result = await pending.then(
          () => undefined,
          (error: Error) => error,
        );
        expect(result).toBeInstanceOf(TypeError);
        await xmpp.iqCaller.request(
          xml(
            "iq",
            { type: "get", id: "barrier" },
            xml("ping", { xmlns: PING }),
          ),
        );
        expect(
          peer.transcript.some((frame) =>
            readFrame(frame).some(
              (event) =>
                "open" in event && event.attributes["{}id"] === "invalid",
            ),
          ),
        ).toBe(false);
        expect(sent).toEqual(["barrier"]);
        expect(
          xmpp.streamManagement.outbound_q.some(
            ({ stanza }: { stanza: { attrs: { id?: string } } }) =>
              stanza.attrs.id === "invalid",
          ),
        ).toBe(false);
        expect(xmpp.status).toBe("online");
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

const permitted = [
  {
    name: "external ES module ltx foreign child",
    element: () =>
      xml(
        "message",
        { id: "valid" },
        new SourceElement("c:body", { "xmlns:c": FOREIGN }),
      ),
    expected: `<message xmlns="${CONTENT}" id="valid"><c:body xmlns:c="${FOREIGN}"/></message>`,
  },
  {
    name: "custom serializer with a foreign prefix",
    element: () => {
      const element = xml("message", { id: "valid" });
      element.toString = () =>
        `<message xmlns="${CONTENT}" id="valid"><c:body xmlns:c="${FOREIGN}"/></message>`;
      return element;
    },
    expected: `<message xmlns="${CONTENT}" id="valid"><c:body xmlns:c="${FOREIGN}"/></message>`,
  },
  {
    name: "a foreign prefixed root",
    element: () =>
      xml("c:notice", { "xmlns:c": FOREIGN, id: "valid" }, "extension"),
    expected: `<c:notice xmlns:c="${FOREIGN}" xmlns="${CONTENT}" id="valid">extension</c:notice>`,
  },
  {
    name: "a foreign prefixed payload",
    element: () =>
      xml(
        "message",
        { "xmlns:c": FOREIGN, id: "valid" },
        xml("c:body", {}, "extension"),
      ),
    expected: `<message xmlns="${CONTENT}" xmlns:c="${FOREIGN}" id="valid"><c:body>extension</c:body></message>`,
  },
  {
    name: "an unused content prefix declaration",
    element: () =>
      xml(
        "message",
        { "xmlns:c": CONTENT, id: "valid" },
        xml("body", {}, "c:body"),
      ),
    expected: `<message xmlns="${CONTENT}" xmlns:c="${CONTENT}" id="valid"><body>c:body</body></message>`,
  },
  {
    name: "prefix rebound from content to foreign",
    element: () =>
      xml(
        "message",
        { "xmlns:c": CONTENT, id: "valid" },
        xml("c:body", { "xmlns:c": FOREIGN }, "extension"),
      ),
    expected: `<message xmlns="${CONTENT}" xmlns:c="${CONTENT}" id="valid"><c:body xmlns:c="${FOREIGN}">extension</c:body></message>`,
  },
  {
    name: "a content sibling rebinding does not change foreign binding",
    element: () =>
      xml(
        "message",
        { "xmlns:c": FOREIGN, id: "valid" },
        xml("container", { xmlns: FOREIGN, "xmlns:c": CONTENT }),
        xml("c:notice", {}, "extension"),
      ),
    expected: `<message xmlns="${CONTENT}" xmlns:c="${FOREIGN}" id="valid"><container xmlns="${FOREIGN}" xmlns:c="${CONTENT}"/><c:notice>extension</c:notice></message>`,
  },
  {
    name: "stream prefix bound to a foreign payload namespace",
    element: () =>
      xml(
        "message",
        { "xmlns:stream": FOREIGN, id: "valid" },
        xml("stream:notice", {}, "extension"),
      ),
    expected: `<message xmlns="${CONTENT}" xmlns:stream="${FOREIGN}" id="valid"><stream:notice>extension</stream:notice></message>`,
  },
  {
    name: "foreign prefixed attributes",
    element: () =>
      xml(
        "message",
        { "xmlns:c": FOREIGN, "c:flag": "c:value", id: "valid" },
        xml("body", {}, "body"),
      ),
    expected: `<message xmlns="${CONTENT}" xmlns:c="${FOREIGN}" c:flag="c:value" id="valid"><body>body</body></message>`,
  },
];

// RFC 6120 §§4.8.4/8.4: extension prefixes remain legal; bindings are scoped.
for (const { name, element, expected } of permitted) {
  test.each(METHODS)(
    `RFC 6120 §4.8.5: %s preserves permitted prefixes / ${name}`,
    async (method) => {
      const { xmpp, peer, errors } = await session();
      try {
        const pending =
          method === "send" ? xmpp.send(element()) : xmpp.sendMany([element()]);
        expect(await pending.catch((error: Error) => error)).toBeUndefined();
        await xmpp.iqCaller.request(
          xml(
            "iq",
            { type: "get", id: "barrier" },
            xml("ping", { xmlns: PING }),
          ),
        );
        const frames = peer.transcript.filter((frame) =>
          readFrame(frame).some(
            (event) => "open" in event && event.attributes["{}id"] === "valid",
          ),
        );
        expect(frames).toHaveLength(1);
        expect(readFrame(frames[0])).toEqual(readFrame(expected));
        expect(xmpp.status).toBe("online");
        expect(errors).toEqual([]);
        expect(peer.errors).toEqual([]);
      } finally {
        await xmpp.stop();
        await peer.stop();
      }
    },
  );
}

const received = [
  [
    "prefixed result root",
    `<c:iq xmlns:c="${CONTENT}" xmlns="${CONTENT}" type="result" id="request"><wrong xmlns="${FOREIGN}"/></c:iq>`,
  ],
  [
    "prefixed error root",
    `<c:iq xmlns:c="${CONTENT}" xmlns="${CONTENT}" type="error" id="request"><error type="cancel"><service-unavailable xmlns="${STANZAS}"/></error></c:iq>`,
  ],
  [
    "prefixed error child",
    `<iq xmlns="${CONTENT}" type="error" id="request"><c:error xmlns:c="${CONTENT}" type="cancel"><service-unavailable xmlns="${STANZAS}"/></c:error></iq>`,
  ],
  [
    "prefixed content inside foreign payload",
    `<iq xmlns="${CONTENT}" type="result" id="request"><wrong xmlns="${FOREIGN}" xmlns:c="${CONTENT}"><c:body>wrong</c:body></wrong></iq>`,
  ],
] as const;

test("RFC 6120 §§4.8.3/4.8.5: unsupported content root must close even with a prohibited descendant prefix", async () => {
  const { xmpp, peer, errors } = await session();
  let decide: (result: "closed" | "ignored") => void;
  const decision = new Promise<"closed" | "ignored">((resolve) => {
    decide = resolve;
  });
  const onError = () => decide("closed");
  const onNonza = (element: {
    is(name: string, namespace: string): boolean;
  }) => {
    if (element.is("marker", FOREIGN)) {
      decide("ignored");
    }
  };
  xmpp.once("error", onError);
  xmpp.on("nonza", onNonza);
  try {
    peer.send(
      `<message xmlns="${SERVER}" xmlns:c="${CONTENT}"><c:body/></message>`,
    );
    peer.send(`<marker xmlns="${FOREIGN}"/>`);
    expect(await decision).toBe("closed");
    await peer.waitForClose();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ condition: "invalid-namespace" });
    expect(
      peer.transcript
        .flatMap(readFrame)
        .some(
          (event) =>
            "open" in event &&
            event.open === `{${STREAM_ERRORS}}invalid-namespace`,
        ),
    ).toBe(true);
    expect(peer.errors).toEqual([]);
  } finally {
    xmpp.off("error", onError);
    xmpp.off("nonza", onNonza);
    await xmpp.stop();
    await peer.stop();
  }
});

// §4.8.5 permits ignoring the data or closing; neither may complete this IQ.
test.each(received)(
  "RFC 6120 §4.8.5: receiver ignores or closes prefixed content / %s",
  async (_name, frame) => {
    const { xmpp, peer, errors } = await session((sent, remote) => {
      const root = readFrame(sent)[0];
      if (!("open" in root) || root.attributes["{}id"] !== "request") {
        return;
      }
      remote.send(frame);
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="request"><verified xmlns="${FOREIGN}"/></iq>`,
      );
    });
    try {
      const result = await xmpp.iqCaller
        .request(
          xml(
            "iq",
            { type: "get", id: "request" },
            xml("ping", { xmlns: PING }),
          ),
        )
        .catch((error: Error) => error);
      const rejected = result instanceof Error && result.name !== "StanzaError";
      const verified =
        !(result instanceof Error) &&
        result.getChild("verified", FOREIGN) !== undefined;
      expect(verified || rejected).toBe(true);
      if (rejected) {
        await peer.waitForClose();
        expect(
          peer.transcript
            .flatMap(readFrame)
            .some(
              (event) =>
                "open" in event &&
                [
                  `{${STREAM_ERRORS}}bad-namespace-prefix`,
                  `{${STREAM_ERRORS}}bad-format`,
                ].includes(event.open),
            ),
        ).toBe(true);
        expect(readFrame(peer.transcript.at(-1)!)).toEqual(
          readFrame(`<close xmlns="${FRAMING}"/>`),
        );
      } else {
        expect(result.getNS()).toBe(CONTENT);
        expect(xmpp.status).toBe("online");
        expect(errors).toEqual([]);
      }
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
