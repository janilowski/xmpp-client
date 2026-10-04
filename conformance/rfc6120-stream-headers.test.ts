import { expect, test } from "bun:test";
import { client, xml } from "../src/client/index.js";
import { ScriptedPeer } from "./peer.ts";
import { readFrame } from "./xml.ts";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const CONTENT = "jabber:client";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const TIMEOUT_MS = 500;
const CLOSE = `<close xmlns="${FRAMING}"/>`;

// RFC 7395 §§3.3.1/3.4/3.7 preserve RFC 6120 §4.7 attribute semantics.
// Explicit loopback is the profile's test boundary, not evidence of TLS/PKIX.
test.each([
  ["known ASCII", "USER", "EXAMPLE.TEST.", "user@example.test"],
  ["known Unicode", "E\u0301", "XN--BCHER-KVA.example.", "é@bücher.example"],
  ["unknown until binding", undefined, "example.test", "user@example.test"],
] as const)(
  "RFC 6120 §§4.7.1–3/4.7.5: opening uses the prepared bare identity, never a resource or stream ID / %s",
  async (_name, username, domain, account) => {
    let opens = 0;
    const expectedDomain = account.split("@")[1];
    const peer = new ScriptedPeer((frame, remote) => {
      const root = readFrame(frame)[0];
      if (!("open" in root)) {
        throw new Error("Expected a document element");
      }
      if (root.open === `{${FRAMING}}open`) {
        opens += 1;
        remote.send(
          `<open xmlns="${FRAMING}" from="${expectedDomain}" id="peer-${opens}" version="1.0"/>`,
        );
        // The third opening tests only headers; do not start another binding.
        if (opens <= 2) {
          remote.send(
            `<features xmlns="${STREAM}">${opens === 1 ? `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>` : `<bind xmlns="${BIND}"/>`}</features>`,
          );
        }
      } else if (root.open === `{${SASL}}auth`) {
        remote.send(`<success xmlns="${SASL}"/>`);
      } else if (root.open === `{${CONTENT}}iq`) {
        remote.send(
          `<iq xmlns="${CONTENT}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${BIND}"><jid>${account}/resource</jid></bind></iq>`,
        );
      } else if (root.open === `{${FRAMING}}close`) {
        remote.send(CLOSE);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain,
      timeout: TIMEOUT_MS,
      ...(username === undefined
        ? { credentials: { username: "user", password: "secret" } }
        : { username, password: "secret" }),
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      expect(String(await xmpp.start())).toBe(`${account}/resource`);
      await xmpp.restart();
      const headers = peer.transcript.filter((frame) => {
        const root = readFrame(frame)[0];
        return "open" in root && root.open === `{${FRAMING}}open`;
      });
      expect(headers).toHaveLength(3);
      for (const [index, header] of headers.entries()) {
        const from = username !== undefined || index === 2;
        expect(readFrame(header)).toEqual(
          readFrame(
            `<open xmlns="${FRAMING}" to="${expectedDomain}" version="1.0"${from ? ` from="${account}"` : ""}/>`,
          ),
        );
      }
      expect(peer.transcript.some((frame) => frame.startsWith("<close"))).toBe(
        false,
      );
      expect(peer.requests).toHaveLength(1);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

// Server response obligations are not client rejection requirements. §§4.7.1/2
// recommend accepting legacy missing addresses; higher minor versions and leading
// zeros must be tolerated. Do not invent response attributes or routing authority.
test.each([
  "1.0",
  "01.00",
  "1.13",
  "0001.00013",
  "1.123456789012345678901234567890",
])(
  "RFC 6120 §§4.7.1–3/4.7.5: legacy response omissions and numeric version %s remain interoperable",
  async (version) => {
    const response = `<open xmlns="${FRAMING}" version="${version}"/>`;
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open")) {
        remote.send(response);
      } else if (frame.startsWith("<close")) {
        remote.send(CLOSE);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      await xmpp.connect(peer.url);
      const opened = await xmpp.open({ domain: "example.test" });
      expect(opened.attrs).toEqual({ xmlns: FRAMING, version });
      expect(xmpp.status).toBe("open");
      expect(readFrame(peer.transcript[0])).toEqual(
        readFrame(`<open xmlns="${FRAMING}" to="example.test" version="1.0"/>`),
      );
      const result = await xmpp
        .send(xml("message", { to: "remote.test", id: "forbidden" }))
        .catch((error: Error) => error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("Stream negotiation is not complete");
      expect(peer.transcript).toHaveLength(1);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);

test("RFC 6120 §4.7.1: a different server address and opaque stream ID grant no identity authority", async () => {
  const response = `<open xmlns="${FRAMING}" from="alias.example.test" id="opaque+/==" version="1.0"/>`;
  const peer = new ScriptedPeer((frame, remote) => {
    if (frame.startsWith("<open")) {
      remote.send(response);
    } else if (frame.startsWith("<close")) {
      remote.send(CLOSE);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    await xmpp.connect(peer.url);
    const opened = await xmpp.open({ domain: "example.test" });
    expect(opened.attrs).toEqual({
      xmlns: FRAMING,
      from: "alias.example.test",
      id: "opaque+/==",
      version: "1.0",
    });
    const result = await xmpp
      .send(xml("message", { to: "alias.example.test", id: "forbidden" }))
      .catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Stream negotiation is not complete");
    expect(peer.transcript.map(readFrame)).toEqual([
      readFrame(`<open xmlns="${FRAMING}" to="example.test" version="1.0"/>`),
    ]);
    expect(errors).toEqual([]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test("RFC 6120 §4.7.5: a missing response version is unsupported 0.9, not implicit 1.0", async () => {
  const peer = new ScriptedPeer((frame, remote) => {
    if (frame.startsWith("<open")) {
      remote.send(`<open xmlns="${FRAMING}" from="example.test" id="peer"/>`);
    } else if (frame.startsWith("<close")) {
      remote.send(CLOSE);
    }
  });
  const xmpp = client({
    service: peer.url,
    domain: "example.test",
    timeout: TIMEOUT_MS,
  });
  xmpp.reconnect.stop();
  const errors: Error[] = [];
  xmpp.on("error", (error: Error) => errors.push(error));
  try {
    await xmpp.connect(peer.url);
    const result = await xmpp
      .open({ domain: "example.test" })
      .catch((error: Error) => error);
    expect(result).toMatchObject({ condition: "unsupported-version" });
    await peer.waitForClose();
    expect(peer.transcript.map(readFrame)).toEqual([
      readFrame(`<open xmlns="${FRAMING}" to="example.test" version="1.0"/>`),
      readFrame(
        `<error xmlns="${STREAM}"><unsupported-version xmlns="${STREAM_ERRORS}"/></error>`,
      ),
      readFrame(CLOSE),
    ]);
    expect(errors).toEqual([result]);
    expect(peer.errors).toEqual([]);
  } finally {
    await xmpp.stop();
    await peer.stop();
  }
});

test.each([
  ["missing", {}],
  ["undefined", { domain: undefined }],
  ["null", { domain: null }],
  ["empty", { domain: "" }],
  ["localpart", { domain: "user@example.test" }],
  ["resourcepart", { domain: "example.test/resource" }],
] as const)(
  "RFC 6120 §4.7.2: invalid opening target rejects before any frame and permits recovery / %s",
  async (_name, options) => {
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open")) {
        remote.send(
          `<open xmlns="${FRAMING}" from="example.test" id="peer" version="1.0"/>`,
        );
      } else if (frame.startsWith("<close")) {
        remote.send(CLOSE);
      }
    });
    const xmpp = client({
      service: peer.url,
      domain: "example.test",
      timeout: TIMEOUT_MS,
    });
    xmpp.reconnect.stop();
    const errors: Error[] = [];
    xmpp.on("error", (error: Error) => errors.push(error));
    try {
      await xmpp.connect(peer.url);
      const result = await xmpp.open(options).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(peer.transcript).toEqual([]);
      expect(result).toBeInstanceOf(TypeError);
      expect(xmpp.status).toBe("connect");
      await xmpp.open({ domain: "example.test" });
      // A successful reply is the ordered wire barrier after invalid config.
      expect(peer.transcript.map(readFrame)).toEqual([
        readFrame(`<open xmlns="${FRAMING}" to="example.test" version="1.0"/>`),
      ]);
      expect(errors).toEqual([]);
      expect(peer.errors).toEqual([]);
    } finally {
      await xmpp.stop();
      await peer.stop();
    }
  },
);
