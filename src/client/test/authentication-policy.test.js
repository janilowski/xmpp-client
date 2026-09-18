import { afterEach, expect, test } from "bun:test";
import { mockClient, xml } from "../../../test/support/index.js";
import { disconnectClients } from "../../../test/support/mockClient.js";
import createOnAuthenticate from "../lib/createOnAuthenticate.js";

afterEach(disconnectClients);

const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const SASL2 = "urn:xmpp:sasl:2";
const PLAIN = "PLAIN";

test.each(["parallel", "after success"])(
  "credential callback forbids a second exchange: %s",
  async (mode) => {
    let attempts = 0;
    let second;
    const callback = createOnAuthenticate(async (authenticate) => {
      const first = authenticate({}, PLAIN);
      if (mode === "after success") {
        await first;
      }
      second = await authenticate({}, PLAIN).catch((error) => error);
      await first;
    });
    await callback(
      async () => {
        attempts++;
      },
      [PLAIN],
      null,
      { isSecure: () => true },
    );
    expect(attempts).toBe(1);
    expect(second).toBeInstanceOf(Error);
  },
);

// RFC 6120 §6.4.6: returning from an application callback is not SASL success.
test.each(["omit", "swallow failure"])(
  "credential callback cannot complete authentication: %s",
  async (mode) => {
    const callback = createOnAuthenticate(async (authenticate) => {
      if (mode === "swallow failure") {
        await authenticate({}, PLAIN).catch(() => {});
      }
    });
    await expect(
      callback(
        async () => {
          throw new Error("Peer rejected credentials");
        },
        [PLAIN],
        null,
        { isSecure: () => true },
      ),
    ).rejects.toThrow("SASL authentication did not complete");
  },
);

test("credential callback may retry after a rejected exchange", async () => {
  let attempts = 0;
  const callback = createOnAuthenticate(async (authenticate) => {
    await authenticate({}, PLAIN).catch(() => {});
    await authenticate({}, PLAIN);
  });
  await callback(
    async () => {
      if (++attempts === 1) {
        throw new Error("Peer rejected credentials");
      }
    },
    [PLAIN],
    null,
    { isSecure: () => true },
  );
  expect(attempts).toBe(2);
});

// RFC 6120 §§6.3.3, 13.8.3: application callbacks may select credentials,
// but must not bypass the offered mechanisms or transport security policy.
// Transport is a test seam here, not evidence of actual TLS protection.
for (const ns of [SASL, SASL2]) {
  test.each(["insecure", "unoffered", "downgrade", "allowed"])(
    `${ns}: callback mechanism policy / %s`,
    async (mode) => {
      const entity = mockClient({
        credentials: async (authenticate) => {
          await authenticate({ username: "user", password: "secret" }, PLAIN);
        },
      });
      entity.isSecure = () => mode !== "insecure";
      const sent = [];
      const outcome = new Promise((resolve) => {
        entity.on("error", resolve);
        entity.on("send", (element) => {
          sent.push(element);
          resolve(element);
        });
      });
      entity.mockInput(
        xml(
          "features",
          { xmlns: STREAM },
          xml(
            ns === SASL ? "mechanisms" : "authentication",
            { xmlns: ns },
            mode === "downgrade" && xml("mechanism", {}, "SCRAM-SHA-256"),
            xml(
              "mechanism",
              {},
              mode === "unoffered" ? "SCRAM-SHA-256" : PLAIN,
            ),
          ),
        ),
      );
      const result = await outcome;
      if (mode === "allowed") {
        expect(result.name).toBe(ns === SASL ? "auth" : "authenticate");
        expect(result.attrs.mechanism).toBe(PLAIN);
        expect(
          ns === SASL ? result.text() : result.getChildText("initial-response"),
        ).toBe("AHVzZXIAc2VjcmV0");
      } else {
        expect(sent).toEqual([]);
        expect(result.name).toBe("SASLError");
        expect(result.message).toContain(
          mode === "insecure" ? "secure transport" : mode === "downgrade" ? "preferred mechanism" : "not offered",
        );
      }
    },
  );
}
