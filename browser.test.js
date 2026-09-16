import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { createHash, X509Certificate } from "node:crypto";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import server from "./server/index.js";
import { ScriptedPeer } from "./conformance/peer.ts";
import { RawPeer } from "./conformance/raw-peer.ts";

const OPEN =
  '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="example.test" version="1.0" id="browser-peer"/>';
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';

// Native browser XML parsing is independent of both saxes and ltx.
function inspectFrames(frames) {
  return frames.map((frame) => {
    const document = new DOMParser().parseFromString(frame, "application/xml");
    const root = document.documentElement;
    return {
      valid: document.getElementsByTagName("parsererror").length === 0,
      name: root.localName,
      namespace: root.namespaceURI,
      body: document.getElementsByTagName("body")[0]?.textContent ?? null,
    };
  });
}

let browser;
const origin = createServer((_request, response) =>
  response.end("<!doctype html><title>XMPP test</title>"),
);
beforeAll(async () => {
  await server.restart();
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const certificate = new X509Certificate(
    await readFile(path.join(process.env.XMPP_TEST_DIR, "certs/localhost.crt")),
  );
  const spki = createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  // Trust only this disposable fixture key, not arbitrary HTTPS certificates.
  browser = await chromium.launch({
    args: [`--ignore-certificate-errors-spki-list=${spki}`],
  });
});

test("Chromium rejects the fixture certificate without explicit trust", async () => {
  const untrusted = await chromium.launch();
  try {
    const page = await untrusted.newPage();
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    const result = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const socket = new WebSocket(
            "wss://localhost:5281/xmpp-websocket",
            "xmpp",
          );
          socket.onopen = () => {
            socket.close();
            resolve("accepted");
          };
          socket.onerror = () => resolve("rejected");
        }),
    );
    expect(result).toBe("rejected");
  } finally {
    await untrusted.close();
  }
});
afterAll(async () => {
  await browser?.close();
  origin.close();
});

