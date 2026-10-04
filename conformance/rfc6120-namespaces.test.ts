import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CLIENT = "jabber:client";
const SERVER = "jabber:server";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const SM = "urn:xmpp:sm:3";
const PING = "urn:xmpp:ping";
const FOREIGN = "urn:test:extension";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const WATCHDOG_MS = 500;
const FOREIGN_NAMESPACES = [FOREIGN, ""];
const RESPONSE_TYPES = ["result", "error"];

async function session(onFrame?: (frame: string, peer: ScriptedPeer) => void) {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" version="1.0" id="namespace-session"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/><sm xmlns="${SM}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CLIENT}}iq` && frame.includes(BIND)) {
      remote.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (root.open === `{${SM}}enable`) {
      remote.send(`<enabled xmlns="${SM}" id="sm-session" resume="true"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
    onFrame?.(frame, remote);
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

// RFC 6120 §§4.1/4.8.4/11.2: an extension element named iq is not an IQ.
test.each(
  FOREIGN_NAMESPACES.flatMap((namespace) =>
    RESPONSE_TYPES.map((type) => [namespace, type]),
  ),
)(
  "RFC 6120 §4.8.4: foreign root namespace %j cannot complete an IQ %s",
  async (namespace, type) => {
    const { xmpp, peer, errors } = await session((frame, remote) => {
      const root = readFrame(frame)[0];
      if (!("open" in root) || root.attributes["{}id"] !== "request") {
        return;
      }
      const payload =
        type === "error"
          ? `<error type="cancel"><service-unavailable xmlns="${STANZAS}"/></error>`
          : `<wrong xmlns="${FOREIGN}"/>`;
      remote.send(
        `<iq xmlns="${namespace}" type="${type}" id="request">${payload}</iq>`,
      );
      remote.send(
        `<iq xmlns="${CLIENT}" type="result" id="request"><verified xmlns="${FOREIGN}"/></iq>`,
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
      expect(result).not.toBeInstanceOf(Error);
      expect(result.getNS()).toBe(CLIENT);
      expect(result.getChild("verified", FOREIGN)).toBeDefined();
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each(FOREIGN_NAMESPACES)(
  "RFC 6120 §4.8.4: foreign root namespace %j cannot invoke IQ handlers",
  async (namespace) => {
    const { xmpp, peer, errors } = await session();
    const handled: string[] = [];
    xmpp.iqCallee.get(FOREIGN, "query", () => {
      handled.push("get");
      return {};
    });
    xmpp.iqCallee.set(FOREIGN, "query", () => {
      handled.push("set");
      return {};
    });
    try {
      peer.send(
        `<iq xmlns="${namespace}" type="get" id="foreign-get"><query xmlns="${FOREIGN}"/></iq>`,
      );
      peer.send(
        `<iq xmlns="${namespace}" type="set" id="foreign-set"><query xmlns="${FOREIGN}"/></iq>`,
      );
      peer.send(
        `<iq xmlns="${CLIENT}" type="get" id="barrier"><ping xmlns="${PING}"/></iq>`,
      );
      while (true) {
        const root = readFrame(await peer.next())[0];
        if ("open" in root && root.attributes["{}id"] === "barrier") {
          break;
        }
      }
      expect(handled).toEqual([]);
      expect(
        peer.transcript.some((frame) => /id="foreign-(get|set)"/.test(frame)),
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

test.each(["message", "presence", "iq", "extension"])(
  "RFC 6120 §4.8.3: outgoing server content namespace rejects before writing / %s",
  async (name) => {
    const { xmpp, peer, errors } = await session((frame, remote) => {
      const root = readFrame(frame)[0];
      if (
        !("open" in root) ||
        root.attributes["{}id"] !== "rejection-barrier"
      ) {
        return;
      }
      remote.send(
        `<iq xmlns="${CLIENT}" type="result" id="rejection-barrier"/>`,
      );
    });
    const sent: string[] = [];
    xmpp.on("send", (element: { attrs: { id?: string } }) => {
      if (element.attrs.id) {
        sent.push(element.attrs.id);
      }
    });
    try {
      const result = await xmpp
        .send(
          xml(name, {
            xmlns: SERVER,
            id: "invalid-server-outgoing",
          }),
        )
        .then(
          () => undefined,
          (error: Error) => error,
        );
      expect(result).toBeInstanceOf(TypeError);
      expect(result?.message).toBe("Unsupported content namespace");
      await xmpp.iqCaller.request(
        xml(
          "iq",
          { type: "get", id: "rejection-barrier" },
          xml("ping", { xmlns: PING }),
        ),
      );
      expect(
        peer.transcript.some((frame) =>
          frame.includes('id="invalid-server-outgoing"'),
        ),
      ).toBe(false);
      expect(sent).toEqual(["rejection-barrier"]);
      expect(
        xmpp.streamManagement.outbound_q.some(
          ({ stanza }: { stanza: { attrs: { id?: string } } }) =>
            stanza.attrs.id === "invalid-server-outgoing",
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

test.each(FOREIGN_NAMESPACES)(
  "RFC 6120 §4.8.4 / XEP-0198 §4: foreign root namespace %j stays outside stanza delivery and counting",
  async (namespace) => {
    const { xmpp, peer, errors } = await session();
    const delivered: string[] = [];
    const observed: string[] = [];
    const contexts: unknown[] = [];
    xmpp.middleware.use(
      (
        context: { id: string; from: unknown; to: unknown },
        next: () => Promise<unknown>,
      ) => {
        if (context.id.startsWith("foreign-")) {
          contexts.push([context.id, context.from, context.to]);
        }
        return next();
      },
    );
    xmpp.on("stanza", (element: { attrs: { id: string } }) =>
      delivered.push(element.attrs.id),
    );
    xmpp.on("nonza", (element: { attrs: { id: string } }) => {
      if (element.attrs.id?.startsWith("foreign-")) {
        observed.push(element.attrs.id);
      }
    });
    try {
      peer.send(
        `<message xmlns="${namespace}" id="foreign-message" from="not an XMPP address"/>`,
      );
      peer.send(
        `<presence xmlns="${namespace}" id="foreign-presence" to="not an XMPP address"/>`,
      );
      peer.send(
        `<iq xmlns="${namespace}" type="result" id="foreign-iq" from="not an XMPP address"/>`,
      );
      peer.send(`<r xmlns="${SM}"/>`);
      let acknowledgement;
      do {
        acknowledgement = readFrame(await peer.next())[0];
      } while (
        !("open" in acknowledgement) ||
        acknowledgement.open !== `{${SM}}a`
      );
      expect(delivered).toEqual([]);
      expect(observed).toEqual([
        "foreign-message",
        "foreign-presence",
        "foreign-iq",
      ]);
      expect(contexts).toEqual([
        ["foreign-message", null, null],
        ["foreign-presence", null, null],
        ["foreign-iq", null, null],
      ]);
      expect(acknowledgement.attributes["{}h"]).toBe("0");
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each([
  ["message", "normal"],
  ["presence", "available"],
  ["iq", "get"],
  ["iq", "set"],
  ["iq", "result"],
  ["iq", "error"],
  ["extension", "get"],
])(
  "RFC 6120 §4.8.3: unsupported server content namespace closes atomically / %s %s",
  async (name, type) => {
    const { xmpp, peer, errors } = await session();
    const delivered: unknown[] = [];
    xmpp.on("stanza", (element: unknown) => delivered.push(element));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detected = new Promise<Error>((resolve) => {
      xmpp.once("error", resolve);
      timer = setTimeout(
        () => resolve(new Error("No namespace error")),
        WATCHDOG_MS,
      );
    });
    try {
      peer.send(
        `<${name} xmlns="${SERVER}" type="${type}" id="server-content"><ping xmlns="${PING}"/></${name}>`,
      );
      expect(await detected).toMatchObject({ condition: "invalid-namespace" });
      await peer.waitForClose();
      const frames = peer.transcript.map(readFrame);
      expect(
        frames
          .flat()
          .some(
            (event) =>
              "open" in event &&
              event.open ===
                "{urn:ietf:params:xml:ns:xmpp-streams}invalid-namespace",
          ),
      ).toBe(true);
      expect(frames.at(-1)).toEqual(readFrame(`<close xmlns="${FRAMING}"/>`));
      expect(delivered).toEqual([]);
      expect(
        peer.transcript.some((frame) => frame.includes('id="server-content"')),
      ).toBe(false);
      expect(errors).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      clearTimeout(timer);
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each(RESPONSE_TYPES)(
  "RFC 6120 §§4.8.3 / 8.2.3: unprefixed client IQ %s completes its request",
  async (type) => {
    const { xmpp, peer, errors } = await session((frame, remote) => {
      const root = readFrame(frame)[0];
      if (!("open" in root) || root.attributes["{}id"] !== "valid-reply") {
        return;
      }
      const payload =
        type === "error"
          ? `<error type="cancel"><service-unavailable xmlns="${STANZAS}"/></error>`
          : `<verified xmlns="${FOREIGN}"/>`;
      remote.send(
        `<iq xmlns="${CLIENT}" type="${type}" id="valid-reply">${payload}</iq>`,
      );
    });
    try {
      const result = await xmpp.iqCaller
        .request(
          xml(
            "iq",
            { type: "get", id: "valid-reply" },
            xml("ping", { xmlns: PING }),
          ),
        )
        .catch((error: Error) => error);
      if (type === "error") {
        expect(result).toMatchObject({
          name: "StanzaError",
          type: "cancel",
          condition: "service-unavailable",
        });
      } else {
        expect(result.getNS()).toBe(CLIENT);
        expect(result.getChild("verified", FOREIGN)).toBeDefined();
      }
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §§4.8.3 / 8.2.3: unprefixed client get/set queries invoke handlers", async () => {
  const { xmpp, peer, errors } = await session();
  const handled: string[] = [];
  xmpp.iqCallee.get(FOREIGN, "query", () => {
    handled.push("get");
    return {};
  });
  xmpp.iqCallee.set(FOREIGN, "query", () => {
    handled.push("set");
    return {};
  });
  try {
    for (const type of ["get", "set"]) {
      peer.send(
        `<iq xmlns="${CLIENT}" type="${type}" id="valid-${type}"><query xmlns="${FOREIGN}"/></iq>`,
      );
      let reply;
      do {
        reply = readFrame(await peer.next())[0];
      } while (
        !("open" in reply) ||
        reply.attributes["{}id"] !== `valid-${type}`
      );
      expect(reply.open).toBe(`{${CLIENT}}iq`);
      expect(reply.attributes["{}type"]).toBe("result");
    }
    expect(handled).toEqual(["get", "set"]);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("RFC 6120 §4.8.3 / XEP-0198 §4: unprefixed client roots remain stanzas", async () => {
  const { xmpp, peer, errors } = await session();
  const delivered: string[] = [];
  xmpp.on("stanza", (element: { attrs: { id: string } }) =>
    delivered.push(element.attrs.id),
  );
  try {
    peer.send(
      `<message xmlns="${CLIENT}" id="valid-message"><body xmlns="${FOREIGN}">extension</body></message>`,
    );
    peer.send(
      `<presence xmlns="${CLIENT}" id="valid-presence"><show>away</show></presence>`,
    );
    peer.send(`<iq xmlns="${CLIENT}" type="result" id="valid-iq"/>`);
    peer.send(`<r xmlns="${SM}"/>`);
    let acknowledgement;
    do {
      acknowledgement = readFrame(await peer.next())[0];
    } while (
      !("open" in acknowledgement) ||
      acknowledgement.open !== `{${SM}}a`
    );
    expect(delivered).toEqual(["valid-message", "valid-presence", "valid-iq"]);
    expect(acknowledgement.attributes["{}h"]).toBe("3");
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("RFC 6120 §4.8.4: prefixed foreign extensions remain nonzas", async () => {
  const { xmpp, peer, errors } = await session();
  const delivered: string[] = [];
  const observed: string[] = [];
  xmpp.on("stanza", (element: { attrs: { id: string } }) =>
    delivered.push(element.attrs.id),
  );
  xmpp.on("nonza", (element: { attrs: { id?: string } }) => {
    if (element.attrs.id?.startsWith("prefixed-")) {
      observed.push(element.attrs.id);
    }
  });
  try {
    for (const name of ["message", "presence", "iq"]) {
      peer.send(`<e:${name} xmlns:e="${FOREIGN}" id="prefixed-${name}"/>`);
    }
    peer.send(`<r xmlns="${SM}"/>`);
    let acknowledgement;
    do {
      acknowledgement = readFrame(await peer.next())[0];
    } while (
      !("open" in acknowledgement) ||
      acknowledgement.open !== `{${SM}}a`
    );
    expect(delivered).toEqual([]);
    expect(observed).toEqual([
      "prefixed-message",
      "prefixed-presence",
      "prefixed-iq",
    ]);
    expect(acknowledgement.attributes["{}h"]).toBe("0");
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each(FOREIGN_NAMESPACES)(
  "RFC 6120 §4.8.4 / XEP-0198 §4: outgoing namespace %j stays outside stanza validation and acknowledgements",
  async (namespace) => {
    const { xmpp, peer, errors } = await session((frame, remote) => {
      const root = readFrame(frame)[0];
      if (!("open" in root) || root.attributes["{}id"] !== "outgoing-barrier") {
        return;
      }
      remote.send(`<a xmlns="${SM}" h="1"/>`);
      remote.send(
        `<iq xmlns="${CLIENT}" type="result" id="outgoing-barrier"/>`,
      );
    });
    const acknowledged: string[] = [];
    xmpp.streamManagement.on("ack", (element: { attrs: { id: string } }) =>
      acknowledged.push(element.attrs.id),
    );
    try {
      for (const name of ["message", "presence", "iq"]) {
        const result = await xmpp
          .send(
            xml(name, {
              xmlns: namespace,
              id: `foreign-outgoing-${name}`,
              to: "not an XMPP address",
            }),
          )
          .then(
            () => "sent",
            () => "rejected",
          );
        expect(result).toBe("sent");
      }
      await xmpp.send(xml("message", { id: "valid-outgoing" }));
      await xmpp.iqCaller.request(
        xml(
          "iq",
          { type: "get", id: "outgoing-barrier" },
          xml("ping", { xmlns: PING }),
        ),
      );
      expect(acknowledged).toEqual(["valid-outgoing"]);
      const roots = peer.transcript
        .flatMap(readFrame)
        .filter((event) => "open" in event)
        .filter((event) =>
          event.attributes["{}id"]?.startsWith("foreign-outgoing-"),
        );
      expect(roots).toHaveLength(3);
      expect(roots.map((root) => root.open)).toEqual(
        ["message", "presence", "iq"].map((name) => `{${namespace}}${name}`),
      );
      for (const root of roots) {
        expect(root.attributes["{}to"]).toBe("not an XMPP address");
      }
      expect(xmpp.status).toBe("online");
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
