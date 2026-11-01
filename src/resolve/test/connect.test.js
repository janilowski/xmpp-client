import { afterEach, expect, spyOn, test } from "bun:test";
import { client } from "../../client/index.js";
import { EventEmitter } from "node:events";

let fetchMock;
afterEach(() => fetchMock?.mockRestore());

test("discovery never downgrades to an insecure WebSocket endpoint", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="ws://example.test/xmpp"/></XRD>',
    ),
  );
  const xmpp = client({ service: "example.test" });
  xmpp.reconnect.stop();
  await expect(xmpp.connect("example.test")).rejects.toThrow(
    "No compatible secure transport found",
  );
  expect(xmpp.socket).toBe(null);
});

test("discovery disposes failed attempts and preserves their causes", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://one.test/xmpp"/><Link rel="urn:xmpp:alt-connections:websocket" href="wss://two.test/xmpp"/></XRD>',
    ),
  );
  const attempts = [];
  class Socket extends EventEmitter {
    connect(uri) {
      this.uri = uri;
      attempts.push(this);
      queueMicrotask(() => this.emit("error", new Error(uri)));
    }
    end() {
      this.ended = true;
      this.emit("close");
    }
  }
  class Transport {}
  Transport.prototype.Socket = Socket;
  Transport.prototype.socketParameters = (uri) => uri;
  const xmpp = client({ service: "example.test" });
  xmpp.reconnect.stop();
  xmpp.on("error", () => {});
  xmpp._findTransport = () => Transport;
  const result = await xmpp.connect("example.test").catch((error) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors.map((error) => error.message)).toEqual([
    "wss://one.test/xmpp",
    "wss://two.test/xmpp",
  ]);
  expect(attempts.map((socket) => socket.ended)).toEqual([true, true]);
  expect(attempts.map((socket) => socket.eventNames())).toEqual([[], []]);
  expect(xmpp.socket).toBe(null);
});

const DOCUMENT =
  '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://discovered.test/xmpp"/></XRD>';
const OBSERVATION_MS = 50;

// A noncooperative fetch cannot retain authority after public cancellation.
for (const method of ["stop", "disconnect"]) {
  test(`discovery ${method} settles before ignored fetch abort and permits recovery`, async () => {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    let signal;
    fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      (_url, options) => {
        signal = options.signal;
        entered.resolve();
        return released.promise;
      },
    );
    const attempts = [];
    class Socket extends EventEmitter {
      connect(uri) {
        attempts.push(uri);
        queueMicrotask(() => this.emit("connect"));
      }
      end() {
        this.emit("close");
      }
    }
    class Transport {}
    Transport.prototype.Socket = Socket;
    Transport.prototype.socketParameters = (uri) => uri;
    const xmpp = client({ service: "example.test" });
    xmpp.reconnect.stop();
    xmpp._findTransport = () => Transport;
    const pending = xmpp.connect("example.test").then(
      () => "connected",
      (error) => error,
    );
    try {
      await entered.promise;
      await xmpp[method]();
      let timer;
      const result = await Promise.race([
        pending,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("pending"), OBSERVATION_MS);
        }),
      ]);
      clearTimeout(timer);
      expect(result).toBeInstanceOf(Error);
      expect(result.name).toBe("AbortError");
      expect(signal.aborted).toBe(true);
      released.resolve(new Response(DOCUMENT));
      await pending;
      await xmpp.connect("wss://fresh.test/xmpp");
      expect(attempts).toEqual(["wss://fresh.test/xmpp"]);
    } finally {
      released.resolve(new Response(DOCUMENT));
      await pending;
      await xmpp.stop();
    }
  });
}

test("a direct replacement retires pending discovery without old fallback cleanup", async () => {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(() => {
    entered.resolve();
    return released.promise;
  });
  const attempts = [];
  const ended = [];
  class Socket extends EventEmitter {
    connect(uri) {
      this.uri = uri;
      attempts.push(uri);
      queueMicrotask(() => this.emit("connect"));
    }
    end() {
      ended.push(this.uri);
      this.emit("close");
    }
  }
  class Transport {}
  Transport.prototype.Socket = Socket;
  Transport.prototype.socketParameters = (uri) => uri;
  const xmpp = client({ service: "example.test" });
  xmpp.reconnect.stop();
  xmpp._findTransport = () => Transport;
  const stale = xmpp.connect("example.test").then(
    () => "connected",
    (error) => error,
  );
  try {
    await entered.promise;
    await xmpp.connect("wss://replacement.test/xmpp");
    const retained = xmpp.socket;
    released.resolve(new Response(DOCUMENT));
    const result = await stale;
    expect(result).toBeInstanceOf(Error);
    expect(result.name).toBe("AbortError");
    expect(attempts).toEqual(["wss://replacement.test/xmpp"]);
    expect(ended).toEqual([]);
    expect(xmpp.socket).toBe(retained);
    expect(xmpp.status).toBe("connect");
  } finally {
    released.resolve(new Response(DOCUMENT));
    await stale;
    await xmpp.stop();
  }
});