test.each([null, "other"])(
  "Chromium rejects an actual handshake selecting %s",
  async (protocol) => {
    const peer = await new RawPeer(protocol).listen();
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${origin.address().port}`);
      await page.addScriptTag({ path: "dist/xmpp.min.js" });
      const result = await page.evaluate(async (service) => {
        const xmpp = globalThis.XMPP.client({
          service,
          domain: "example.test",
        });
        xmpp.reconnect.stop();
        xmpp.on("error", () => {});
        let connected = false;
        xmpp.on("connect", () => {
          connected = true;
        });
        try {
          await xmpp.start();
          return { rejected: false, connected };
        } catch {
          return { rejected: true, connected };
        } finally {
          await xmpp.stop();
        }
      }, peer.url);
      expect(result).toEqual({ rejected: true, connected: false });
      expect(peer.requests).toHaveLength(1);
    } finally {
      await page.close();
      await peer.stop();
    }
  },
);

test("Chromium rejects invalid UTF-8 WebSocket text before message delivery", async () => {
  const peer = await new RawPeer("xmpp", [
    new Uint8Array([0x81, 0x02, 0xc3, 0x28]),
  ]).listen();
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    const messages = await page.evaluate(
      (service) =>
        new Promise((resolve, reject) => {
          const received = [];
          const socket = new WebSocket(service, "xmpp");
          const timer = setTimeout(() => {
            socket.close();
            reject(new Error("Invalid text did not close transport"));
          }, 2000);
          socket.onmessage = (event) => received.push(event.data);
          socket.onerror = () => {};
          socket.onclose = () => {
            clearTimeout(timer);
            resolve(received);
          };
        }),
      peer.url,
    );
    expect(messages).toEqual([]);
  } finally {
    await page.close();
    await peer.stop();
  }
});

test("Chromium independently validates outgoing RFC 7395 documents", async () => {
  const peer = new ScriptedPeer((frame, remote) => {
    if (frame.startsWith("<open ")) {
      remote.send(OPEN);
    }
    if (frame === CLOSE) {
      remote.send(CLOSE);
    }
  });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ path: "dist/xmpp.min.js" });
    const errors = await page.evaluate(async (service) => {
      const { client, xml } = globalThis.XMPP;
      const xmpp = client({ service, domain: "example.test" });
      const errors = [];
      xmpp.reconnect.stop();
      xmpp.on("error", (error) => errors.push(error.message));
      try {
        await xmpp.connect(service);
        await xmpp.open({ domain: "example.test" });
        await xmpp.send(xml("message", {}, xml("body", {}, "Zażółć 🐦 & < >")));
      } finally {
        await xmpp.stop();
      }
      return errors;
    }, peer.url);
    expect(errors).toEqual([]);
    expect(await page.evaluate(inspectFrames, peer.transcript)).toEqual([
      {
        valid: true,
        name: "open",
        namespace: "urn:ietf:params:xml:ns:xmpp-framing",
        body: null,
      },
      {
        valid: true,
        name: "message",
        namespace: "jabber:client",
        body: "Zażółć 🐦 & < >",
      },
      {
        valid: true,
        name: "close",
        namespace: "urn:ietf:params:xml:ns:xmpp-framing",
        body: null,
      },
    ]);
  } finally {
    await page.close();
    await peer.stop();
  }
});

test.each([
  '<message xmlns="jabber:client"><body>unfinished',
  '<message xmlns="jabber:client"/><presence xmlns="jabber:client"/>',
  '<close xmlns="urn:wrong"/>',
])(
  "Chromium rejects a malicious peer frame atomically: %s",
  async (malformed) => {
    const peer = new ScriptedPeer((frame, remote) => {
      if (frame.startsWith("<open ")) {
        remote.send(OPEN);
        remote.send(malformed);
      }
      if (frame === CLOSE) {
        remote.send(CLOSE);
      }
    });
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${origin.address().port}`);
      await page.addScriptTag({ path: "dist/xmpp.min.js" });
      const result = await page.evaluate(async (service) => {
        const xmpp = globalThis.XMPP.client({
          service,
          domain: "example.test",
          timeout: 250,
        });
        xmpp.reconnect.stop();
        const errors = [];
        const stanzas = [];
        xmpp.on("error", (error) => errors.push(error.name));
        xmpp.on("stanza", (stanza) => stanzas.push(stanza.toString()));
        let timer;
        const disconnected = new Promise((resolve, reject) => {
          xmpp.once("disconnect", resolve);
          timer = setTimeout(
            () => reject(new Error("Transport stayed open")),
            2000,
          );
        });
        try {
          await Promise.all([
            disconnected,
            (async () => {
              await xmpp.connect(service);
              await xmpp.open({ domain: "example.test" }).catch(() => {});
            })(),
          ]);
          return { errors, stanzas };
        } finally {
          clearTimeout(timer);
          await xmpp.stop();
        }
      }, peer.url);
      expect(result).toEqual({ errors: ["XMLError"], stanzas: [] });
      const frames = await page.evaluate(inspectFrames, peer.transcript);
      expect(frames.map(({ name }) => name)).toEqual([
        "open",
        "error",
        "close",
      ]);
      expect(frames.every(({ valid }) => valid)).toBe(true);
    } finally {
      await page.close();
      await peer.stop();
    }
  },
);

test.each([
  ["xmpp.js", "ws://localhost:5280/xmpp-websocket"],
  ["xmpp.min.js", "ws://localhost:5280/xmpp-websocket"],
  ["xmpp.min.js", "wss://[::1]:5281/xmpp-websocket"],
])("Chromium authenticates with %s over %s", async (file, service) => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ path: `dist/${file}` });
    const address = await page.evaluate(async (service) => {
      const xmpp = globalThis.XMPP.client({
        credentials: { username: "client", password: "foobar" },
        service,
        domain: "localhost",
      });
      try {
        return (await xmpp.start()).bare().toString();
      } finally {
        await xmpp.stop();
      }
    }, service);
    expect(address).toBe("client@localhost");
  } finally {
    await page.close();
  }
});
