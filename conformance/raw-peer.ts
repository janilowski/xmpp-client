import { createServer, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { once } from "node:events";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HTTP_SWITCHING_PROTOCOLS = 101;

/** Minimal adversarial transport: bypass platform validation of server frames. */
export class RawPeer {
  private readonly sockets = new Set<Socket>();
  private readonly server;
  readonly requests: string[] = [];

  constructor(protocol: string | null, frames: Uint8Array[] = []) {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => this.sockets.delete(socket));
      let header = "";
      const handshake = (chunk: Buffer) => {
        header += chunk.toString();
        if (!header.includes("\r\n\r\n")) {
          return;
        }
        socket.off("data", handshake);
        this.requests.push(header);
        const key = /^Sec-WebSocket-Key: (.+)\r?$/im.exec(header)?.[1].trim();
        if (!key) {
          socket.destroy();
          return;
        }
        const accept = createHash("sha1")
          .update(key + WS_GUID)
          .digest("base64");
        socket.write(
          [
            `HTTP/1.1 ${HTTP_SWITCHING_PROTOCOLS} Switching Protocols`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            ...(protocol === null
              ? []
              : [`Sec-WebSocket-Protocol: ${protocol}`]),
            "",
            "",
          ].join("\r\n"),
        );
        for (const frame of frames) {
          socket.write(frame);
        }
        // Echo the close frame is unnecessary: tests close the owned sockets.
      };
      socket.on("data", handshake);
    });
  }

  async listen() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    return this;
  }

  get url() {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Peer is not listening");
    }
    return `ws://127.0.0.1:${address.port}/xmpp`;
  }

  async stop() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
