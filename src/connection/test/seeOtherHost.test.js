import { expect, test } from "bun:test";

import xml from "../../xml/index.js";
import Connection from "../index.js";

const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const OPTIONS = {
  domain: "example.test",
  lang: "pl",
  service: "wss://example.test:7443/xmpp?route=primary",
};

function streamError(target) {
  return {
    element: xml(
      "stream:error",
      {},
      xml("see-other-host", { xmlns: STREAM_ERRORS }, target),
    ),
  };
}

test("same-host redirect preserves WSS URL and explicit port 80", async () => {
  const connection = new Connection(OPTIONS);
  connection.socket = { url: OPTIONS.service };
  const services = [];
  const openings = [];
  connection.connect = async (service) => services.push(service);
  connection.open = async (options) => openings.push(options);

  const redirected = connection._onSeeOtherHost(streamError("example.test:80"));
  connection.emit("disconnect");
  await redirected;

  expect(services).toEqual(["wss://example.test:80/xmpp?route=primary"]);
  expect(openings).toEqual([{ domain: OPTIONS.domain, lang: OPTIONS.lang }]);
});

test("parallel stream errors start only one redirect", async () => {
  const connection = new Connection(OPTIONS);
  connection.socket = { url: OPTIONS.service };
  const services = [];
  const errors = [];
  connection.connect = async (service) => services.push(service);
  connection.open = async () => {};
  connection.on("error", (error) => errors.push(error));

  const first = connection._onSeeOtherHost(streamError("example.test:7444"));
  const second = connection._onSeeOtherHost(streamError("example.test:7445"));
  connection.emit("disconnect");
  await Promise.all([first, second]);

  expect(services).toEqual(["wss://example.test:7444/xmpp?route=primary"]);
  expect(errors).toEqual([]);
});
