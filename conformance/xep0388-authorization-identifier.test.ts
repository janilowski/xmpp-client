import { describe, expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const CLIENT = "jabber:client";
const SASL2 = "urn:xmpp:sasl:2";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const BIND2 = "urn:xmpp:bind:0";
const SM = "urn:xmpp:sm:3";
const FAST = "urn:xmpp:fast:0";
const EXTENSION = "urn:test:side-effect";
const ACCOUNT = "authorized@example.test";
const ANONYMOUS_ACCOUNT = "anon-91@example.test";
const FULL_JID = `${ACCOUNT}/old`;
const TIMEOUT_MS = 300;

function readRoot(frame: string) {
  const root = readFrame(frame)[0];
  if (!root || !("open" in root)) {
    throw new Error("Expected a client element");
  }

  return root;
}

function authenticationPeer(
  content: string,
  mechanism = "PLAIN",
  boundAccount = ACCOUNT,
  onBind?: () => void,
  inlineOffers = "",
) {
  return new ScriptedPeer((frame, peer) => {
    const root = readRoot(frame);
    if (root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="authorization" version="1.0"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>${mechanism}</mechanism>${inlineOffers && `<inline>${inlineOffers}</inline>`}</authentication></features>`,
      );
    } else if (root.open === `{${SASL2}}authenticate`) {
      peer.send(`<success xmlns="${SASL2}">${content}</success>`);
      // Finish the legal continuation so accepting invalid success cannot time out.
      peer.send(
        `<features xmlns="${STREAM}"><bind xmlns="${BIND}"/></features>`,
      );
    } else if (root.open === `{${CLIENT}}iq`) {
      onBind?.();
      peer.send(
        `<iq xmlns="${CLIENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${boundAccount}/new</jid></bind></iq>`,
      );
    } else if (root.open === `{${FRAMING}}close`) {
      peer.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

// XEP-0388 v1.0.4 §§2.6.1, 5.1, 8 requires exactly one SASL2 identifier.
// RFC 6120 §4.3.6 narrows this C2S slot to an account JID.
test.each([
  ["absent", ""],
  ["empty", "<authorization-identifier/>"],
  [
    "foreign namespace only",
    '<authorization-identifier xmlns="urn:test:foreign">authorized@example.test</authorization-identifier>',
  ],
  [
    "duplicate",
    `<authorization-identifier>${ACCOUNT}</authorization-identifier><authorization-identifier>other@example.test</authorization-identifier>`,
  ],
  [
    "malformed JID",
    "<authorization-identifier>user@</authorization-identifier>",
  ],
  [
    "domain-only JID",
    "<authorization-identifier>example.test</authorization-identifier>",
  ],
  [
    "full JID without binding",
    `<authorization-identifier>${ACCOUNT}/unbound</authorization-identifier>`,
  ],
  [
    "unrequested binding result",
    `<authorization-identifier>${FULL_JID}</authorization-identifier><bound xmlns="${BIND2}"/>`,
  ],
  [
    "unrequested resumption result",
    `<authorization-identifier>${FULL_JID}</authorization-identifier><resumed xmlns="${SM}" previd="unsolicited" h="0"/>`,
  ],
  [
    "element content",
    `<authorization-identifier>${ACCOUNT}<spoof xmlns="urn:test:foreign"/></authorization-identifier>`,
  ],
] as const)(
  "XEP-0388 §§2.6.1, 8 / RFC 6120 §4.3.6: reject invalid authorization identifier / %s",
  async (_name, content) => {
    const peer = authenticationPeer(content);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    xmpp.on("error", () => {});
    try {
      const result = await xmpp.start().then(
        (address) => address.toString(),
        (error: Error) => error,
      );
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).name).not.toBe("TimeoutError");
      expect(xmpp.status).not.toBe("online");
      expect(xmpp.jid?.toString()).toBe("configured@example.test");
      expect(peer.transcript.some((frame) => frame.startsWith("<iq"))).toBe(
        false,
      );
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("XEP-0388 §2.6.1: accept the server-assigned account", async () => {
  let identityAtBind: string | undefined;
  const peer = authenticationPeer(
    `<authorization-identifier>${ACCOUNT}</authorization-identifier>`,
    "PLAIN",
    ACCOUNT,
    () => {
      identityAtBind = xmpp.jid?.toString();
    },
  );
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "configured",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  try {
    expect((await xmpp.start()).toString()).toBe(`${ACCOUNT}/new`);
    expect(identityAtBind).toBe(ACCOUNT);
    expect(xmpp.jid?.toString()).toBe(`${ACCOUNT}/new`);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each([
  [
    "a foreign sibling",
    `<authorization-identifier xmlns="urn:test:foreign">ignored@example.test</authorization-identifier><authorization-identifier>${ACCOUNT}</authorization-identifier>`,
  ],
  [
    "a namespace prefix",
    `<s:authorization-identifier xmlns:s="${SASL2}">${ACCOUNT}</s:authorization-identifier>`,
  ],
] as const)(
  "XEP-0388 §§2.6.1, 8: accept one same-namespace identifier with %s",
  async (_shape, content) => {
    const peer = authenticationPeer(content);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    try {
      expect((await xmpp.start()).toString()).toBe(`${ACCOUNT}/new`);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §6.3.8: accept an explicitly requested proxy authorization identity", async () => {
  let identityAtBind: string | undefined;
  const peer = authenticationPeer(
    `<authorization-identifier>${ACCOUNT}</authorization-identifier>`,
    "PLAIN",
    ACCOUNT,
    () => {
      identityAtBind = xmpp.jid?.toString();
    },
  );
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    credentials: {
      username: "configured",
      password: "secret",
      authzid: ACCOUNT,
    },
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  try {
    expect((await xmpp.start()).toString()).toBe(`${ACCOUNT}/new`);
    expect(identityAtBind).toBe(ACCOUNT);
    const frame = peer.transcript.find((entry) =>
      entry.startsWith("<authenticate"),
    );
    expect(frame).toBeDefined();
    const response = readFrame(frame!).find(
      (event) => "text" in event && event.text !== "",
    );
    expect(response).toEqual({
      text: btoa(`${ACCOUNT}\0configured\0secret`),
    });
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("XEP-0388 §2.6.1: accept a generated ANONYMOUS account", async () => {
  const peer = authenticationPeer(
    `<authorization-identifier>${ANONYMOUS_ACCOUNT}</authorization-identifier>`,
    "ANONYMOUS",
    ANONYMOUS_ACCOUNT,
  );
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  try {
    expect((await xmpp.start()).toString()).toBe(`${ANONYMOUS_ACCOUNT}/new`);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("XEP-0388 §2.6.1: reject identity before extension and FAST token side effects", async () => {
  const peer = authenticationPeer(
    `<token xmlns="${FAST}" token="must-not-save" expiry="2099-01-01T00:00:00Z"/><effect xmlns="${EXTENSION}"/>`,
  );
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "configured",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  let extensions = 0;
  let tokens = 0;
  const fast = xmpp.fast as unknown as {
    saveToken: (token: unknown) => Promise<void>;
  };
  fast.saveToken = async () => {
    tokens += 1;
  };
  xmpp.sasl2.use(
    EXTENSION,
    () => undefined,
    () => {
      extensions += 1;
    },
  );
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  try {
    const result = await xmpp.start().catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).name).not.toBe("TimeoutError");
    expect(extensions).toBe(0);
    expect(tokens).toBe(0);
    expect(xmpp.jid?.toString()).toBe("configured@example.test");
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

function inlineBindingPeer(
  identifier: string,
  result = `<bound xmlns="${BIND2}"/>`,
  inlineOffers = "",
) {
  return new ScriptedPeer((frame, remote) => {
    const root = readRoot(frame);
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="bind2" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><inline><bind xmlns="${BIND2}"/>${inlineOffers}</inline></authentication></features>`,
      );
    } else if (root.open === `{${SASL2}}authenticate`) {
      remote.send(
        `<success xmlns="${SASL2}"><authorization-identifier>${identifier}</authorization-identifier>${result}</success>`,
      );
      remote.send(`<features xmlns="${STREAM}"/>`);
    } else if (root.open === `{${FRAMING}}close`) {
      remote.send(`<close xmlns="${FRAMING}"/>`);
    }
  });
}

test.each([
  [FULL_JID, FULL_JID],
  ["AUTHORIZED@ＥＸＡＭＰＬＥ。TEST/old", FULL_JID],
] as const)(
  "XEP-0388 §2.6.1 / XEP-0386 §3.2.1: accept normalized full identifier %s after Bind2",
  async (identifier, expected) => {
    const peer = inlineBindingPeer(identifier);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    try {
      expect((await xmpp.start()).toString()).toBe(expected);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("XEP-0388 §2.6.1 / XEP-0386 §3.2.1: reject a bare identifier after Bind2", async () => {
  const peer = inlineBindingPeer(ACCOUNT);
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "configured",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  try {
    const result = await xmpp.start().then(
      (address) => address.toString(),
      (error: Error) => error,
    );
    expect(result).toBeInstanceOf(Error);
    expect(xmpp.status).not.toBe("online");
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("XEP-0386 §3.2.1: reject duplicate Bind2 results", async () => {
  const peer = inlineBindingPeer(
    FULL_JID,
    `<bound xmlns="${BIND2}"/><bound xmlns="${BIND2}"/>`,
  );
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    username: "configured",
    password: "secret",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  try {
    const result = await xmpp.start().catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).name).not.toBe("TimeoutError");
    expect(xmpp.jid?.toString()).toBe("configured@example.test");
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

describe("XEP-0388 §2.6.1 — prepared authorization-identifier limits", () => {
  const MAX_PART_BYTES = 1023;
  const MAX_JID_BYTES = 3071;
  const MAX_LITERAL = `[v1.${"a".repeat(1018)}]`;
  const TOKEN_MECHANISM = "HT-SHA-256-NONE";
  const TOKEN = "identity-bound-token";
  const EXPIRY = "2099-01-01T00:00:00Z";
  const OFFERS = `<fast xmlns="${FAST}"><mechanism>${TOKEN_MECHANISM}</mechanism></fast><offer xmlns="${EXTENSION}"/>`;
  const EFFECTS = `<token xmlns="${FAST}" token="${TOKEN}" expiry="${EXPIRY}"/><effect xmlns="${EXTENSION}"/>`;
  const encoder = new TextEncoder();
  const CONTEXTS = ["bare", "Bind2"] as const;
  const valid = [
    ["ASCII local", "local", "A".repeat(1023), "a".repeat(1023)],
    ["multibyte local", "local", `${"É".repeat(511)}a`, `${"é".repeat(511)}a`],
    [
      "NFC-contracted local",
      "local",
      `${"e\u0301".repeat(511)}a`,
      `${"é".repeat(511)}a`,
    ],
    ["width-mapped local", "local", "Ａ".repeat(1023), "a".repeat(1023)],
    [
      "lowercase-expanded local",
      "local",
      "İ".repeat(341),
      "i\u0307".repeat(341),
    ],
    ["IPvFuture domain", "domain", MAX_LITERAL, MAX_LITERAL],
    ["ASCII resource", "resource", "R".repeat(1023), "R".repeat(1023)],
    [
      "supplementary resource",
      "resource",
      `${"🙂".repeat(255)}abc`,
      `${"🙂".repeat(255)}abc`,
    ],
    ["fullwidth resource", "resource", "Ａ".repeat(341), "Ａ".repeat(341)],
    [
      "NFC-contracted resource",
      "resource",
      `${"e\u0301".repeat(511)}a`,
      `${"é".repeat(511)}a`,
    ],
    [
      "space-mapped resource",
      "resource",
      "\u2003".repeat(1023),
      " ".repeat(1023),
    ],
    [
      "NFC-expanded resource",
      "resource",
      `${"\u0344".repeat(255)}abc`,
      `${"\u0308\u0301".repeat(255)}abc`,
    ],
    [
      "3071-octet full JID",
      "full",
      `${"a".repeat(1023)}@${MAX_LITERAL}/${"R".repeat(1023)}`,
      `${"a".repeat(1023)}@${MAX_LITERAL}/${"R".repeat(1023)}`,
    ],
    [
      "NFC-contracted 3071-octet full JID",
      "full",
      `${"e\u0301".repeat(511)}a@${MAX_LITERAL}/${"e\u0301".repeat(511)}a`,
      `${"é".repeat(511)}a@${MAX_LITERAL}/${"é".repeat(511)}a`,
    ],
  ] as const;
  const invalid = [
    ["ASCII local", "local", "a".repeat(1024), "a".repeat(1024)],
    ["multibyte local", "local", "é".repeat(512), "é".repeat(512)],
    ["NFC-contracted local", "local", "e\u0301".repeat(512), "é".repeat(512)],
    ["width-mapped local", "local", "Ａ".repeat(1024), "a".repeat(1024)],
    [
      "lowercase-expanded local",
      "local",
      `${"İ".repeat(341)}a`,
      `${"i\u0307".repeat(341)}a`,
    ],
    [
      "IPvFuture domain",
      "domain",
      `[v1.${"a".repeat(1019)}]`,
      `[v1.${"a".repeat(1019)}]`,
    ],
    ["ASCII resource", "resource", "R".repeat(1024), "R".repeat(1024)],
    ["multibyte resource", "resource", "é".repeat(512), "é".repeat(512)],
    [
      "fullwidth resource",
      "resource",
      `${"Ａ".repeat(341)}a`,
      `${"Ａ".repeat(341)}a`,
    ],
    [
      "NFC-contracted resource",
      "resource",
      "e\u0301".repeat(512),
      "é".repeat(512),
    ],
    [
      "space-mapped resource",
      "resource",
      "\u2003".repeat(1024),
      " ".repeat(1024),
    ],
    ["supplementary resource", "resource", "🙂".repeat(256), "🙂".repeat(256)],
    [
      "NFC-expanded resource",
      "resource",
      "\u0344".repeat(256),
      "\u0308\u0301".repeat(256),
    ],
  ] as const;

  // RFC 7622 §§3.1–3.4/4 supplies prepared octet limits; enforcement is the
  // server's duty. Strict rejection of received identities is our local policy.
  // XEP-0388 v1.0.4 §2.6.1 and XEP-0386 v1.1.0 §3.2.1 select bare/full context.
  function identitySession(
    context: (typeof CONTEXTS)[number],
    raw: string,
    prepared: string,
  ) {
    const bindings: string[] = [];
    const online: string[] = [];
    const errors: Error[] = [];
    const effects: string[] = [];
    const tokens: { token: unknown; identity: string }[] = [];
    function makePeer(identifier: string, canonical: string) {
      if (context === "Bind2") {
        return inlineBindingPeer(
          identifier,
          `${EFFECTS}<bound xmlns="${BIND2}"/>`,
          OFFERS,
        );
      }
      // Effects precede the identifier so a sequential, late identity check leaks.
      return authenticationPeer(
        `${EFFECTS}<authorization-identifier>${identifier}</authorization-identifier>`,
        "PLAIN",
        canonical,
        () => bindings.push(String(xmpp.jid)),
        OFFERS,
      );
    }
    const peer = makePeer(raw, prepared);
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      username: "configured",
      password: "secret",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const initialIdentity = String(xmpp.jid);
    xmpp.on("online", (address: { toString(): string }) =>
      online.push(String(address)),
    );
    xmpp.on("error", (error: Error) => errors.push(error));
    const fast = xmpp.fast as unknown as {
      saveToken: (token: unknown) => Promise<void>;
    };
    fast.saveToken = async (token) => {
      tokens.push({ token, identity: String(xmpp.jid) });
    };
    xmpp.sasl2.use(
      EXTENSION,
      () => xml("request", { xmlns: EXTENSION }),
      () => {
        effects.push(String(xmpp.jid));
      },
    );
    async function start() {
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          xmpp.start().then(
            (address) => ({
              kind: "result" as const,
              address: String(address),
            }),
            (error: Error) => ({ kind: "error" as const, error }),
          ),
          new Promise<{ kind: "deadline" }>((resolve) => {
            watchdog = setTimeout(
              () => resolve({ kind: "deadline" }),
              TIMEOUT_MS * 3,
            );
          }),
        ]);
      } finally {
        clearTimeout(watchdog);
      }
    }
    return {
      xmpp,
      peer,
      makePeer,
      start,
      initialIdentity,
      bindings,
      online,
      errors,
      effects,
      tokens,
    };
  }

  for (const context of CONTEXTS) {
    for (const [name, part, rawPart, preparedPart] of valid) {
      if (context === "bare" && (part === "resource" || part === "full")) {
        continue;
      }
      test(`RFC 7622 §§3.1–3.4: accept prepared identifier boundary / ${name} / ${context}`, async () => {
        const rawBare = `${part === "local" ? rawPart : "assigned"}@${part === "domain" ? rawPart : "canonical.example"}`;
        const preparedBare = `${part === "local" ? preparedPart : "assigned"}@${part === "domain" ? preparedPart : "canonical.example"}`;
        const raw =
          part === "full"
            ? rawPart
            : context === "Bind2"
              ? `${rawBare}/${part === "resource" ? rawPart : "R"}`
              : rawBare;
        const prepared =
          part === "full"
            ? preparedPart
            : context === "Bind2"
              ? `${preparedBare}/${part === "resource" ? preparedPart : "R"}`
              : preparedBare;
        const fixture = identitySession(context, raw, prepared);
        const { xmpp, peer, bindings, online, errors, effects, tokens } =
          fixture;
        const final = context === "bare" ? `${prepared}/new` : prepared;
        try {
          expect(encoder.encode(preparedPart).byteLength).toBe(
            part === "full" ? MAX_JID_BYTES : MAX_PART_BYTES,
          );
          if (name.includes("contracted") || name.includes("mapped")) {
            expect(encoder.encode(rawPart).byteLength).toBeGreaterThan(
              part === "full" ? MAX_JID_BYTES : MAX_PART_BYTES,
            );
          }
          expect(await fixture.start()).toEqual({
            kind: "result",
            address: final,
          });
          expect(String(xmpp.jid)).toBe(final);
          expect(online).toEqual([final]);
          expect(bindings).toEqual(context === "bare" ? [prepared] : []);
          expect(effects).toEqual([prepared]);
          expect(tokens).toEqual([
            {
              token: {
                mechanism: TOKEN_MECHANISM,
                token: TOKEN,
                expiry: EXPIRY,
              },
              identity: prepared,
            },
          ]);
          const frames = peer.transcript.filter((frame) =>
            frame.startsWith("<authenticate"),
          );
          expect(frames).toHaveLength(1);
          const events = readFrame(frames[0]);
          expect(events).toContainEqual({
            open: `{${FAST}}request-token`,
            attributes: { "{}mechanism": TOKEN_MECHANISM },
          });
          expect(events).toContainEqual({
            open: `{${EXTENSION}}request`,
            attributes: {},
          });
          expect(
            events.some(
              (event) => "open" in event && event.open === `{${BIND2}}bind`,
            ),
          ).toBe(context === "Bind2");
          expect(
            peer.transcript.filter((frame) => frame.startsWith("<iq")),
          ).toHaveLength(context === "bare" ? 1 : 0);
          expect(errors).toEqual([]);
          expect(peer.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await peer.stop();
        }
      });
    }

    for (const [name, part, rawPart, preparedPart] of invalid) {
      if (context === "bare" && part === "resource") {
        continue;
      }
      test(`RFC 7622 §§3.1–3.4 local identity policy: reject prepared 1024 octets before effects / ${name} / ${context}`, async () => {
        const bare = `${part === "local" ? rawPart : "assigned"}@${part === "domain" ? rawPart : "canonical.example"}`;
        const raw =
          context === "Bind2"
            ? `${bare}/${part === "resource" ? rawPart : "R"}`
            : bare;
        const fixture = identitySession(context, raw, ACCOUNT);
        const {
          xmpp,
          peer,
          initialIdentity,
          bindings,
          online,
          errors,
          effects,
          tokens,
        } = fixture;
        const recoveredIdentity = context === "bare" ? ACCOUNT : FULL_JID;
        const replacement = fixture.makePeer(
          recoveredIdentity,
          recoveredIdentity,
        );
        try {
          expect(encoder.encode(preparedPart).byteLength).toBe(
            MAX_PART_BYTES + 1,
          );
          if (name.includes("expanded")) {
            expect(encoder.encode(rawPart).byteLength).toBeLessThanOrEqual(
              MAX_PART_BYTES,
            );
          }
          const outcome = await fixture.start();
          expect(outcome.kind).toBe("error");
          expect(outcome).toMatchObject({ error: expect.any(TypeError) });
          expect(String(xmpp.jid)).toBe(initialIdentity);
          expect(online).toEqual([]);
          expect(bindings).toEqual([]);
          expect(effects).toEqual([]);
          expect(tokens).toEqual([]);
          const denied = await xmpp
            .send(
              xml("message", { id: "unauthorized", to: "other@remote.test/r" }),
            )
            .catch((error: Error) => error);
          expect(denied).toBeInstanceOf(Error);
          await xmpp.stop();
          await peer.waitForClose();
          expect(online).toEqual([]);
          expect(bindings).toEqual([]);
          expect(effects).toEqual([]);
          expect(tokens).toEqual([]);
          expect(
            peer.transcript.some(
              (frame) =>
                frame.startsWith("<iq") || frame.includes('id="unauthorized"'),
            ),
          ).toBe(false);
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBeInstanceOf(TypeError);
          expect(peer.errors).toEqual([]);

          // A rejected success must not poison a later explicitly started stream.
          xmpp.options = { ...xmpp.options, service: replacement.url };
          const final = context === "bare" ? `${ACCOUNT}/new` : FULL_JID;
          expect(await fixture.start()).toEqual({
            kind: "result",
            address: final,
          });
          expect(String(xmpp.jid)).toBe(final);
          expect(online).toEqual([final]);
          expect(bindings).toEqual(context === "bare" ? [ACCOUNT] : []);
          expect(effects).toEqual([recoveredIdentity]);
          expect(tokens).toEqual([
            {
              token: {
                mechanism: TOKEN_MECHANISM,
                token: TOKEN,
                expiry: EXPIRY,
              },
              identity: recoveredIdentity,
            },
          ]);
          expect(errors).toHaveLength(1);
          expect(replacement.errors).toEqual([]);
        } finally {
          await xmpp.stop();
          await replacement.stop();
          await peer.stop();
        }
      });
    }
  }
});
