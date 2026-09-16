import { EventEmitter, listeners } from "../../events/index.js";
import { parseURI } from "../../connection/lib/util.js";

const CODE = "ECONNERROR";
const SUBPROTOCOL = "xmpp";

export function isSecure(url) {
  const uri = parseURI(url);
  if (uri.protocol === "wss:") return true;
  if (["localhost", "127.0.0.1", "::1"].includes(uri.hostname)) return true;
  return false;
}

export default class Socket extends EventEmitter {
  #listeners = null;
  socket = null;
  url = null;
  secure = false;

  connect(url) {
    this.url = url;
    this.secure = isSecure(url);
    this._attachSocket(new WebSocket(url, [SUBPROTOCOL]));
  }

  _attachSocket(socket) {
    this.socket = socket;
    this.#listeners ??= listeners({
      open: () => {
        // RFC 7395 §3.1: an accepted WebSocket is not yet an XMPP transport.
        if (this.socket.protocol !== SUBPROTOCOL) {
          this.socket.close();
          this.emit(
            "error",
            new Error("WebSocket did not negotiate the xmpp subprotocol"),
          );
          return;
        }
        this.emit("connect");
      },
      message: ({ data }) => this.emit("data", data),
      error: (event) => {
        const { url } = this;
        // WS
        let { error } = event;
        // DOM
        if (!error) {
          error = new Error(event.message || `WebSocket ${CODE} ${url}`);
          error.errno = CODE;
          error.code = CODE;
        }

        error.event = event;
        error.url = url;
        this.emit("error", error);
      },
      close: (event) => {
        this._detachSocket();
        this.emit("close", !event.wasClean, event);
      },
    });
    this.#listeners.subscribe(this.socket);
  }

  _detachSocket() {
    this.url = null;
    this.secure = false;
    this.socket && this.#listeners?.unsubscribe(this.socket);
    this.socket = null;
  }

  end() {
    this.socket.close();
  }

  write(data, fn) {
    this.socket.send(data);
    Promise.resolve()
      .then(fn)
      .catch(() => {});
  }
}
