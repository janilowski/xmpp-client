import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import debug from "./index.js";
import xml from "../xml/index.js";

// Local security policy for explicitly enabled debug output. These markers are
// fake credentials; malformed/duplicate children must not bypass redaction.
const NS_SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const NS_SASL2 = "urn:xmpp:sasl:2";
const NS_FAST = "urn:xmpp:fast:0";
const FOREIGN = "urn:example:debug-metadata";
const CASES = [
  {
    name: "SASL2 initial-response",
    create: () =>
      xml(
        "s:authenticate",
        { "xmlns:s": NS_SASL2, mechanism: "PLAIN" },
        xml(
          "initial-response",
          { xmlns: FOREIGN },
          "visible foreign initial response",
        ),
        xml("s:initial-response", {}, "fake-private-initial-one"),
        xml("s:initial-response", {}, "fake-private-initial-two"),
      ),
    secrets: ["fake-private-initial-one", "fake-private-initial-two"],
    visible: ["visible foreign initial response", 'mechanism="PLAIN"'],
    hidden: 2,
  },
  {
    name: "SASL2 additional-data",
    create: () =>
      xml(
        "s:success",
        { "xmlns:s": NS_SASL2 },
        xml(
          "additional-data",
          { xmlns: FOREIGN },
          "visible foreign additional data",
        ),
        xml("s:additional-data", {}, "fake-private-additional-one"),
        xml("s:additional-data", {}, "fake-private-additional-two"),
      ),
    secrets: ["fake-private-additional-one", "fake-private-additional-two"],
    visible: ["visible foreign additional data"],
    hidden: 2,
  },
  {
    name: "FAST tokens",
    create: () =>
      xml(
        "s:success",
        { "xmlns:s": NS_SASL2, "xmlns:f": NS_FAST },
        xml("f:token", {
          token: "fake-private-token-one",
          expiry: "2099-01-01T00:00:00Z",
        }),
        xml(
          "token",
          { xmlns: FOREIGN, token: "visible-foreign-token" },
          "visible foreign token data",
        ),
        xml("f:token", {
          token: "fake-private-token-two",
          expiry: "2099-02-01T00:00:00Z",
        }),
      ),
    secrets: ["fake-private-token-one", "fake-private-token-two"],
    visible: [
      "visible-foreign-token",
      "visible foreign token data",
      'expiry="2099-01-01T00:00:00Z"',
      'expiry="2099-02-01T00:00:00Z"',
    ],
    hidden: 0,
  },
  {
    name: "classic SASL",
    create: () =>
      xml(
        "auth",
        { xmlns: NS_SASL, mechanism: "PLAIN" },
        "fake-private-classic-response",
      ),
    secrets: ["fake-private-classic-response"],
    visible: ['mechanism="PLAIN"'],
    hidden: 1,
  },
] as const;

for (const event of ["element", "send"] as const) {
  for (const scenario of CASES) {
    test(`opt-in debug ${event}: redact ${scenario.name}, preserve metadata and input`, () => {
      const entity = new EventEmitter();
      const output = spyOn(console, "debug").mockImplementation(() => {});
      const element = scenario.create();
      const original = element.toString();
      try {
        debug(entity, true);
        entity.emit(event, element);
        expect(output).toHaveBeenCalledTimes(1);
        const message = output.mock.calls[0][0];
        expect(typeof message).toBe("string");
        expect(message.startsWith(event === "element" ? "IN\n" : "OUT\n")).toBe(
          true,
        );
        for (const secret of scenario.secrets) {
          expect(original).toContain(secret);
          expect(message).not.toContain(secret);
        }
        for (const visible of scenario.visible) {
          expect(message).toContain(visible);
        }
        expect(
          [...message.matchAll(/<hidden xmlns="xmpp-client"\s*\/>/g)].length,
        ).toBe(scenario.hidden);
        if (scenario.name === "FAST tokens") {
          expect(
            [...message.matchAll(/token="hidden by xmpp-client"/g)].length,
          ).toBe(2);
        }
        expect(element.toString()).toBe(original);
      } finally {
        output.mockRestore();
        entity.removeAllListeners();
      }
    });
  }
}

test("debug stays disabled unless explicitly enabled", () => {
  const entity = new EventEmitter();
  const output = spyOn(console, "debug").mockImplementation(() => {});
  const previous = process.env.XMPP_DEBUG;
  delete process.env.XMPP_DEBUG;
  try {
    debug(entity);
    entity.emit(
      "send",
      xml("auth", { xmlns: NS_SASL }, "fake-disabled-marker"),
    );
    expect(output).not.toHaveBeenCalled();
    expect(entity.listenerCount("send")).toBe(0);
  } finally {
    output.mockRestore();
    entity.removeAllListeners();
    if (previous === undefined) {
      delete process.env.XMPP_DEBUG;
    } else {
      process.env.XMPP_DEBUG = previous;
    }
  }
});
