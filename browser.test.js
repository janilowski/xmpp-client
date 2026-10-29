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
import { readFrame } from "./conformance/xml.ts";
import { rolldown } from "rolldown";

const OPEN =
  '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="example.test" version="1.0" id="browser-peer"/>';
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const STREAM = "http://etherx.jabber.org/streams";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const OBSERVATION_TIMEOUT_MS = 2000;
const CROSS_HOST_REDIRECT_MESSAGE =
  "Cross-host stream redirects are not supported";

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

// RFC 5802 §5: the shipped browser bundle must produce the independent vector.
test("Chromium SCRAM uses Web Crypto and verifies the RFC server proof", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ path: "dist/xmpp.min.js" });
    /* eslint-disable n/no-unsupported-features/node-builtins -- browser Web Crypto */
    const result = await page.evaluate(async () => {
      const original = crypto.getRandomValues;
      crypto.getRandomValues = () =>
        Uint8Array.from(atob("fyko+d2lbbFgONRv9qkxdawL"), (c) =>
          c.charCodeAt(0),
        );
      try {
        const entity = globalThis.XMPP.client({ domain: "example.test" });
        const mech = entity.saslMechanisms.create("SCRAM-SHA-1");
        const credentials = {
          username: "u\u00adser",
          password: "\uff50en\u00adcil",
        };
        const first = await mech.response(credentials);
        await mech.challenge(
          "r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096",
        );
        const proof = await mech.response(credentials);
        await mech.final("v=rmF9pqV8S7suAoZWja4dJRkFsKQ=");
        return { first, proof };
      } finally {
        crypto.getRandomValues = original;
      }
    });
    /* eslint-enable n/no-unsupported-features/node-builtins */
    expect(result).toEqual({
      first: "n,,n=user,r=fyko+d2lbbFgONRv9qkxdawL",
      proof:
        "c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,p=v0X8v3Bz2T0CJGbJQyF0X+HI4Ts=",
    });
  } finally {
    await page.close();
  }
});

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

test("Chromium discovery rejects redirects whose target the Fetch API conceals", async () => {
  let targetRequests = 0;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      targetRequests += 1;
      return new Response("unexpected downgrade");
    },
  });
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      cert: await readFile(
        path.join(process.env.XMPP_TEST_DIR, "certs/localhost.crt"),
      ),
      key: await readFile(
        path.join(process.env.XMPP_TEST_DIR, "certs/localhost.key"),
      ),
    },
    fetch(request) {
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Location",
      };
      if (new URL(request.url).pathname === "/positive-control") {
        return new Response("reachable", { headers });
      }
      return new Response(null, {
        status: HTTP_FOUND,
        headers: {
          ...headers,
          Location: `http://localhost:${target.port}/metadata`,
        },
      });
    },
  });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ path: "dist/xmpp.min.js" });
    const result = await page.evaluate(async (port) => {
      const base = `https://localhost:${port}`;
      const control = await fetch(`${base}/positive-control`);
      const manual = await fetch(`${base}/.well-known/host-meta`, {
        redirect: "manual",
      });
      const xmpp = globalThis.XMPP.client({
        service: `localhost:${port}`,
        domain: "example.test",
      });
      xmpp.reconnect.stop();
      xmpp.on("error", () => {});
      let outcome = "accepted";
      try {
        await xmpp.connect(xmpp.options.service);
      } catch (error) {
        outcome = error.message;
      } finally {
        await xmpp.stop();
      }
      return {
        control: control.status,
        type: manual.type,
        status: manual.status,
        location: manual.headers.get("Location"),
        outcome,
      };
    }, source.port);
    expect(result).toEqual({
      control: HTTP_OK,
      type: "opaqueredirect",
      status: 0,
      location: null,
      outcome: "No compatible secure transport found.",
    });
    expect(targetRequests).toBe(0);
  } finally {
    await page.close();
    await source.stop(true);
    await target.stop(true);
  }
});

