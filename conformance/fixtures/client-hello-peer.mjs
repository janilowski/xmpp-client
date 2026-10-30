import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { ClientHello } from "./client-hello.mjs";

const SOCKET_TIMEOUT_MS = 3000;
if (process.versions.bun) {
  throw new Error(
    "ClientHello observer requires native Node; set XMPP_TEST_NODE",
  );
}
const records = { hellos: [], errors: [] };
const sockets = new Set();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", (error) => records.errors.push(error.message));
  socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
    records.errors.push("ClientHello observation timed out");
    socket.destroy();
  });
  const reader = new ClientHello();
  const chunks = [];
  socket.on("data", (chunk) => {
    chunks.push(chunk);
    try {
      if (reader.feed(chunk)) {
        records.hellos.push(Buffer.concat(chunks).toString("base64"));
        // Stop before ServerHello: this observes offers, not TLS validation.
        socket.destroy();
      }
    } catch (error) {
      records.errors.push(error.message);
      socket.destroy();
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ type: "ready", port: server.address().port }));
for await (const line of createInterface({ input: process.stdin })) {
  if (line === "snapshot") {
    console.log(JSON.stringify({ type: "snapshot", ...records }));
  } else if (line === "stop") {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    break;
  }
}
