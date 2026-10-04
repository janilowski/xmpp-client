import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { Element as XMLElement } from "../src/xml/index.js";
// @ts-expect-error ltx ships no declarations for its ES module constructor.
import SourceElement from "ltx/src/Element.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const CONTENT = "jabber:client";
const SERVER = "jabber:server";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const QUERY = "urn:test:generated-errors";
const DETAIL = "urn:test:error-detail";
const REQUEST_TYPES: ("get" | "set")[] = ["get", "set"];
const ERROR_TYPES = ["auth", "cancel", "continue", "modify", "wait"];
const CONDITIONS = [
  "bad-request",
  "conflict",
  "feature-not-implemented",
  "forbidden",
  "gone",
  "internal-server-error",
  "item-not-found",
  "jid-malformed",
  "not-acceptable",
  "not-allowed",
  "not-authorized",
  "policy-violation",
  "recipient-unavailable",
  "redirect",
  "registration-required",
  "remote-server-not-found",
  "remote-server-timeout",
  "resource-constraint",
  "service-unavailable",
  "subscription-required",
  "undefined-condition",
  "unexpected-request",
];
const PAYLOAD = `<query xmlns="${QUERY}"><value>original &amp; payload</value></query>`;
const FALLBACK = `<error type="cancel"><internal-server-error xmlns="${STANZAS}"/></error>`;

// The peer supplies literal authentication/binding replies, independently of handlers.
async function session(
  exercise: (
    xmpp: ReturnType<typeof client>,
    peer: ScriptedPeer,
    errors: Error[],
  ) => Promise<void>,
) {
  let authenticated = false;
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (!("open" in root)) {
      throw new Error("Expected an element");
    }
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="generated-errors" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${SASL}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${SASL}"/>`);
    } else if (root.open === `{${CONTENT}}iq` && frame.includes(BIND)) {
      remote.send(
        `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
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
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    await xmpp.start();
    await xmpp.send(xml("sync", { xmlns: QUERY }));
    while (true) {
      const root = readFrame(await peer.next())[0];
      if ("open" in root && root.open === `{${QUERY}}sync`) {
        break;
      }
    }
    await exercise(xmpp, peer, errors);
    expect(xmpp.status).toBe("online");
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
}

async function exchange(peer: ScriptedPeer, type: "get" | "set") {
  peer.send(
    `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}">${PAYLOAD}</iq>`,
  );
  return readFrame(await peer.next());
}

function expectedReply(type: "error" | "result", payload: string) {
  return readFrame(
    `<iq xmlns="${CONTENT}" to="sender@remote.test/s" from="user@example.test/r" id="generated" type="${type}">${payload}</iq>`,
  );
}

const malformed: { name: string; error: () => Element }[] = [
  {
    name: "ESM child adds a second standard condition",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        new SourceElement("conflict", { xmlns: STANZAS }),
      ),
  },
  {
    name: "ESM diagnostic markup is not character data",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        xml("text", STANZAS, new SourceElement("markup", { xmlns: DETAIL })),
      ),
  },
  {
    name: "ESM application child uses a reserved namespace",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        new SourceElement("detail", { xmlns: CONTENT }),
      ),
  },
  {
    name: "unregistered error type",
    error: () => xml("error", { type: "foo" }, xml("forbidden", STANZAS)),
  },
  {
    name: "missing error type",
    error: () => xml("error", {}, xml("forbidden", STANZAS)),
  },
  {
    name: "error root explicitly clears its content namespace",
    error: () =>
      xml("error", { type: "cancel", xmlns: "" }, xml("forbidden", STANZAS)),
  },
  { name: "missing condition", error: () => xml("error", { type: "cancel" }) },
  {
    name: "two standard conditions",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        xml("conflict", STANZAS),
      ),
  },
  {
    name: "unregistered standard condition",
    error: () => xml("error", { type: "cancel" }, xml("custom", STANZAS)),
  },
  {
    name: "foreign condition without a standard condition",
    error: () => xml("error", { type: "cancel" }, xml("forbidden", DETAIL)),
  },
  {
    name: "condition inherits the core content namespace",
    error: () => xml("error", { type: "cancel" }, xml("forbidden")),
  },
  {
    name: "condition prefix is rebound to an application namespace",
    error: () =>
      xml(
        "error",
        { type: "cancel", "xmlns:e": STANZAS },
        xml("e:forbidden", { "xmlns:e": DETAIL }),
      ),
  },
  ...[CONTENT, SERVER, STREAM, ""].map((namespace) => ({
    name: `application detail uses reserved or absent namespace ${namespace}`,
    error: () =>
      xml(
        "error",
        { type: "cancel", xmlns: CONTENT },
        xml("forbidden", STANZAS),
        xml("detail", { xmlns: namespace }),
      ),
  })),
  {
    name: "diagnostic text contains markup",
    error: () =>
      xml(
        "error",
        { type: "cancel" },
        xml("forbidden", STANZAS),
        xml("text", STANZAS, xml("markup", DETAIL)),
      ),
  },
];