test("Chromium decodes every Unicode property without changing its repertoire", async () => {
  const build = await rolldown({ input: "src/jid/lib/unicode.js" });
  const page = await browser.newPage();
  try {
    const { output } = await build.generate({
      format: "iife",
      name: "UnicodeTables",
      minify: true,
    });
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ content: output[0].code });
    const hash = await page.evaluate(async () => {
      const properties = Object.entries(globalThis.UnicodeTables)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, property]) => property);
      const end = 0x110000;
      const values = new Uint8Array(properties.length * end);
      for (let bit = 0; bit < properties.length; bit++) {
        for (let cp = 0; cp < end; cp++) {
          values[bit * end + cp] = Number(
            properties[bit].test(String.fromCodePoint(cp)),
          );
        }
      }
      const digest = await window.crypto.subtle.digest("SHA-256", values);
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    });
    expect(hash).toBe(
      "c445e88b892f68395bd6025dabb88abb11d9e53de2165bb77849a1ca1487ba83",
    );
  } finally {
    await page.close();
    await build.close();
  }
}, 20000);

test("Chromium bundled JIDs enforce RFC 7622 profiles", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ path: "dist/xmpp.min.js" });
    const result = await page.evaluate(() => {
      const { jid } = globalThis.XMPP;
      const invalid = [
        "@example.com",
        "a b@example.com",
        "a\u200db@example.com",
        "אבa@example.com",
        "😀.example",
        "example.com/\ud800",
        `${"é".repeat(512)}@example.com`,
      ];
      return {
        normalized: jid(
          "E\u0301@XN--BCHER-KVA.example./Re\u0301s\u00a0X",
        ).toString(),
        width: jid("ＦＯＯ@example.com/Ｒ").toString(),
        contexts: jid("カ・a@example.com").local,
        rejected: invalid.map((value) => {
          try {
            jid(value);
            return false;
          } catch (error) {
            return error instanceof TypeError;
          }
        }),
      };
    });
    expect(result).toEqual({
      normalized: "é@bücher.example/Rés X",
      width: "foo@example.com/Ｒ",
      contexts: "カ・a",
      rejected: Array(7).fill(true),
    });
  } finally {
    await page.close();
  }
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

test("Chromium blocks cross-host stream redirects before contacting the target", async () => {
  const destination = new ScriptedPeer((frame, peer) => {
    if (frame.startsWith("<open ")) {
      peer.send(OPEN);
    } else if (frame === CLOSE) {
      peer.send(CLOSE);
    }
  });
  const target = new URL(destination.url);
  target.hostname = "localhost";
  const source = new ScriptedPeer((frame, peer) => {
    if (frame.startsWith("<open ")) {
      peer.send(OPEN);
      peer.send(
        `<stream:error xmlns:stream="${STREAM}"><see-other-host xmlns="${STREAM_ERRORS}">${target.host}</see-other-host></stream:error>`,
      );
    } else if (frame === CLOSE) {
      peer.send(CLOSE);
    }
  });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ path: "dist/xmpp.min.js" });
    const result = await page.evaluate(
      async ({ service, timeout }) => {
        const xmpp = globalThis.XMPP.client({
          service,
          domain: "example.test",
        });
        xmpp.reconnect.stop();
        let opens = 0;
        let timer;
        const outcome = new Promise((resolve) => {
          xmpp.on("error", (error) => resolve(error.message));
          xmpp.on("open", () => {
            opens++;
            if (opens > 1) {
              resolve("contacted");
            }
          });
          timer = setTimeout(() => resolve("timeout"), timeout);
        });
        try {
          await xmpp.connect(service);
          await xmpp.open({ domain: "example.test" });
          return await outcome;
        } finally {
          clearTimeout(timer);
          await xmpp.stop();
        }
      },
      { service: source.url, timeout: OBSERVATION_TIMEOUT_MS },
    );
    expect(result).toBe(CROSS_HOST_REDIRECT_MESSAGE);
    await source.waitForClose();
    expect(destination.requests).toEqual([]);
    expect(destination.transcript).toEqual([]);
    expect(source.errors).toEqual([]);
    expect(destination.errors).toEqual([]);
  } finally {
    await page.close();
    await source.stop();
    await destination.stop();
  }
});

