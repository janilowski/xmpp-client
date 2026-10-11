import { test, expect } from "bun:test";
import { EventEmitter } from "../../events/index.js";
import xml from "../../xml/index.js";
import Connection from "../index.js";

const STREAM = "http://etherx.jabber.org/streams";
const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const CLIENT = "jabber:client";

// A replacement transport must not inherit an earlier transport's shutdown.
function attachSession(conn) {
  const socket = new EventEmitter();
  const parser = new EventEmitter();
  const writes = [];
  const ends = [];
  socket.write = (data, callback) => {
    writes.push(data);
    parser.emit("end", xml("close"));
    callback();
  };
  socket.end = () => {
    ends.push(true);
    socket.emit("close");
  };
  conn._attachSocket(socket);
  conn._attachParser(parser);
  conn.status = "online";
  conn.footerElement = () => xml("close");
  conn.on("error", () => {});
  return { socket, parser, writes, ends };
}

test("synchronous parser-error response cannot detach a replacement parser", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  const errors = [];
  conn.on("error", (error) => errors.push(error));
  let replacement;
  conn.once("disconnect", () => {
    replacement = attachSession(conn);
  });
  old.socket.write = (_data, callback) => {
    old.socket.emit("close");
    callback();
  };

  old.parser.emit("error", new Error("old parser failed"));
  await new Promise((resolve) => setImmediate(resolve));

  expect(conn.parser).toBe(replacement.parser);
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.status).toBe("online");
  expect(replacement.writes).toEqual([]);
  expect(replacement.ends).toEqual([]);
  expect(errors).toEqual([]);
});

