import { EventEmitter } from "../events/index.js";

const MAX_DELAY = 60_000;

class Reconnect extends EventEmitter {
  #active = false;
  #attempt = 0;
  #generation = 0;
  #running = null;
  constructor(entity) {
    super();

    this.delay = 1000;
    this.entity = entity;
    this._timeout = null;
  }

  #onDisconnect = () => {
    this.scheduleReconnect();
  };

  #onStatus = (status) => {
    if (status === "online") {
      this.#attempt = 0;
    }
  };

  #cancel = () => {
    this.#generation++;
    this.#attempt = 0;
    this.#running = null;
    clearTimeout(this._timeout);
    this._timeout = null;
  };

  scheduleReconnect() {
    if (!this.#active || this._timeout !== null || this.#running !== null) {
      return;
    }
    const { entity } = this;
    const generation = this.#generation;
    // RFC 6120 §3.3: equal jitter, exponential window, bounded at one minute.
    const window = Math.min(this.delay * 2 ** this.#attempt, MAX_DELAY);
    this._timeout = setTimeout(
      async () => {
        if (generation !== this.#generation) {
          return;
        }
        this._timeout = null;
        if (entity.status !== "disconnect") {
          return;
        }
        this.#attempt++;
        this.#running = generation;
        try {
          await this.reconnect();
        } catch {
          // Transport errors are already emitted; release a failed partial stream.
          if (generation === this.#generation) {
            await entity.disconnect();
          }
        } finally {
          if (generation === this.#generation) {
            this.#running = null;
            if (entity.status === "disconnect") {
              this.scheduleReconnect();
            }
          }
        }
      },
      window * (0.5 + Math.random() / 2),
    );
  }

  async reconnect() {
    const { entity } = this;
    const generation = this.#generation;
    this.emit("reconnecting");
    if (generation !== this.#generation) {
      return;
    }

    const { service, domain, lang } = entity.options;
    await entity.connect(service);
    if (generation !== this.#generation) {
      return;
    }
    await entity.open({ domain, lang });
    if (generation === this.#generation) {
      this.emit("reconnected");
    }
  }

  start() {
    if (this.#active) {
      return;
    }
    this.#active = true;
    const { entity } = this;
    entity.on("disconnect", this.#onDisconnect);
    entity.on("status", this.#onStatus);
    entity.on("offline", this.#cancel);
  }

  stop() {
    const { entity } = this;
    this.#active = false;
    entity.removeListener("disconnect", this.#onDisconnect);
    entity.removeListener("status", this.#onStatus);
    entity.removeListener("offline", this.#cancel);
    this.#cancel();
  }
}

export default function reconnect({ entity }) {
  const r = new Reconnect(entity);
  r.start();
  return r;
}