// XEP-0198 v1.6.3 §4 owns unacknowledged stanzas; the limit is local policy.
test("Chromium bundled SM rejects overflow before sending and recovers after ACK", async () => {
  const framing = "urn:ietf:params:xml:ns:xmpp-framing";
  const content = "jabber:client";
  const sasl = "urn:ietf:params:xml:ns:xmpp-sasl";
  const bind = "urn:ietf:params:xml:ns:xmpp-bind";
  const sm = "urn:xmpp:sm:3";
  const syncNamespace = "urn:test:browser-queue";
  const queueFull = "ERR_SM_QUEUE_FULL";
  const ackDebounce = 60_000;
  let authenticated = false;
  const messages = [];
  const peer = new ScriptedPeer((frame, remote) => {
    const root = readFrame(frame)[0];
    if (root.open === `{${framing}}open`) {
      remote.send(OPEN);
      remote.send(
        `<features xmlns="${STREAM}">${authenticated ? `<bind xmlns="${bind}"/><sm xmlns="${sm}"/>` : `<mechanisms xmlns="${sasl}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
      );
    } else if (root.open === `{${sasl}}auth`) {
      authenticated = true;
      remote.send(`<success xmlns="${sasl}"/>`);
    } else if (root.open === `{${content}}iq`) {
      remote.send(
        `<iq xmlns="${content}" type="result" id="${root.attributes["{}id"]}"><bind xmlns="${bind}"><jid>user@example.test/r</jid></bind></iq>`,
      );
    } else if (root.open === `{${sm}}enable`) {
      remote.send(`<enabled xmlns="${sm}"/>`);
    } else if (root.open === `{${syncNamespace}}sync`) {
      if (root.attributes["{}id"] === "release") {
        remote.send(`<a xmlns="${sm}" h="1"/>`);
      } else if (root.attributes["{}id"] === "final") {
        remote.send(`<a xmlns="${sm}" h="2"/>`);
      }
      remote.send(frame);
    } else if (root.open === `{${content}}message`) {
      messages.push(root.attributes["{}id"]);
    } else if (frame === CLOSE) {
      remote.send(CLOSE);
    }
  });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ path: "dist/xmpp.min.js" });
    const result = await page.evaluate(
      async ({ service, content, sm, syncNamespace, ackDebounce, timeout }) => {
        const { client, xml } = globalThis.XMPP;
        const xmpp = client({
          service,
          domain: "example.test",
          username: "user",
          password: "secret",
          timeout,
          streamManagement: { maxStanzas: 1 },
        });
        xmpp.reconnect.stop();
        xmpp.streamManagement.requestAckInterval = 0;
        xmpp.streamManagement.requestAckDebounce = ackDebounce;
        const errors = [];
        const sent = [];
        const acks = [];
        const failures = [];
        const enabled = Promise.withResolvers();
        const barriers = new Map();
        xmpp.on("error", (error) => errors.push(error.message));
        xmpp.on("send", (element) => {
          if (element.is("message", content)) {
            sent.push(element.attrs.id);
          }
        });
        xmpp.streamManagement.on("ack", (element) =>
          acks.push(element.attrs.id),
        );
        xmpp.streamManagement.on("fail", (element) =>
          failures.push(element.attrs.id),
        );
        xmpp.on("nonza", (element) => {
          if (element.is("enabled", sm)) {
            enabled.resolve();
          } else if (element.is("sync", syncNamespace)) {
            barriers.get(element.attrs.id)?.();
          }
        });
        // FIFO round trips observe prior writes and settle prior peer ACKs.
        async function sync(id) {
          const observed = Promise.withResolvers();
          barriers.set(id, observed.resolve);
          const timer = setTimeout(
            () => observed.reject(new Error("Missing queue barrier")),
            timeout,
          );
          try {
            await xmpp.send(xml("sync", { xmlns: syncNamespace, id }));
            await observed.promise;
          } finally {
            clearTimeout(timer);
            barriers.delete(id);
          }
        }
        try {
          const address = String(await xmpp.start());
          await enabled.promise;
          await sync("ready");
          await xmpp.send(xml("message", { id: "first" }));
          let code = null;
          try {
            await xmpp.send(xml("message", { id: "overflow" }));
          } catch (error) {
            code = error.code;
          }
          await sync("blocked");
          const blocked = {
            code,
            status: xmpp.status,
            sent: [...sent],
            acks: [...acks],
            failures: [...failures],
          };
          await sync("release");
          await xmpp.send(xml("message", { id: "next" }));
          await sync("final");
          return {
            address,
            blocked,
            status: xmpp.status,
            sent,
            acks,
            failures,
            errors,
          };
        } finally {
          await xmpp.stop();
        }
      },
      {
        service: peer.url,
        content,
        sm,
        syncNamespace,
        ackDebounce,
        timeout: OBSERVATION_TIMEOUT_MS,
      },
    );
    expect(result).toEqual({
      address: "user@example.test/r",
      blocked: {
        code: queueFull,
        status: "online",
        sent: ["first"],
        acks: [],
        failures: [],
      },
      status: "online",
      sent: ["first", "next"],
      acks: ["first", "next"],
      failures: [],
      errors: [],
    });
    expect(messages).toEqual(["first", "next"]);
    expect(peer.errors).toEqual([]);
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