test.each(["transport", "parser"])(
  "malformed feature error cannot poison a synchronous replacement %s",
  async (replacementKind) => {
    const conn = new Connection();
    conn.NS = CLIENT;
    const old = attachSession(conn);
    const errors = [];
    const elements = [];
    conn.on("error", (error) => errors.push(error));
    conn.on("element", (element) => elements.push(element));
    let replacement;
    old.socket.write = (data, callback) => {
      old.writes.push(data);
      if (replacementKind === "transport") {
        old.socket.emit("close");
        replacement = attachSession(conn);
      } else {
        const parser = new EventEmitter();
        conn._attachParser(parser);
        replacement = { socket: old.socket, parser };
      }
      callback();
    };

    // A synchronous write can replace either the transport or its parser.
    old.parser.emit(
      "element",
      xml("features", { xmlns: STREAM }, xml("future")),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(old.writes).toEqual([
      `<stream:error xmlns:stream="${STREAM}"><bad-format xmlns="${STREAM_ERRORS}"/></stream:error>`,
    ]);
    expect(conn.socket).toBe(replacement.socket);
    expect(conn.parser).toBe(replacement.parser);
    expect(conn.status).toBe("online");
    expect(old.ends).toEqual([]);
    if (replacementKind === "transport") {
      expect(replacement.writes).toEqual([]);
      expect(replacement.ends).toEqual([]);
    }
    expect(elements).toEqual([]);
    expect(errors).toEqual([]);
    const valid = xml(
      "features",
      { xmlns: STREAM },
      xml("future", { xmlns: "urn:test:future" }),
    );
    replacement.parser.emit("element", valid);
    expect(elements).toEqual([valid]);
  },
);

test("fatal feature errors preserve the parser for reciprocal close", async () => {
  const conn = new Connection({ timeout: 100 });
  conn.NS = CLIENT;
  const session = attachSession(conn);
  session.socket.write = (data, callback) => {
    session.writes.push(data);
    callback();
  };
  const errors = [];
  const elements = [];
  conn.on("error", (error) => errors.push(error));
  conn.on("element", (element) => elements.push(element));

  session.parser.emit(
    "element",
    xml("features", { xmlns: STREAM }, xml("future")),
  );
  session.parser.emit("element", xml("features", { xmlns: STREAM }));
  await new Promise((resolve) => setImmediate(resolve));

  expect(conn.parser).toBe(session.parser);
  expect(conn.status).toBe("closing");
  expect(session.ends).toEqual([]);
  expect(errors.map((error) => error.message)).toEqual([
    "Invalid stream feature namespace",
  ]);
  expect(elements).toEqual([]);
  expect(session.writes).toEqual([
    `<stream:error xmlns:stream="${STREAM}"><bad-format xmlns="${STREAM_ERRORS}"/></stream:error>`,
    "<close/>",
  ]);

  session.parser.emit("end", xml("close"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(session.ends).toEqual([true]);
  expect(conn.status).toBe("disconnect");
});

test.each(["open", "restart"])(
  "fatal feature errors reject synchronous %s before another opening",
  async (method) => {
    const conn = new Connection();
    conn.NS = CLIENT;
    const session = attachSession(conn);
    session.socket.write = (data, callback) => {
      session.writes.push(data);
      callback();
    };
    let attempt;
    conn.once("error", () => {
      attempt = conn[method]({ domain: "example.test" }).catch(
        (error) => error,
      );
    });

    session.parser.emit(
      "element",
      xml("features", { xmlns: STREAM }, xml("future")),
    );
    const result = await attempt;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Connection is closing");
    expect(conn.parser).toBe(session.parser);
    await new Promise((resolve) => setImmediate(resolve));
    expect(conn.status).toBe("closing");
    session.parser.emit("end", xml("close"));
    await new Promise((resolve) => setImmediate(resolve));
  },
);

test("old stream-close rejection cannot close a replacement transport", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  const written = Promise.withResolvers();
  old.socket.write = (_data, callback) => {
    callback();
    written.resolve();
  };
  const closing = conn.disconnect();
  await written.promise;
  old.socket.emit("close");
  const replacement = attachSession(conn);
  await closing;
  expect(replacement.ends).toEqual([]);
  expect(replacement.writes).toEqual([]);
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
});

test("delayed close hooks cannot write a footer to a replacement stream", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  conn.hook("close", async () => {
    entered.resolve();
    await release.promise;
  });
  const closing = conn.disconnect();
  await entered.promise;
  old.socket.emit("close");
  const replacement = attachSession(conn);
  release.resolve();
  await closing;
  expect(replacement.writes).toEqual([]);
  expect(replacement.ends).toEqual([]);
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
});

test("delayed peer-close reply cannot end a replacement transport", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  let completeWrite;
  old.socket.write = (_data, callback) => {
    completeWrite = callback;
  };
  old.parser.emit("end", xml("close"));
  old.socket.emit("close");
  const replacement = attachSession(conn);
  completeWrite();
  await new Promise((resolve) => setImmediate(resolve));
  expect(replacement.ends).toEqual([]);
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
});

test("old socket-close rejection cannot detach a replacement transport", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  conn.status = "connect";
  const ending = Promise.withResolvers();
  old.socket.end = () => ending.resolve();
  const closing = conn.disconnect();
  await ending.promise;
  old.socket.emit("error", new Error("old transport failed"));
  old.socket.emit("close");
  const replacement = attachSession(conn);
  await closing;
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
  expect(replacement.ends).toEqual([]);
});

test("old stop completion cannot mark a replacement connection offline", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  const written = Promise.withResolvers();
  old.socket.write = (_data, callback) => {
    callback();
    written.resolve();
  };
  const stopping = conn.stop();
  await written.promise;
  old.socket.emit("close");
  const replacement = attachSession(conn);
  await stopping;
  expect(conn.status).toBe("online");
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(replacement.ends).toEqual([]);
});

test("delayed peer-close reply cannot end a replacement stream on the same socket", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  let completeWrite;
  old.socket.write = (_data, callback) => {
    completeWrite = callback;
  };
  old.parser.emit("end", xml("close"));
  const parser = new EventEmitter();
  conn._attachParser(parser);
  conn.status = "online";
  completeWrite();
  await new Promise((resolve) => setImmediate(resolve));
  expect(old.ends).toEqual([]);
  expect(conn.socket).toBe(old.socket);
  expect(conn.parser).toBe(parser);
  expect(conn.status).toBe("online");
});

