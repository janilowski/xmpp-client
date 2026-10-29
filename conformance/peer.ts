import { serve, type ServerWebSocket } from "bun";

const HTTP_BAD_REQUEST = 400;
const PEER_TIMEOUT = 2000;

// A server-side close callback is not a barrier for the client's close callback.
// Observe only: a missing disconnect becomes an assertion failure, not a repair.
export function waitForDisconnect(
  client: {
    readonly status: string;
    on(event: "disconnect", listener: () => void): unknown;
    off(event: "disconnect", listener: () => void): unknown;
  },
  timeout = PEER_TIMEOUT,
): Promise<boolean> {
  if (client.status === "disconnect") {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onDisconnect = () => {
      clearTimeout(timer);
      client.off("disconnect", onDisconnect);
      resolve(true);
    };
    const timer = setTimeout(() => {
      client.off("disconnect", onDisconnect);
      resolve(false);
    }, timeout);
    client.on("disconnect", onDisconnect);
  });
}

/** A wire peer, not an XMPP implementation: scripts supply literal responses. */
export class ScriptedPeer {
  readonly transcript: string[] = [];
  readonly requests: Headers[] = [];
  readonly requestUrls: string[] = [];
  readonly errors: Error[] = [];
  private readonly server;
  private socket?: ServerWebSocket<undefined>;
  private queue: string[] = [];
  private waiter?: {
    resolve: (frame: string) => void;
    reject: (error: Error) => void;
  };
  private closed = false;
  private readonly terminal = Promise.withResolvers<void>();

  constructor(onMessage: (frame: string, peer: ScriptedPeer) => void) {
    this.server = serve<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        this.requests.push(request.headers);
        this.requestUrls.push(request.url);
        if (
          server.upgrade(request, {
            headers: { "Sec-WebSocket-Protocol": "xmpp" },
          })
        ) {
          return;
        }
        return new Response("Expected WebSocket upgrade", {
          status: HTTP_BAD_REQUEST,
        });
      },
      websocket: {
        open: (socket) => {
          this.socket = socket;
        },
        message: (_socket, data) => {
          // Preserve text/binary distinction instead of silently decoding bytes.
          const frame = typeof data === "string" ? data : "[binary]";
          this.transcript.push(frame);
          const waiter = this.waiter;
          this.waiter = undefined;
          if (waiter) {
            waiter.resolve(frame);
          } else {
            this.queue.push(frame);
          }
          try {
            onMessage(frame, this);
          } catch (error) {
            this.errors.push(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        },
        close: () => {
          this.closed = true;
          this.terminal.resolve();
          this.waiter?.reject(
            new Error(
              `Peer closed before the expected frame: ${this.transcript.join(" | ")}`,
            ),
          );
          this.waiter = undefined;
        },
      },
    });
  }

  get url() {
    return `ws://127.0.0.1:${this.server.port}/xmpp`;
  }

  send(frame: string | Uint8Array) {
    if (!this.socket || this.closed) {
      throw new Error("Peer is not connected");
    }
    this.socket.send(frame);
  }

  terminate() {
    this.socket?.terminate();
  }

  async waitForClose() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.terminal.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("WebSocket did not close")),
            PEER_TIMEOUT,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async next(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.closed) {
      throw new Error("Peer closed before the expected frame");
    }
    if (this.waiter) {
      throw new Error("Only one frame reader is allowed");
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        this.waiter = { resolve, reject };
        timer = setTimeout(
          () =>
            reject(
              new Error(`Missing peer frame: ${this.transcript.join(" | ")}`),
            ),
          PEER_TIMEOUT,
        );
      });
    } finally {
      clearTimeout(timer);
      this.waiter = undefined;
    }
  }

  async stop() {
    this.waiter?.reject(new Error("Peer stopped"));
    this.waiter = undefined;
    await this.server.stop(true);
  }
}
