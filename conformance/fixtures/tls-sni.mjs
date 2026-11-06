import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { isIP } from "node:net";
import { createInterface } from "node:readline";
import { connect } from "node:tls";

assert.equal(process.versions.bun, undefined, "Native Node required");
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const PROBE_TIMEOUT_MS = 3000;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WEBSOCKET_CLOSE = 8;
const [directory, hostname] = process.argv.slice(2);
const address = hostname === "::1" ? "::1" : "127.0.0.1";
const authority = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
const expectedSNI = isIP(hostname)
  ? false
  : hostname.replace(/\.$/, "").toLowerCase();
const [key, cert, ca] = await Promise.all(
  ["key.pem", "leaf.pem", "ca.pem"].map((name) =>
    readFile(`${directory}/${name}`),
  ),
);
const records = { sessions: [], requests: [], upgrades: [], errors: [] };
const sockets = new Set();
const connection = (socket) => ({
  servername: socket.servername,
  protocol: socket.getProtocol(),
  reused: socket.isSessionReused(),
});
const server = createServer(
  {
    key,
    cert,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    secureOptions: constants.SSL_OP_NO_TICKET,
  },
  (request, response) => {
    records.requests.push({
      path: request.url,
      host: request.headers.host,
      ...connection(request.socket),
    });
    if (request.url === "/probe") {
      response.writeHead(HTTP_OK);
      response.end("authenticated");
      return;
    }
    if (request.url === "/.well-known/host-meta") {
      response.writeHead(HTTP_OK, {
        "Content-Type": "application/xrd+xml",
        "Cache-Control": "no-store",
      });
      response.end(
        `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://${authority}:${server.address().port}/xmpp?route=discovered%20value"/></XRD>`,
      );
      return;
    }
    response.writeHead(HTTP_NOT_FOUND);
    response.end();
  },
);
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.on("secureConnection", (socket) =>
  records.sessions.push(connection(socket)),
);
server.on("tlsClientError", (error) => records.errors.push(error.code));
// Stateful tickets have no retained state, so fresh handshakes expose actual SNI.
server.on("newSession", (_id, _data, callback) => callback());
server.on("resumeSession", (_id, callback) => callback(null, null));
server.on("upgrade", (request, socket) => {
  records.upgrades.push({
    path: request.url,
    host: request.headers.host,
    subprotocol: request.headers["sec-websocket-protocol"],
    ...connection(socket),
  });
  const accept = createHash("sha1")
    .update(request.headers["sec-websocket-key"] + WEBSOCKET_GUID)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: xmpp\r\n\r\n`,
  );
  socket.on("data", (data) => {
    if ((data[0] & 0x0f) === WEBSOCKET_CLOSE) {
      socket.end(Buffer.from([0x88, 0]));
    }
  });
});
await new Promise((resolve) => server.listen(0, address, resolve));
const port = server.address().port;

// Independent native control: authenticate the same endpoint and finish HTTP.
let probe;
if (hostname === "::1") {
  // Node 24.18's default hostname checker treats ::1 as DNS. OpenSSL's
  // independent IP verifier still requires the trusted chain and IP SAN.
  probe = await new Promise((resolve) => {
    let response = "";
    let errors = "";
    let inputError;
    const child = spawn(
      "openssl",
      [
        "s_client",
        "-connect",
        `[::1]:${port}`,
        "-CAfile",
        `${directory}/ca.pem`,
        "-verify_return_error",
        "-verify_ip",
        "::1",
        "-noservername",
        "-tls1_3",
        "-quiet",
        "-verify_quiet",
        "-ign_eof",
      ],
      { timeout: PROBE_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.on("data", (data) => (response += data.toString("utf8")));
    child.stderr.on("data", (data) => (errors += data.toString("utf8")));
    child.stdin.on("error", (error) => (inputError = error.message));
    child.on("error", (error) => (errors += error.message));
    child.on("close", (exit, signal) =>
      resolve({
        verifier: "OpenSSL",
        exit,
        signal,
        errors,
        receivedHTTP:
          response.startsWith("HTTP/1.1 200") &&
          response.includes("\r\n\r\n") &&
          response.includes("authenticated"),
        ...(inputError ? { inputError } : {}),
      }),
    );
    child.stdin.end(
      `GET /probe HTTP/1.1\r\nHost: ${authority}:${port}\r\nConnection: close\r\n\r\n`,
    );
  });
} else {
  probe = await new Promise((resolve) => {
    let result;
    let response = "";
    const socket = connect(
      {
        host: address,
        port,
        ca,
        servername: expectedSNI || undefined,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
      },
      () => {
        result = {
          accepted: true,
          authorized: socket.authorized,
          protocol: socket.getProtocol(),
          reused: socket.isSessionReused(),
        };
        socket.write(
          `GET /probe HTTP/1.1\r\nHost: ${authority}:${port}\r\nConnection: close\r\n\r\n`,
        );
      },
    );
    socket.setTimeout(PROBE_TIMEOUT_MS, () =>
      socket.destroy(new Error("Native SNI probe timed out")),
    );
    socket.on("data", (data) => (response += data.toString("utf8")));
    socket.on("end", () =>
      resolve({ ...result, receivedHTTP: response.startsWith("HTTP/1.1 200") }),
    );
    socket.on("error", (error) =>
      resolve({ accepted: false, code: error.code, message: error.message }),
    );
  });
}
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
    await new Promise((resolve) => server.close(resolve));
    break;
  }
}
