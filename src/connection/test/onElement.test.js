import xml from "../../xml/index.js";
import { test, expect, spyOn } from "bun:test";

import Connection from "../index.js";

test("#_onElement", (done) => {
  expect.assertions(2);
  const foo = <foo />;
  const conn = new Connection();
  conn.on("element", (el) => {
    expect(el).toBe(foo);
  });
  conn.on("nonza", (el) => {
    expect(el).toBe(foo);
    done();
  });
  conn._onElement(foo);
});

test("#_onElement stream:error", (done) => {
  expect.assertions(7);
  // prettier-ignore

  const application = xml('application', {xmlns: 'urn:test:application'});

  const foo = xml("error", { xmlns: "http://etherx.jabber.org/streams" }, [
    xml("foo-bar", { xmlns: "urn:ietf:params:xml:ns:xmpp-streams" }),
    xml("text", { xmlns: "urn:ietf:params:xml:ns:xmpp-streams" }, "hello"),
    application,
  ]);
  const conn = new Connection();
  spyOn(conn, "disconnect").mockImplementation(() => {
    done();
    return Promise.resolve();
  });

  conn.on("element", (el) => {
    expect(el).toBe(foo);
  });
  conn.on("nonza", (el) => {
    expect(el).toBe(foo);
  });
  conn.on("error", (error) => {
    expect(error.name).toBe("StreamError");
    expect(error.condition).toBe("undefined-condition");
    expect(error.message).toBe("undefined-condition - hello");
    expect(error.application).toBe(application);
    expect(error.element).toBe(foo);
  });
  conn._onElement(foo);
});