// XEP-0030 §§3–4/7 and XEP-0199 §5: exercise the shipped registry over Prosody.
test("Chromium bundled discovery queries Prosody and responds to routed client IQs", async () => {
  const infoNamespace = "http://jabber.org/protocol/disco#info";
  const itemsNamespace = "http://jabber.org/protocol/disco#items";
  const pingNamespace = "urn:xmpp:ping";
  const node = "commands";
  const nodeFeature = "urn:test:browser-disco-node";
  const identity = {
    category: "client",
    type: "web",
    name: "Browser fixture",
    lang: "en",
  };
  const nodeIdentity = { category: "automation", type: "command-list" };
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${origin.address().port}`);
    await page.addScriptTag({ path: "dist/xmpp.min.js" });
    const result = await page.evaluate(
      async ({
        infoNamespace,
        itemsNamespace,
        pingNamespace,
        node,
        nodeFeature,
        identity,
        nodeIdentity,
      }) => {
        const { client, xml } = globalThis.XMPP;
        const xmpp = client({
          service: "wss://[::1]:5281/xmpp-websocket",
          domain: "localhost",
          credentials: { username: "client", password: "foobar" },
          disco: { identities: [identity] },
        });
        const errors = [];
        xmpp.reconnect.stop();
        xmpp.on("error", (error) => errors.push(error.message));
        try {
          const address = String(await xmpp.start());
          xmpp.disco.setNode(node, {
            identities: [nodeIdentity],
            features: [nodeFeature],
          });
          xmpp.disco.setItems([{ jid: address, node, name: "Commands" }]);
          const serverInfo = await xmpp.disco.info("localhost");
          const serverItems = await xmpp.disco.items("localhost");
          // Full-JID requests go through Prosody back to this connected client.
          const ownInfo = await xmpp.disco.info(address);
          const ownItems = await xmpp.disco.items(address);
          const nodeInfo = await xmpp.disco.info(address, { node });
          const nodeItems = await xmpp.disco.items(address, { node });
          const ping = await xmpp.iqCaller.request(
            xml(
              "iq",
              { type: "get", to: address },
              xml("ping", { xmlns: pingNamespace }),
            ),
          );
          return {
            address,
            server: {
              identity: serverInfo.identities.some(
                (value) => value.category === "server",
              ),
              info: serverInfo.query.is("query", infoNamespace),
              items: serverItems.query.is("query", itemsNamespace),
              features: [infoNamespace, itemsNamespace].every((value) =>
                serverInfo.features.includes(value),
              ),
            },
            own: {
              identities: ownInfo.identities,
              features: ownInfo.features,
              items: ownItems.items,
            },
            node: {
              value: nodeInfo.node,
              wire: nodeInfo.query.attrs.node,
              identities: nodeInfo.identities,
              feature: nodeInfo.features.includes(nodeFeature),
              itemsNode: nodeItems.node,
              itemsWire: nodeItems.query.attrs.node,
              items: nodeItems.items,
            },
            ping: {
              type: ping.attrs.type,
              children: ping.getChildElements().length,
            },
            errors,
          };
        } finally {
          await xmpp.stop();
        }
      },
      {
        infoNamespace,
        itemsNamespace,
        pingNamespace,
        node,
        nodeFeature,
        identity,
        nodeIdentity,
      },
    );
    expect(result.address).toStartWith("client@localhost/");
    expect(result.server).toEqual({
      identity: true,
      info: true,
      items: true,
      features: true,
    });
    expect(result.own).toEqual({
      identities: [identity],
      features: [infoNamespace, itemsNamespace, pingNamespace],
      items: [{ jid: result.address, node, name: "Commands" }],
    });
    expect(result.node).toEqual({
      value: node,
      wire: node,
      identities: [nodeIdentity],
      feature: true,
      itemsNode: node,
      itemsWire: node,
      items: [],
    });
    expect(result.ping).toEqual({ type: "result", children: 0 });
    expect(result.errors).toEqual([]);
  } finally {
    await page.close();
  }
});

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
