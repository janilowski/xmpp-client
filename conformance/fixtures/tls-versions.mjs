import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createInterface } from "node:readline";
import { connect } from "node:tls";

if (process.versions.bun) {
  throw new Error(
    "TLS version fixture requires native Node; set XMPP_TEST_NODE=/usr/bin/node",
  );
}

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const PROBE_TIMEOUT_MS = 5000;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WEBSOCKET_CLOSE = 8;
const [directory, minVersion, maxVersion] = process.argv.slice(2);
const [key, cert, ca] = await Promise.all(
  ["key.pem", "leaf.pem", "ca.pem"].map((name) =>
    readFile(`${directory}/${name}`),
  ),
);
// Static RSA avoids Fedora's separate SHA-1 signature prohibition. We relax
// only this deliberately legacy-capable peer/probe, never the tested client.
const ciphers =
  minVersion === maxVersion && ["TLSv1", "TLSv1.1"].includes(minVersion)
    ? "AES128-SHA:@SECLEVEL=0"
    : undefined;
const records = { sessions: [], requests: [], upgrades: [], errors: [] };
const sockets = new Set();
const server = createServer(
  { key, cert, minVersion, maxVersion, ciphers },
  (request, response) => {
    records.requests.push({
      path: request.url,
      protocol: request.socket.getProtocol(),
    });
    if (request.url === "/probe") {
      response.writeHead(HTTP_OK);
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
    });
    response.end(
      `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://localhost:${server.address().port}/xmpp"/></XRD>`,
    );
  },
);
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.on("secureConnection", (socket) =>
  records.sessions.push(socket.getProtocol()),
);
server.on("tlsClientError", (error) => records.errors.push(error.code));
server.on("upgrade", (request, socket) => {
  records.upgrades.push({
    path: request.url,
    protocol: request.socket.getProtocol(),
    subprotocol: request.headers["sec-websocket-protocol"],
  });
  const accept = createHash("sha1")
    .update(request.headers["sec-websocket-key"] + WEBSOCKET_GUID)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: xmpp\r\n\r\n`,
  );
  socket.on("data", (data) => {
    // The client connects without opening XMPP, then closes the WebSocket.
    if ((data[0] & 0x0f) === WEBSOCKET_CLOSE) {
      socket.end(Buffer.from([0x88, 0]));
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// Complete an authenticated HTTP exchange, not only a client-side TLS event:
// TLS 1.3's server secureConnection can occur after the client's callback.
const probe = await new Promise((resolve) => {
  let result;
  let response = "";
  const socket = connect(
    {
      host: "localhost",
      port,
      servername: "localhost",
      ca,
      minVersion,
      maxVersion,
      ciphers,
      rejectUnauthorized: true,
    },
    () => {
      result = {
        accepted: true,
        protocol: socket.getProtocol(),
        authorized: socket.authorized,
        authorizationError: socket.authorizationError,
      };
      socket.write(
        "GET /probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
    },
  );
  socket.setTimeout(PROBE_TIMEOUT_MS, () =>
    socket.destroy(new Error("Native TLS capability probe timed out")),
  );
  socket.on("data", (data) => (response += data.toString("utf8")));
  socket.on("end", () =>
    resolve({ ...result, receivedHTTP: response.startsWith("HTTP/1.1 200") }),
  );
  socket.on("error", (error) =>
    resolve({ accepted: false, code: error.code, message: error.message }),
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
    await new Promise((resolve) => server.close(resolve));
    break;
  }
}