test("a disconnecting callback cannot redirect shutdown to a replacement socket", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  let replacement;
  conn.once("disconnecting", () => {
    old.socket.emit("close");
    replacement = attachSession(conn);
  });
  await conn._closeSocket();
  expect(replacement.ends).toEqual([]);
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
});

test("old stop cannot mark a later already-disconnected session offline", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  const written = Promise.withResolvers();
  old.socket.write = (_data, callback) => {
    callback();
    written.resolve();
  };
  const stopping = conn.stop();
  await written.promise;
  old.socket.emit("close");
  const replacement = attachSession(conn);
  replacement.socket.emit("close");
  await stopping;
  expect(conn.status).toBe("disconnect");
  expect(conn.socket).toBeNull();
  expect(conn.parser).toBeNull();
});

test("old stream-error send completion cannot close a replacement session", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  const sent = Promise.withResolvers();
  const release = Promise.withResolvers();
  conn.send = async () => {
    sent.resolve();
    await release.promise;
  };
  const failing = conn._streamError("not-well-formed");
  await sent.promise;
  old.socket.emit("close");
  const replacement = attachSession(conn);
  release.resolve();
  await failing;
  expect(replacement.writes).toEqual([]);
  expect(replacement.ends).toEqual([]);
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
});

for (const action of ["disconnect", "stop"]) {
  test(`same-session ${action} writes one footer and ends one transport`, async () => {
    const conn = new Connection();
    const { writes, ends } = attachSession(conn);
    const closed = await conn[action]();
    expect(closed?.name).toBe("close");
    expect(writes).toEqual(["<close/>"]);
    expect(ends).toEqual([true]);
    expect(conn.socket).toBeNull();
    expect(conn.parser).toBeNull();
    expect(conn.status).toBe(action === "stop" ? "offline" : "disconnect");
  });

  test(`sequential ${action} after completed shutdown remains harmless`, async () => {
    const conn = new Connection();
    const { writes, ends } = attachSession(conn);
    await conn[action]();
    await conn[action]();
    expect(writes).toEqual(["<close/>"]);
    expect(ends).toEqual([true]);
    expect(conn.socket).toBeNull();
    expect(conn.parser).toBeNull();
    expect(conn.status).toBe(action === "stop" ? "offline" : "disconnect");
  });

  test(`pending ${action} cannot close a replacement parser on the same socket`, async () => {
    const conn = new Connection();
    const { socket, writes, ends } = attachSession(conn);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    conn.hook("close", async () => {
      entered.resolve();
      await release.promise;
    });
    const closing = conn[action]();
    await entered.promise;
    conn._detachParser();
    const replacement = new EventEmitter();
    replacement.on("end", () => {});
    conn._attachParser(replacement);
    release.resolve();
    await closing;
    expect(writes).toEqual([]);
    expect(ends).toEqual([]);
    expect(conn.socket).toBe(socket);
    expect(conn.parser).toBe(replacement);
    expect(conn.status).toBe("online");
  });

  test(`${action} without an established transport remains resolved`, async () => {
    for (const absent of [null, undefined]) {
      const conn = new Connection();
      conn.socket = absent;
      await conn[action]();
      expect(conn.socket).toBeNull();
      expect(conn.parser).toBeNull();
      expect(conn.status).toBe(action === "stop" ? "offline" : "disconnect");
    }
  });
}

for (const actions of [
  ["disconnect", "disconnect"],
  ["stop", "stop"],
  ["disconnect", "stop"],
  ["stop", "disconnect"],
]) {
  test(`concurrent same-session ${actions.join("/")} settles without duplicate footer`, async () => {
    const conn = new Connection();
    const { writes, ends } = attachSession(conn);
    await Promise.all(actions.map((action) => conn[action]()));
    expect(writes).toEqual(["<close/>"]);
    expect(ends).toEqual([true]);
    expect(conn.socket).toBeNull();
    expect(conn.parser).toBeNull();
    expect(conn.status).toBe(
      actions.includes("stop") ? "offline" : "disconnect",
    );
  });
}

