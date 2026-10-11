import { expect, test } from "bun:test";
import { client } from "../src/client/index.js";
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
) {
  return new ScriptedPeer((frame, peer) => {
    const root = readRoot(frame);
    if (root.open === `{${FRAMING}}open`) {
      peer.send(
        `<open xmlns="${FRAMING}" from="example.test" id="authorization" version="1.0"/>`,
      );
      peer.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>${mechanism}</mechanism></authentication></features>`,
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
) {
  return new ScriptedPeer((frame, remote) => {
    const root = readRoot(frame);
    if (root.open === `{${FRAMING}}open`) {
      remote.send(
        `<open xmlns="${FRAMING}" from="example.test" id="bind2" version="1.0"/>`,
      );
      remote.send(
        `<features xmlns="${STREAM}"><authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><inline><bind xmlns="${BIND2}"/></inline></authentication></features>`,
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