test("a reentrant replacement survives the old discovered endpoint's failure", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(DOCUMENT),
  );
  const attempts = [];
  const ended = [];
  class Socket extends EventEmitter {
    connect(uri) {
      this.uri = uri;
      attempts.push(uri);
      queueMicrotask(() =>
        uri.includes("discovered")
          ? this.emit("error", new Error("Old endpoint failed"))
          : this.emit("connect"),
      );
    }
    end() {
      ended.push(this.uri);
      this.emit("close");
    }
  }
  class Transport {}
  Transport.prototype.Socket = Socket;
  Transport.prototype.socketParameters = (uri) => uri;
  const xmpp = client({ service: "example.test" });
  xmpp.reconnect.stop();
  xmpp._findTransport = () => Transport;
  let replacement;
  xmpp.once("error", () => {
    replacement = xmpp.connect("wss://replacement.test/xmpp");
  });
  try {
    const result = await xmpp.connect("example.test").catch((error) => error);
    await replacement;
    expect(result.name).toBe("AbortError");
    expect(attempts).toEqual([
      "wss://discovered.test/xmpp",
      "wss://replacement.test/xmpp",
    ]);
    expect(ended).not.toContain("wss://replacement.test/xmpp");
    expect(xmpp.socket.uri).toBe("wss://replacement.test/xmpp");
    expect(xmpp.status).toBe("connect");
  } finally {
    await xmpp.stop();
  }
});

test("newer discovery retires ignored older metadata before endpoint contact", async () => {
  const old = Promise.withResolvers();
  const entered = Promise.withResolvers();
  fetchMock = spyOn(globalThis, "fetch").mockImplementation((url) => {
    if (url.includes("older.test")) {
      entered.resolve();
      return old.promise;
    }
    return Promise.resolve(new Response(DOCUMENT));
  });
  const attempts = [];
  class Socket extends EventEmitter {
    connect(uri) {
      attempts.push(uri);
      queueMicrotask(() => this.emit("connect"));
    }
    end() {
      this.emit("close");
    }
  }
  class Transport {}
  Transport.prototype.Socket = Socket;
  Transport.prototype.socketParameters = (uri) => uri;
  const xmpp = client({ service: "older.test" });
  xmpp.reconnect.stop();
  xmpp._findTransport = () => Transport;
  const stale = xmpp.connect("older.test").catch((error) => error);
  try {
    await entered.promise;
    await xmpp.connect("newer.test");
    old.resolve(
      new Response(DOCUMENT.replace("discovered.test", "stale.test")),
    );
    expect((await stale).name).toBe("AbortError");
    expect(attempts).toEqual(["wss://discovered.test/xmpp"]);
    expect(xmpp.status).toBe("connect");
  } finally {
    old.resolve(new Response(DOCUMENT));
    await stale;
    await xmpp.stop();
  }
});

for (const action of ["connect", "disconnect", "stop"]) {
  test(`synchronous discovery abort reentry keeps newer transport during ${action}`, async () => {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    const attempts = [];
    const ended = [];
    class Socket extends EventEmitter {
      connect(uri) {
        this.uri = uri;
        attempts.push(uri);
        queueMicrotask(() => this.emit("connect"));
      }
      end() {
        ended.push(this.uri);
        this.emit("close");
      }
    }
    class Transport {}
    Transport.prototype.Socket = Socket;
    Transport.prototype.socketParameters = (uri) => uri;
    const xmpp = client({ service: "example.test" });
    xmpp.reconnect.stop();
    xmpp._findTransport = () => Transport;
    let newest;
    fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      (_url, { signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            newest = xmpp.connect("wss://newest.test/xmpp");
          },
          { once: true },
        );
        entered.resolve();
        return released.promise;
      },
    );
    const stale = xmpp.connect("example.test").catch((error) => error);
    try {
      await entered.promise;
      const interrupted = await (
        action === "connect"
          ? xmpp.connect("wss://interrupted.test/xmpp")
          : xmpp[action]()
      ).catch((error) => error);
      await newest;
      await new Promise((resolve) => setImmediate(resolve));
      expect((await stale).name).toBe("AbortError");
      if (action === "connect") {
        expect(interrupted?.name).toBe("AbortError");
      }
      expect(attempts).toEqual(["wss://newest.test/xmpp"]);
      expect(ended).not.toContain("wss://newest.test/xmpp");
      expect(xmpp.socket?.uri).toBe("wss://newest.test/xmpp");
      expect(xmpp.status).toBe("connect");
    } finally {
      released.resolve(new Response(DOCUMENT));
      await stale;
      await newest?.catch(() => {});
      await xmpp.stop();
    }
  });
}