// RFC 6120 §§8.3.1–8.3.2: the library must not manufacture an invalid error reply.
// Fallback and one local diagnostic are policy; the mandatory error syntax is not.
for (const { name, error } of malformed) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.2: generated %s error falls back / ${name}`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = error();
        let calls = 0;
        xmpp.iqCallee[type](QUERY, "query", () => {
          calls += 1;
          return value;
        });
        expect(await exchange(peer, type)).toEqual(
          expectedReply("error", PAYLOAD + FALLBACK),
        );
        expect(calls).toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);
        peer.send(
          `<iq xmlns="${CONTENT}" type="get" id="recovery"><ping xmlns="urn:xmpp:ping"/></iq>`,
        );
        expect(readFrame(await peer.next())).toEqual(
          readFrame(`<iq xmlns="${CONTENT}" type="result" id="recovery"/>`),
        );
      });
    },
  );
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §§4.8.5/8.3: generated %s rejects a content-prefixed error root without losing the reply",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      const handled = Promise.withResolvers<void>();
      xmpp.iqCallee[type](QUERY, "query", () => {
        handled.resolve();
        return xml(
          "c:error",
          { "xmlns:c": CONTENT, type: "cancel" },
          xml("forbidden", STANZAS),
        );
      });
      peer.send(
        `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}">${PAYLOAD}</iq>`,
      );
      await handled.promise;
      peer.send(
        `<iq xmlns="${CONTENT}" type="get" id="barrier"><ping xmlns="urn:xmpp:ping"/></iq>`,
      );
      expect(readFrame(await peer.next())).toEqual(
        expectedReply("error", PAYLOAD + FALLBACK),
      );
      expect(readFrame(await peer.next())).toEqual(
        readFrame(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
    });
  },
);

// §8.3.3 recommends usual type/condition pairs but permits other appropriate pairs.
for (const condition of CONDITIONS) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.3: generated %s preserves registered condition ${condition}`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        xmpp.iqCallee[type](QUERY, "query", () =>
          xml("error", { type: "cancel" }, xml(condition, STANZAS)),
        );
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "error",
            `${PAYLOAD}<error type="cancel"><${condition} xmlns="${STANZAS}"/></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

