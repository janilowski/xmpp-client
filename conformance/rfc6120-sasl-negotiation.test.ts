import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import parse from "../src/xml/lib/parse.js";
import type { Element } from "../types/index.js";
import { ScriptedPeer } from "./peer.ts";

const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const STREAM = "http://etherx.jabber.org/streams";
const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const MECHANISM = "TEST-NEGOTIATION";
const TIMEOUT_MS = 300;

test("RFC 6120 §6.4.3: ordered rounds and foreign extensions remain valid", async () => {
  const challenges: string[] = [];
  let responses = 0;
  const peer = saslPeer((el, remote) => {
    if (el.is("auth", SASL)) {
      remote.send('<notice xmlns="urn:test:extension"/>');
      remote.send(`<challenge xmlns="${SASL}">b25l</challenge>`);
    } else if (el.is("response", SASL)) {
      remote.send(
        ++responses === 1
          ? `<challenge xmlns="${SASL}">dHdv</challenge>`
          : `<success xmlns="${SASL}"/>`,
      );
    }
  }, `<extension xmlns="urn:test:extension"/><mechanism>${MECHANISM}</mechanism>`);
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    timeout: TIMEOUT_MS,
  });
  xmpp.saslMechanisms.register(MECHANISM, () => ({
    name: MECHANISM,
    clientFirst: false,
    challenge: (value: string) => {
      challenges.push(value);
    },
    response: () => "reply",
  }));
  xmpp.reconnect.stop();
  try {
    expect((await xmpp.start()).toString()).toBe("user@example.test/r");
    expect(challenges).toEqual(["one", "two"]);
    expect(
      peer.transcript.filter((frame) => frame.startsWith("<response")),
    ).toEqual([
      `<response xmlns="${SASL}">cmVwbHk=</response>`,
      `<response xmlns="${SASL}">cmVwbHk=</response>`,
    ]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each([
  ["classic", "PLAIN"],
  ["classic", MECHANISM],
  ["classic", "invalid-proof"],
  ["inline", "PLAIN"],
  ["inline", MECHANISM],
  ["inline", "invalid-proof"],
])(
  "XEP-0388 §5 / RFC 6120 §7: SASL2 success permits %s binding only after verification / %s",
  async (binding, mode) => {
    const mechanism = mode === "PLAIN" ? "PLAIN" : MECHANISM;
    const sasl2 = "urn:xmpp:sasl:2";
    const receivedFeatures = Promise.withResolvers<void>();
    const peer = new ScriptedPeer((frame, remote) => {
      const el = parse(frame) as Element | undefined;
      if (!el) {
        throw new Error("Expected a client element");
      }
      if (el.is("open", FRAMING)) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" id="sasl2" version="1.0"/>`,
        );
        remote.send(
          `<features xmlns="${STREAM}"><authentication xmlns="${sasl2}"><mechanism>${mechanism}</mechanism>${binding === "inline" ? `<inline><bind xmlns="${BIND2}"/></inline>` : ""}</authentication></features>`,
        );
      } else if (el.is("authenticate", sasl2)) {
        remote.send(
          `<success xmlns="${sasl2}"><authorization-identifier>user@example.test${binding === "inline" ? "/r" : ""}</authorization-identifier>${binding === "inline" ? `<bound xmlns="${BIND2}"/>` : ""}</success>`,
        );
        remote.send(
          `<features xmlns="${STREAM}">${binding === "inline" ? `<sm xmlns="${SM}"/>` : `<bind xmlns="${BIND}"/>`}</features>`,
        );
      } else if (el.is("iq")) {
        remote.send(
          `<iq xmlns="jabber:client" type="result" id="${el.attrs.id}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
        );
      } else if (el.is("enable", SM)) {
        remote.send(`<enabled xmlns="${SM}"/>`);
      } else if (el.is("close", FRAMING)) {
        remote.send(`<close xmlns="${FRAMING}"/>`);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.saslMechanisms.register(MECHANISM, () => ({
      name: MECHANISM,
      clientFirst: true,
      response: () => "",
      final: async () => {
        await receivedFeatures.promise;
        // Proof verification may outlive receipt/dispatch of the next features.
        await Bun.sleep(10);
        if (mode === "invalid-proof") {
          throw new Error("Invalid test proof");
        }
      },
    }));
    xmpp.on("nonza", (el: Element) => {
      if (
        el.is("features", STREAM) &&
        (el.getChild("bind", BIND) || el.getChild("sm", SM))
      ) {
        receivedFeatures.resolve();
      }
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      const result = await xmpp.start().then(
        (jid) => jid.toString(),
        (error: Error) => error,
      );
      if (mode === "invalid-proof") {
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toBe("Invalid test proof");
        expect(peer.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
          false,
        );
        expect(
          peer.transcript.some((frame) => frame.startsWith("<enable")),
        ).toBe(false);
      } else {
        expect(result).toBe("user@example.test/r");
        if (binding === "inline") {
          let frame;
          do {
            frame = await peer.next();
          } while (!frame.startsWith("<enable"));
        }
        expect(errors).toEqual([]);
      }
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<open")),
      ).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §6.4.5: exhausted authentication closes the stream", async () => {
  const peer = saslPeer((el, remote) => {
    if (el.is("auth", SASL)) {
      remote.send(`<failure xmlns="${SASL}"><not-authorized/></failure>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.saslMechanisms.register(MECHANISM, () => ({
    name: MECHANISM,
    clientFirst: true,
    response: () => "",
  }));
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  try {
    expect(await xmpp.start().catch((error: Error) => error)).toMatchObject({
      condition: "not-authorized",
    });
    const closed = await peer.waitForClose().then(
      () => true,
      () => false,
    );
    expect(closed).toBe(true);
    expect(peer.transcript.some((frame) => frame.startsWith("<close"))).toBe(
      true,
    );
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("RFC 6120 §6.4: duplicate features cannot start parallel authentication", async () => {
  let attempts = 0;
  const peer = saslPeer((el, remote) => {
    if (el.is("auth", SASL)) {
      if (++attempts === 1) {
        remote.send(
          `<features xmlns="${STREAM}"><mechanisms xmlns="${SASL}"><mechanism>${MECHANISM}</mechanism></mechanisms></features>`,
        );
      } else {
        remote.send(`<failure xmlns="${SASL}"><not-authorized/></failure>`);
      }
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.saslMechanisms.register(MECHANISM, () => ({
    name: MECHANISM,
    clientFirst: true,
    response: () => "",
  }));
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  try {
    const result = await xmpp.start().catch((error: Error) => error);
    expect(attempts).toBe(1);
    expect(result).toBeInstanceOf(Error);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each([
  `<challenge xmlns="${SASL}"><extra/></challenge>`,
  `<success xmlns="${SASL}"><extra/></success>`,
  `<unexpected xmlns="${SASL}"/>`,
])(
  "RFC 6120 §6.4: malformed SASL element %s cannot complete authentication",
  async (payload) => {
    const peer = saslPeer((el, remote) => {
      if (el.is("auth", SASL)) {
        remote.send(payload);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.saslMechanisms.register(MECHANISM, () => ({
      name: MECHANISM,
      clientFirst: true,
      response: () => "",
      challenge: () => {},
    }));
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    try {
      const result = await xmpp.start().then(
        () => null,
        (error: Error) => error,
      );
      expect(result?.message).toContain("SASL: Unexpected");
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<open")),
      ).toHaveLength(1);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each([
  [undefined, undefined, undefined],
  ["other@example.test", undefined, "other@example.test"],
  ["E\u0301@xn--bcher-kva.example", "explicit-realm", "é@bücher.example"],
  ["other@example.test/r", undefined, null],
  ["example.test", undefined, null],
  ["@example.test", undefined, null],
] as const)(
  "RFC 6120 §§6.3.7–6.3.9: authorization identity %j and realm %j",
  async (authzid, realm, expected) => {
    let received: Record<string, unknown> | undefined;
    const peer = saslPeer((el, remote) => {
      if (el.is("auth", SASL)) {
        remote.send(`<success xmlns="${SASL}"/>`);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      credentials: {
        username: "user@external-directory",
        password: "secret",
        authzid,
        realm,
      },
      timeout: TIMEOUT_MS,
    });
    xmpp.saslMechanisms.register(MECHANISM, () => ({
      name: MECHANISM,
      clientFirst: true,
      response: (credentials: Record<string, unknown>) => {
        received = credentials;
        return "";
      },
    }));
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    try {
      const result = await xmpp.start().then(
        () => "online",
        (error: Error) => error,
      );
      if (expected === null) {
        expect(result).toBeInstanceOf(Error);
        expect(received).toBeUndefined();
        expect(peer.transcript.some((frame) => frame.startsWith("<auth"))).toBe(
          false,
        );
      } else {
        expect(result).toBe("online");
        expect(received?.authzid).toBe(expected);
        expect(received?.realm).toBe(realm);
        expect(received?.username).toBe("user@external-directory");
      }
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §6.3.9: no implicit authentication realm", async () => {
  let realm: unknown = "not called";
  const peer = saslPeer((el, remote) => {
    if (el.is("auth", SASL)) {
      remote.send(`<success xmlns="${SASL}"/>`);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "user",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.saslMechanisms.register(MECHANISM, () => ({
    name: MECHANISM,
    clientFirst: true,
    response: (credentials: Record<string, unknown>) => {
      realm = credentials.realm;
      return "";
    },
  }));
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  try {
    await xmpp.start();
    expect(realm).toBeUndefined();
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

// RFC 6120 §§6.3–6.6 and RFC 4422 §3: transport sequencing independent of
// the mechanism. #18's RFC 5802 suite supplies independent cryptographic proofs.
function saslPeer(
  onAuth: (el: Element, peer: ScriptedPeer) => void,
  mechanisms = `<mechanism>${MECHANISM}</mechanism>`,
) {
  let opens = 0;
  return new ScriptedPeer((frame, peer) => {
    const el = parse(frame) as Element | undefined;
    if (!el) {
      throw new Error("Expected a client element");
    }
    if (el.is("open", FRAMING)) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="sasl-${++opens}" version="1.0"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}">${opens === 1 ? `<mechanisms xmlns="${SASL}">${mechanisms}</mechanisms>` : `<bind xmlns="${BIND}"/>`}</features>`,
      );
    } else if (el.is("iq")) {
      peer.send(
        `<iq xmlns="jabber:client" type="result" id="${el.attrs.id}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (el.is("close", FRAMING)) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    } else {
      onAuth(el, peer);
    }
  });
}

test.each(["challenge", "success"])(
  "RFC 6120 §6.4.3: rejects overlapping %s during asynchronous response",
  async (next) => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const peer = saslPeer((el, remote) => {
      if (el.is("auth", SASL)) {
        remote.send(`<challenge xmlns="${SASL}">eA==</challenge>`);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.saslMechanisms.register(MECHANISM, () => ({
      name: MECHANISM,
      clientFirst: true,
      response: () => "",
      challenge: async () => {
        entered.resolve();
        await gate.promise;
      },
    }));
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    let online = 0;
    xmpp.on("online", () => online++);
    try {
      const started = xmpp.start().then(
        () => null,
        (error: Error) => error,
      );
      await entered.promise;
      peer.send(`<${next} xmlns="${SASL}"/>`);
      const result = await started;
      expect(online).toBe(0);
      expect(result?.message).toContain("SASL: Unexpected");
      gate.resolve();
      await xmpp.stop();
      expect(
        peer.transcript.some((frame) => frame.startsWith("<response")),
      ).toBe(false);
      expect(peer.errors).toEqual([]);
    } finally {
      gate.resolve();
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each(["future-condition", "", "text-only"])(
  "RFC 6120 §6.5: unknown/malformed failure is generic / %s",
  async (condition) => {
    const peer = saslPeer((el, remote) => {
      if (el.is("auth", SASL)) {
        remote.send(
          `<failure xmlns="${SASL}">${condition === "text-only" ? "<text>denied</text>" : condition ? `<${condition}/>` : ""}</failure>`,
        );
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.saslMechanisms.register(MECHANISM, () => ({
      name: MECHANISM,
      clientFirst: true,
      response: () => "",
    }));
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    try {
      const result = await xmpp.start().catch((error: Error) => error);
      expect(result).toMatchObject({
        name: "SASLError",
        condition: "not-authorized",
      });
      expect(
        peer.transcript.filter((frame) => frame.startsWith("<open")),
      ).toHaveLength(1);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each([
  "",
  "<mechanism>UNSUPPORTED</mechanism>",
  "<mechanism>PLAIN<extension/></mechanism>",
  '<mechanism xmlns="urn:wrong">PLAIN</mechanism>',
])(
  "RFC 6120 §6.3: incompatible offer %j sends no credentials",
  async (offer) => {
    const peer = saslPeer(() => {}, offer);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "user",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    try {
      await expect(xmpp.start()).rejects.toThrow("No compatible mechanism");
      expect(peer.transcript.some((frame) => frame.startsWith("<auth"))).toBe(
        false,
      );
      expect(
        await peer.waitForClose().then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test.each(["failure", "abort", "abort-final"])(
  "RFC 6120 §§6.4.4–6.4.5: %s permits an explicit same-connection retry",
  async (mode) => {
    let attempts = 0;
    const peer = saslPeer((el, remote) => {
      if (el.is("auth", SASL)) {
        if (++attempts === 1) {
          remote.send(
            mode === "abort-final"
              ? `<success xmlns="${SASL}"/>`
              : mode === "abort"
                ? `<challenge xmlns="${SASL}"/>`
                : `<failure xmlns="${SASL}"><not-authorized/></failure>`,
          );
        } else {
          remote.send(`<success xmlns="${SASL}"/>`);
        }
      } else if (el.is("abort", SASL)) {
        remote.send(`<failure xmlns="${SASL}"><aborted/></failure>`);
      }
    });
    let failure: unknown;
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      timeout: TIMEOUT_MS,
      credentials: async (
        authenticate: (values: object, mechanism: string) => Promise<void>,
      ) => {
        failure = await authenticate({}, MECHANISM).catch(
          (error: Error) => error,
        );
        await authenticate({}, MECHANISM);
      },
    });
    xmpp.saslMechanisms.register(MECHANISM, () => ({
      name: MECHANISM,
      clientFirst: true,
      response: () => "",
      challenge: async () => {
        // Raw send is the existing public abort interface; no transport disconnect.
        await xmpp.send(xml("abort", { xmlns: SASL }));
      },
      final: async () => {
        if (mode === "abort-final" && attempts === 1) {
          await xmpp.send(xml("abort", { xmlns: SASL }));
        }
      },
    }));
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    try {
      const result = await xmpp.start().then(
        (jid) => jid.toString(),
        (error: Error) => error,
      );
      expect(result).toBe("user@example.test/r");
      expect(failure).toMatchObject({
        name: "SASLError",
        condition: mode === "failure" ? "not-authorized" : "aborted",
      });
      expect(attempts).toBe(2);
      expect(peer.requests).toHaveLength(1);
      expect(
        peer.transcript.some((frame) => frame.startsWith("<response")),
      ).toBe(false);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