test("peer-initiated close still replies and ends the same transport", async () => {
  const conn = new Connection();
  const { socket, parser, writes, ends } = attachSession(conn);
  socket.write = (data, callback) => {
    writes.push(data);
    callback();
  };
  parser.emit("end", xml("close"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(writes).toEqual(["<close/>"]);
  expect(ends).toEqual([true]);
  expect(conn.socket).toBeNull();
  expect(conn.parser).toBeNull();
  expect(conn.status).toBe("disconnect");
});

test("synchronous stream-close reply cannot mark a replacement stream closing", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  let replacement;
  conn.once("close", () => {
    old.socket.emit("close");
    replacement = attachSession(conn);
  });

  await conn.disconnect();

  expect(conn.status).toBe("online");
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(replacement.writes).toEqual([]);
  expect(replacement.ends).toEqual([]);
});

test("synchronous peer-close footer cannot detach a replacement parser", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  let replacement;
  conn.once("disconnect", () => {
    replacement = attachSession(conn);
  });
  old.socket.write = (_data, callback) => {
    old.socket.emit("close");
    callback();
  };

  old.parser.emit("end", xml("close"));
  await new Promise((resolve) => setImmediate(resolve));

  expect(conn.parser).toBe(replacement.parser);
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.status).toBe("online");
  expect(replacement.writes).toEqual([]);
  expect(replacement.ends).toEqual([]);
});

test("replaced socket cannot detach a replacement transport", () => {
  const conn = new Connection();
  const old = attachSession(conn);
  const replacement = attachSession(conn);

  old.socket.emit("close");

  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
});

test("replaced parser cannot close the replacement stream", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  const parser = new EventEmitter();
  conn._attachParser(parser);
  old.socket.write = (data, callback) => {
    old.writes.push(data);
    callback();
  };

  old.parser.emit("end", xml("close"));
  await new Promise((resolve) => setImmediate(resolve));

  expect(conn.parser).toBe(parser);
  expect(conn.socket).toBe(old.socket);
  expect(conn.status).toBe("online");
  expect(old.writes).toEqual([]);
  expect(old.ends).toEqual([]);
});

test("a preceding old-socket listener cannot detach a replacement transport", () => {
  const conn = new Connection();
  const old = attachSession(conn);
  let replacement;
  old.socket.prependOnceListener("close", () => {
    replacement = attachSession(conn);
  });

  old.socket.emit("close");

  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
});

test("a preceding old-parser listener cannot close the replacement stream", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  let parser;
  old.parser.prependOnceListener("end", () => {
    parser = new EventEmitter();
    conn._attachParser(parser);
  });
  old.socket.write = (data, callback) => {
    old.writes.push(data);
    callback();
  };

  old.parser.emit("end", xml("close"));
  await new Promise((resolve) => setImmediate(resolve));

  expect(conn.parser).toBe(parser);
  expect(conn.socket).toBe(old.socket);
  expect(conn.status).toBe("online");
  expect(old.writes).toEqual([]);
  expect(old.ends).toEqual([]);
});

test("old close-hook rejection cannot emit an error into the replacement session", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  const errors = [];
  conn.on("error", (error) => errors.push(error));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  conn.hook("close", async () => {
    entered.resolve();
    await release.promise;
    throw new Error("old close hook failed");
  });
  const closing = conn.disconnect();
  await entered.promise;
  old.socket.emit("close");
  const replacement = attachSession(conn);
  release.resolve();

  await closing;

  expect(errors).toEqual([]);
  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
});

test("a received stream-error observer cannot redirect shutdown into a replacement session", async () => {
  const conn = new Connection();
  const old = attachSession(conn);
  let replacement;
  conn.once("error", () => {
    old.socket.emit("close");
    replacement = attachSession(conn);
  });

  old.parser.emit(
    "element",
    xml(
      "stream:error",
      { "xmlns:stream": "http://etherx.jabber.org/streams" },
      xml("not-well-formed", { xmlns: "urn:ietf:params:xml:ns:xmpp-streams" }),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));

  expect(conn.socket).toBe(replacement.socket);
  expect(conn.parser).toBe(replacement.parser);
  expect(conn.status).toBe("online");
  expect(replacement.writes).toEqual([]);
  expect(replacement.ends).toEqual([]);
});