for (const errorType of ERROR_TYPES) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.2: generated %s preserves legal error type ${errorType}`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        xmpp.iqCallee[type](QUERY, "query", () =>
          xml("error", { type: errorType }, xml("forbidden", STANZAS)),
        );
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "error",
            `${PAYLOAD}<error type="${errorType}"><forbidden xmlns="${STANZAS}"/></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §8.3.2: generated %s accepts a legal ESM condition child",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      xmpp.iqCallee[type](QUERY, "query", () =>
        xml(
          "error",
          { type: "cancel" },
          new SourceElement("forbidden", { xmlns: STANZAS }),
        ),
      );
      expect(await exchange(peer, type)).toEqual(
        expectedReply(
          "error",
          `${PAYLOAD}<error type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
        ),
      );
      expect(errors).toEqual([]);
    });
  },
);

for (const core of [false, true]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §§8.3/8.4: generated %s accepts an ESM ${core ? "core error" : "foreign error payload"} root`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = new SourceElement("error", {
          xmlns: core ? CONTENT : DETAIL,
          type: "cancel",
        });
        value.append(new SourceElement("forbidden", { xmlns: STANZAS }));
        xmpp.iqCallee[type](QUERY, "query", () => value);
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            core ? "error" : "result",
            `${core ? PAYLOAD : ""}<error xmlns="${core ? CONTENT : DETAIL}" type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

for (const constructor of ["CJS", "ESM"]) {
  for (const namespace of [0, false, 123, true]) {
    test.each(REQUEST_TYPES)(
      `RFC 6120 §8.4: generated %s preserves ${constructor} scalar foreign namespace ${namespace}`,
      async (type) => {
        await session(async (xmpp, peer, errors) => {
          const value =
            constructor === "CJS"
              ? new XMLElement("error", {
                  xmlns: namespace,
                  type: "application",
                })
              : new SourceElement("error", {
                  xmlns: namespace,
                  type: "application",
                });
          xmpp.iqCallee[type](QUERY, "query", () => value);
          expect(await exchange(peer, type)).toEqual(
            expectedReply(
              "result",
              `<error xmlns="${namespace}" type="application"/>`,
            ),
          );
          expect(errors).toEqual([]);
        });
      },
    );
  }
}

for (const constructor of ["CJS", "ESM"]) {
  for (const namespace of [0, false]) {
    for (const prefix of [false, true]) {
      test.each(REQUEST_TYPES)(
        `RFC 6120 §8.3.2: generated %s preserves ${constructor} scalar ${prefix ? "prefixed" : "default"} application namespace ${namespace}`,
        async (type) => {
          await session(async (xmpp, peer, errors) => {
            const name = prefix ? "d:detail" : "detail";
            const attributes = {
              [prefix ? "xmlns:d" : "xmlns"]: namespace,
            };
            const detail =
              constructor === "CJS"
                ? new XMLElement(name, attributes)
                : new SourceElement(name, attributes);
            xmpp.iqCallee[type](QUERY, "query", () =>
              xml(
                "error",
                { type: "cancel" },
                xml("forbidden", STANZAS),
                detail,
              ),
            );
            expect(await exchange(peer, type)).toEqual(
              expectedReply(
                "error",
                `${PAYLOAD}<error type="cancel"><forbidden xmlns="${STANZAS}"/>${prefix ? `<d:detail xmlns:d="${namespace}"/>` : `<detail xmlns="${namespace}"/>`}</error>`,
              ),
            );
            expect(errors).toEqual([]);
          });
        },
      );
    }
  }
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §§8.3.1–8.3.4: generated %s preserves error detail, text and original query order",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      xmpp.iqCallee[type](QUERY, "query", () =>
        xml(
          "error",
          { type: "auth", by: "user@example.test/r", code: "403" },
          xml("forbidden", STANZAS),
          xml("text", { xmlns: STANZAS, "xml:lang": "pl" }, "Zażółć <&>"),
          xml(
            "d:detail",
            { "xmlns:d": DETAIL },
            xml("d:value", {}, "one"),
            xml("d:value", { "xmlns:d": QUERY }, "two"),
          ),
        ),
      );
      expect(await exchange(peer, type)).toEqual(
        expectedReply(
          "error",
          `${PAYLOAD}<error type="auth" by="user@example.test/r" code="403"><forbidden xmlns="${STANZAS}"/><text xmlns="${STANZAS}" xml:lang="pl">Zażółć &lt;&amp;&gt;</text><d:detail xmlns:d="${DETAIL}"><d:value>one</d:value><d:value xmlns:d="${QUERY}">two</d:value></d:detail></error>`,
        ),
      );
      expect(errors).toEqual([]);
    });
  },
);

for (const repeated of ["application", "descendant"]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3.4: generated %s preserves a shared foreign ${repeated} child as repeated valid XML`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = xml("value", DETAIL, "shared");
        const detail = xml("detail", DETAIL, value);
        if (repeated === "descendant") {
          detail.append(value);
        }
        const error = xml(
          "error",
          { type: "cancel" },
          xml("forbidden", STANZAS),
          detail,
        );
        if (repeated === "application") {
          error.append(detail);
        }
        xmpp.iqCallee[type](QUERY, "query", () => error);
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "error",
            `${PAYLOAD}<error type="cancel"><forbidden xmlns="${STANZAS}"/>${repeated === "application" ? `<detail xmlns="${DETAIL}"><value>shared</value></detail><detail xmlns="${DETAIL}"><value>shared</value></detail>` : `<detail xmlns="${DETAIL}"><value>shared</value><value>shared</value></detail>`}</error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

test.each(["gone", "redirect"])(
  "RFC 6120 §8.3.3: generated error preserves %s URI text",
  async (condition) => {
    await session(async (xmpp, peer, errors) => {
      xmpp.iqCallee.get(QUERY, "query", () =>
        xml(
          "error",
          { type: "modify" },
          xml(condition, STANZAS, "xmpp:new@example.test?join"),
        ),
      );
      expect(await exchange(peer, "get")).toEqual(
        expectedReply(
          "error",
          `${PAYLOAD}<error type="modify"><${condition} xmlns="${STANZAS}">xmpp:new@example.test?join</${condition}></error>`,
        ),
      );
      expect(errors).toEqual([]);
    });
  },
);

test.each(REQUEST_TYPES)(
  "RFC 6120 §§4.8/8.3.2: generated %s accepts namespace-qualified core error and prefixed standard condition",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      xmpp.iqCallee[type](QUERY, "query", () =>
        xml(
          "error",
          { xmlns: CONTENT, type: "cancel", "xmlns:e": STANZAS },
          xml("e:forbidden"),
          xml("text", DETAIL, xml("markup", DETAIL, "application markup")),
        ),
      );
      expect(await exchange(peer, type)).toEqual(
        expectedReply(
          "error",
          `${PAYLOAD}<error xmlns="${CONTENT}" type="cancel" xmlns:e="${STANZAS}"><e:forbidden/><text xmlns="${DETAIL}"><markup>application markup</markup></text></error>`,
        ),
      );
      expect(errors).toEqual([]);
    });
  },
);

for (const prefix of [false, true]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.4: generated %s preserves an error payload's inherited ${prefix ? "prefixed" : "default"} foreign namespace`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = xml(
          prefix ? "d:error" : "error",
          { type: "application" },
          xml("d:detail"),
          xml("alias:detail"),
          xml("d:detail", { "xmlns:d": QUERY }),
        );
        xml(
          "holder",
          { "xmlns:d": QUERY, "xmlns:alias": DETAIL },
          xml("holder", { xmlns: DETAIL, "xmlns:d": DETAIL }, value),
        );
        const handled = Promise.withResolvers<void>();
        xmpp.iqCallee[type](QUERY, "query", () => {
          handled.resolve();
          return value;
        });
        peer.send(
          `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}">${PAYLOAD}</iq>`,
        );
        await handled.promise;
        // A valid following reply makes missing output an exact assertion, not a timeout.
        peer.send(
          `<iq xmlns="${CONTENT}" type="get" id="barrier"><ping xmlns="urn:xmpp:ping"/></iq>`,
        );
        expect(readFrame(await peer.next())).toEqual(
          expectedReply(
            "result",
            prefix
              ? `<d:error xmlns="${DETAIL}" xmlns:d="${DETAIL}" xmlns:alias="${DETAIL}" type="application"><d:detail/><alias:detail/><d:detail xmlns:d="${QUERY}"/></d:error>`
              : `<error xmlns="${DETAIL}" xmlns:d="${DETAIL}" xmlns:alias="${DETAIL}" type="application"><d:detail/><alias:detail/><d:detail xmlns:d="${QUERY}"/></error>`,
          ),
        );
        expect(readFrame(await peer.next())).toEqual(
          readFrame(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

test.each(REQUEST_TYPES)(
  "RFC 6120 §8.4: generated %s preserves an ordinary result payload's inherited namespace bindings",
  async (type) => {
    await session(async (xmpp, peer, errors) => {
      const value = xml("result", {}, xml("d:detail"));
      xml("holder", { xmlns: DETAIL, "xmlns:d": QUERY }, value);
      const handled = Promise.withResolvers<void>();
      xmpp.iqCallee[type](QUERY, "query", () => {
        handled.resolve();
        return value;
      });
      peer.send(
        `<iq xmlns="${CONTENT}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}">${PAYLOAD}</iq>`,
      );
      await handled.promise;
      peer.send(
        `<iq xmlns="${CONTENT}" type="get" id="barrier"><ping xmlns="urn:xmpp:ping"/></iq>`,
      );
      expect(readFrame(await peer.next())).toEqual(
        expectedReply(
          "result",
          `<result xmlns="${DETAIL}" xmlns:d="${QUERY}"><d:detail/></result>`,
        ),
      );
      expect(readFrame(await peer.next())).toEqual(
        readFrame(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`),
      );
      expect(errors).toEqual([]);
    });
  },
);

for (const prefix of [false, true]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.4: generated %s preserves qualified foreign ${prefix ? "prefixed" : "unprefixed"} error as a result`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const value = prefix
          ? xml("d:error", { "xmlns:d": DETAIL }, xml("d:detail"))
          : xml("error", { xmlns: DETAIL }, xml("detail"));
        xmpp.iqCallee[type](QUERY, "query", () => value);
        expect(await exchange(peer, type)).toEqual(
          expectedReply(
            "result",
            prefix
              ? `<d:error xmlns:d="${DETAIL}"><d:detail/></d:error>`
              : `<error xmlns="${DETAIL}"><detail/></error>`,
          ),
        );
        expect(errors).toEqual([]);
      });
    },
  );
}

for (const rejected of [false, true]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §8.3: generated %s handler ${rejected ? "rejection" : "throw"} emits its original failure and recovers`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const failure = new Error("Handler failed");
        xmpp.iqCallee[type](QUERY, "query", () => {
          if (rejected) {
            return Promise.reject(failure);
          }
          throw failure;
        });
        expect(await exchange(peer, type)).toEqual(
          expectedReply("error", PAYLOAD + FALLBACK),
        );
        expect(errors).toEqual([failure]);
      });
    },
  );
}

for (const handler of ["error", "throw", "unhandled"]) {
  test.each(REQUEST_TYPES)(
    `RFC 6120 §§4.8/8.3.1: generated %s ${handler} reply preserves original query bindings inherited from IQ`,
    async (type) => {
      await session(async (xmpp, peer, errors) => {
        const failure = new Error("Handler failed");
        if (handler !== "unhandled") {
          xmpp.iqCallee[type](QUERY, "query", () => {
            if (handler === "throw") {
              throw failure;
            }
            return xml("error", { type: "cancel" }, xml("forbidden", STANZAS));
          });
        }
        peer.send(
          `<iq xmlns="${CONTENT}" xmlns:q="${QUERY}" from="sender@remote.test/s" to="user@example.test/r" id="generated" type="${type}"><q:query><q:value>original</q:value></q:query></iq>`,
        );
        peer.send(
          `<iq xmlns="${CONTENT}" type="get" id="barrier"><ping xmlns="urn:xmpp:ping"/></iq>`,
        );
        expect(readFrame(await peer.next())).toEqual(
          expectedReply(
            "error",
            `<q:query xmlns:q="${QUERY}"><q:value>original</q:value></q:query><error type="cancel"><${handler === "error" ? "forbidden" : handler === "throw" ? "internal-server-error" : "service-unavailable"} xmlns="${STANZAS}"/></error>`,
          ),
        );
        expect(readFrame(await peer.next())).toEqual(
          readFrame(`<iq xmlns="${CONTENT}" type="result" id="barrier"/>`),
        );
        expect(errors).toEqual(handler === "throw" ? [failure] : []);
      });
    },
  );
}

test("RFC 6120 §8.3: a child's toString override cannot change generated error wire", async () => {
  await session(async (xmpp, peer, errors) => {
    const value = xml("error", { type: "cancel" }, xml("forbidden", STANZAS));
    value.toString = () =>
      `<error type="foo"><custom xmlns="${STANZAS}"/></error>`;
    xmpp.iqCallee.get(QUERY, "query", () => value);
    expect(await exchange(peer, "get")).toEqual(
      expectedReply(
        "error",
        `${PAYLOAD}<error type="cancel"><forbidden xmlns="${STANZAS}"/></error>`,
      ),
    );
    expect(errors).toEqual([]);
  });
});
