import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createServer } from "node:tls";

if (process.versions.bun) {
  throw new Error("Secure renegotiation control requires native Node");
}
const directory = process.argv[2];
const records = { requested: false, finished: [], received: "", errors: [] };
const sockets = new Set();
const server = createServer(
  {
    key: await readFile(`${directory}/key.pem`),
    cert: await readFile(`${directory}/leaf.pem`),
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    ecdhCurve: "X25519",
    ciphers: "ECDHE-RSA-AES128-GCM-SHA256",
    sigalgs: "rsa_pss_rsae_sha256:rsa_pkcs1_sha256",
  },
  (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => {
      records.errors.push(error.message);
      socket.destroy();
    });
    socket.on("data", (data) => {
      records.received += data.toString();
      if (records.received === "PING") {
        records.finished.push(socket.getFinished().toString("hex"));
        socket.write("PONG");
        records.requested = socket.renegotiate(
          { requestCert: false, rejectUnauthorized: true },
          (error) => {
            if (error) {
              records.errors.push(error.message);
              socket.destroy();
              return;
            }
            records.finished.push(socket.getFinished().toString("hex"));
            socket.write("RENEWED");
          },
        );
      } else if (records.received === "PINGDONE") {
        socket.end("END");
      }
    });
  },
);
server.on("tlsClientError", (error) => records.errors.push(error.message));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(
  JSON.stringify({ port: server.address().port, node: process.version }),
);
for await (const line of createInterface({ input: process.stdin })) {
  if (line === "finish") {
    console.log(JSON.stringify(records));
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    break;
  }
}
