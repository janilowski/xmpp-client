import { expect, test } from "bun:test";

import xml from "../../xml/index.js";
import Connection from "../index.js";

const STREAM_ERRORS = "urn:ietf:params:xml:ns:xmpp-streams";
const CROSS_HOST_REDIRECT_MESSAGE =
  "Cross-host stream redirects are not supported";
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

test.each(["ws", "wss"])(
  "cross-host %s redirect does not initiate a connection",
  async (scheme) => {
    const service = `${scheme}://edge.example.test:7443/xmpp?route=primary`;
    const connection = new Connection({ ...OPTIONS, service });
    connection.socket = { url: service };
    const services = [];
    const errors = [];
    connection.connect = async (target) => services.push(target);
    connection.open = async () => {};
    connection.on("error", (error) => errors.push(error));

    const redirecting = connection._onSeeOtherHost(
      streamError("example.test:7444"),
    );
    connection.emit("disconnect");
    await redirecting;

    expect(services).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe(CROSS_HOST_REDIRECT_MESSAGE);
  },
);

test.each([
  [
    "wss://[::1]:7443/xmpp?route=primary",
    "[0:0:0:0:0:0:0:1]:7444",
    "wss://[::1]:7444/xmpp?route=primary",
  ],
  [
    "wss://[2001:db8::1]:7443/xmpp?route=primary",
    "[2001:0db8:0:0:0:0:0:1]:7444",
    "wss://[2001:db8::1]:7444/xmpp?route=primary",
  ],
  [
    "wss://xn--bcher-kva.example:7443/xmpp?route=primary",
    "BÜCHER.EXAMPLE.:443",
    "wss://xn--bcher-kva.example/xmpp?route=primary",
  ],
  [
    "ws://example.test:7443/xmpp?route=primary",
    "EXAMPLE.TEST.:80",
    "ws://example.test/xmpp?route=primary",
  ],
])(
  "prepared same-host redirect preserves URL policy / %s",
  async (service, target, expected) => {
    const connection = new Connection({ ...OPTIONS, service });
    connection.socket = { url: service };
    const services = [];
    const openings = [];
    const errors = [];
    connection.connect = async (redirected) => services.push(redirected);
    connection.open = async (options) => openings.push(options);
    connection.on("error", (error) => errors.push(error));

    const redirecting = connection._onSeeOtherHost(streamError(target));
    connection.emit("disconnect");
    await redirecting;

    expect(errors).toEqual([]);
    expect(services).toEqual([expected]);
    expect(openings).toEqual([{ domain: OPTIONS.domain, lang: OPTIONS.lang }]);
  },
);
