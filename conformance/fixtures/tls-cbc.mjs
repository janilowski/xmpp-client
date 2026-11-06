import assert from "node:assert/strict";
import { constants, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createConnection, createServer as createTCPServer } from "node:net";
import { createInterface } from "node:readline";
import { connect } from "node:tls";
import { pathToFileURL } from "node:url";
import { ClientHello } from "./client-hello.mjs";

const TLS_HANDSHAKE = 22;
const TLS_ALERT = 21;
const SERVER_HELLO = 2;
const RECORD_HEADER_BYTES = 5;
const HANDSHAKE_HEADER_BYTES = 4;
const MAX_RECORD_BYTES = 16384;
const MAX_HELLO_BYTES = 65536;
const SOCKET_TIMEOUT_MS = 5000;
const MAX_CONNECTIONS = 8;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const WEBSOCKET_CLOSE = 8;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Initial plaintext ServerHello only: independent wire evidence of EtM, not
// a TLS implementation. Record/handshake fragmentation is explicitly bounded.
export class ServerHello {
  #records = Buffer.alloc(0);
  #handshake = Buffer.alloc(0);

  feed(chunk) {
    this.#records = Buffer.concat([this.#records, chunk]);
    while (this.#records.length >= RECORD_HEADER_BYTES) {
      assert.equal(this.#records[0], TLS_HANDSHAKE);
      const length = this.#records.readUInt16BE(3);
      assert.ok(length > 0 && length <= MAX_RECORD_BYTES);
      if (this.#records.length < RECORD_HEADER_BYTES + length) {
        return;
      }
      this.#handshake = Buffer.concat([
        this.#handshake,
        this.#records.subarray(
          RECORD_HEADER_BYTES,
          RECORD_HEADER_BYTES + length,
        ),
      ]);
      this.#records = this.#records.subarray(RECORD_HEADER_BYTES + length);
      if (this.#handshake.length < HANDSHAKE_HEADER_BYTES) {
        continue;
      }
      assert.equal(this.#handshake[0], SERVER_HELLO);
      const size = this.#handshake.readUIntBE(1, 3);
      assert.ok(size <= MAX_HELLO_BYTES);
      if (this.#handshake.length < HANDSHAKE_HEADER_BYTES + size) {
        continue;
      }
      const source = this.#handshake.subarray(
        HANDSHAKE_HEADER_BYTES,
        HANDSHAKE_HEADER_BYTES + size,
      );
      let offset = 0;
      const take = (size) => {
        assert.ok(offset + size <= source.length, "Truncated ServerHello");
        const bytes = source.subarray(offset, offset + size);
        offset += size;
        return bytes;
      };
      const version = take(2).toString("hex");
      take(32);
      const sessionLength = take(1)[0];
      assert.ok(sessionLength <= 32);
      take(sessionLength);
      const cipher = take(2).toString("hex");
      const compression = take(1)[0];
      const extensions = [];
      if (offset < source.length) {
        const extensionLength = take(2).readUInt16BE(0);
        assert.equal(
          extensionLength,
          source.length - offset,
          "Invalid extensions length",
        );
        while (offset < source.length) {
          const type = take(2).readUInt16BE(0);
          const size = take(2).readUInt16BE(0);
          extensions.push({ type, value: take(size).toString("hex") });
        }
      }
      return { version, cipher, compression, extensions };
    }
  }
}

