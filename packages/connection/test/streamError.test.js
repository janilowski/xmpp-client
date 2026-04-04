import xml from "@xmpp/xml";

import Connection from "../index.js";

import { test, expect, spyOn } from "bun:test";
test("#_streamError", async () => {
  const conn = new Connection();

  const spy_disconnect = spyOn(conn, "disconnect");
  const spy_send = spyOn(conn, "send");

  await conn._streamError("foo-bar");

  expect(spy_disconnect).toHaveBeenCalled();

  expect(spy_send).toHaveBeenCalledWith(
    xml("stream:error", {}, [
      xml("foo-bar", { xmlns: "urn:ietf:params:xml:ns:xmpp-streams" }),
    ]),
  );
});