async function run() {
  assert.equal(
    process.versions.bun,
    undefined,
    "CBC fixture requires native Node",
  );
  const [directory, protocol, cipher] = process.argv.slice(2);
  assert.ok(["TLSv1.2", "TLSv1.3"].includes(protocol));
  assert.ok(
    [
      "ECDHE-RSA-AES128-SHA256",
      "ECDHE-RSA-AES128-GCM-SHA256",
      "ECDHE-RSA-AES256-GCM-SHA384",
      "TLS_AES_128_GCM_SHA256",
    ].includes(cipher),
  );
  const [key, cert, ca] = await Promise.all(
    ["key.pem", "leaf.pem", "ca.pem"].map((name) =>
      readFile(`${directory}/${name}`),
    ),
  );
  const records = {
    connections: [],
    sessions: [],
    requests: [],
    upgrades: [],
    errors: [],
    observerErrors: [],
  };
  const sockets = new Set();
  const upstreamConnections = new Map();
  let proxy;
  const server = createServer(
    {
      key,
      cert,
      minVersion: protocol,
      maxVersion: protocol,
      ciphers: cipher,
      ecdhCurve: "X25519",
      secureOptions: constants.SSL_OP_NO_TICKET,
    },
    (request, response) => {
      const id = upstreamConnections.get(request.socket.remotePort)?.id;
      assert.ok(id);
      records.requests.push({ id, path: request.url });
      if (request.url === "/probe") {
        response.writeHead(HTTP_OK, { Connection: "close" });
        response.end("probe");
        return;
      }
      if (request.url !== "/.well-known/host-meta") {
        response.writeHead(HTTP_NOT_FOUND);
        response.end();
        return;
      }
      response.writeHead(HTTP_OK, {
        "Content-Type": "application/xrd+xml",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      response.end(
        `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://localhost:${proxy.address().port}/xmpp"/></XRD>`,
      );
    },
  );
  server.on("secureConnection", (socket) => {
    const connection = upstreamConnections.get(socket.remotePort);
    assert.ok(connection);
    records.sessions.push({
      id: connection.id,
      protocol: socket.getProtocol(),
      cipher: socket.getCipher().standardName,
      reused: socket.isSessionReused(),
    });
  });
  // Keep every observed handshake fresh, including TLS 1.3 stateful tickets.
  server.on("newSession", (_id, _data, callback) => callback());
  server.on("resumeSession", (_id, callback) => callback(null, null));
  server.on("tlsClientError", (error) => records.errors.push(error.code));
  server.on("upgrade", (request, socket) => {
    const id = upstreamConnections.get(socket.remotePort)?.id;
    assert.ok(id);
    records.upgrades.push({
      id,
      path: request.url,
      subprotocol: request.headers["sec-websocket-protocol"],
    });
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + WEBSOCKET_GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: xmpp\r\n\r\n`,
    );
    socket.on("data", (data) => {
      // The tested workflow connects without opening XML, then closes WS.
      if ((data[0] & 15) === WEBSOCKET_CLOSE) {
        socket.end(Buffer.from([0x88, 0]));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = createTCPServer((client) => {
    assert.ok(records.connections.length < MAX_CONNECTIONS);
    const connection = {
      id: records.connections.length + 1,
      clientHello: null,
      serverHello: null,
      errors: [],
    };
    records.connections.push(connection);
    const upstream = createConnection({
      host: "127.0.0.1",
      port: server.address().port,
    });
    const clientHello = new ClientHello();
    const serverHello = new ServerHello();
    upstream.on("connect", () =>
      upstreamConnections.set(upstream.localPort, connection),
    );
    for (const [socket, target, reader, field] of [
      [client, upstream, clientHello, "clientHello"],
      [upstream, client, serverHello, "serverHello"],
    ]) {
      let started = false;
      let observing = true;
      sockets.add(socket);
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
        records.observerErrors.push("CBC peer socket timed out");
        socket.destroy();
      });
      socket.on("data", (chunk) => {
        if (!observing || connection[field]) {
          return;
        }
        try {
          // An initial fatal alert is valid refusal. Once a fragmented hello
          // starts, every later chunk belongs to the bounded reader.
          if (
            !started &&
            field === "serverHello" &&
            chunk[0] !== TLS_HANDSHAKE
          ) {
            assert.equal(chunk[0], TLS_ALERT);
            observing = false;
            return;
          }
          started = true;
          connection[field] = reader.feed(chunk) ?? null;
        } catch (error) {
          records.observerErrors.push(error.message);
          socket.destroy();
        }
      });
      socket.on("error", (error) => {
        connection.errors.push(error.code);
        target.destroy();
      });
      socket.on("close", () => {
        sockets.delete(socket);
        target.destroy();
      });
      socket.pipe(target);
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = proxy.address().port;
  // Independent native control proves authenticated capability and EtM use
  // before any library behavior assertion can fail.
  const probe = await new Promise((resolve) => {
    let result;
    let response = "";
    const socket = connect(
      {
        host: "localhost",
        port,
        servername: "localhost",
        ca,
        rejectUnauthorized: true,
        minVersion: protocol,
        maxVersion: protocol,
        ciphers: cipher,
        ecdhCurve: "X25519",
      },
      () => {
        result = {
          accepted: true,
          authorized: socket.authorized,
          protocol: socket.getProtocol(),
          cipher: socket.getCipher().standardName,
          key: socket.getEphemeralKeyInfo(),
          reused: socket.isSessionReused(),
        };
        socket.write(
          "GET /probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
      },
    );
    socket.setTimeout(SOCKET_TIMEOUT_MS, () =>
      socket.destroy(new Error("Native CBC capability timeout")),
    );
    socket.on("data", (data) => {
      response += data.toString();
    });
    socket.on("end", () =>
      resolve({ ...result, receivedHTTP: response.startsWith("HTTP/1.1 200") }),
    );
    socket.on("error", (error) =>
      resolve({ accepted: false, code: error.code }),
    );
  });
  console.log(
    JSON.stringify({
      type: "ready",
      node: process.version,
      port,
      probe,
      records,
    }),
  );
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === "snapshot") {
      console.log(JSON.stringify({ type: "snapshot", records }));
    } else if (line === "stop") {
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => server.close(resolve)),
      ]);
      break;
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await run();
}
