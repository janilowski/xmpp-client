/* eslint-disable n/no-unsupported-features/node-builtins */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mockClient, xml } from "../../test/support/index.js";
import { disconnectClients } from "../../test/support/mockClient.js";

let derive;
let factory;
afterEach(async () => {
  derive?.mockRestore();
  factory?.mockRestore();
  await disconnectClients();
});

// RFC 6120 §§4.4, 6; XEP-0388: old cryptographic work cannot send in a new session.
test.each(["urn:ietf:params:xml:ns:xmpp-sasl", "urn:xmpp:sasl:2"])(
  "SCRAM PBKDF2 completion after disconnect cannot leak a proof: %s",
  async (ns) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const original = crypto.subtle.deriveBits.bind(crypto.subtle);
    derive = spyOn(crypto.subtle, "deriveBits").mockImplementation(
      async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      },
    );
    const entity = mockClient({ username: "user", password: "pencil" });
    const create = entity.saslMechanisms.create.bind(entity.saslMechanisms);
    let pending;
    factory = spyOn(entity.saslMechanisms, "create").mockImplementation(
      (name) => {
        const mech = create(name);
        const respond = mech.response.bind(mech);
        let responses = 0;
        mech.response = (...args) => {
          const result = respond(...args);
          if (++responses === 2) {
            pending = result;
          }
          return result;
        };
        return mech;
      },
    );
    const errors = [];
    entity.on("error", (error) => errors.push(error));
    const features = xml(
      "features",
      { xmlns: "http://etherx.jabber.org/streams" },
      xml(
        ns === "urn:xmpp:sasl:2" ? "authentication" : "mechanisms",
        { xmlns: ns },
        xml("mechanism", {}, "SCRAM-SHA-1"),
      ),
    );
    entity.mockInput(features);
    const first = await entity.catchOutgoing();
    const encoded =
      ns === "urn:xmpp:sasl:2"
        ? first.getChildText("initial-response")
        : first.text();
    const nonce = atob(encoded).split(",r=")[1];
    entity.mockInput(
      xml("challenge", { xmlns: ns }, btoa(`r=${nonce}server,s=QQ==,i=4096`)),
    );
    await entered.promise;
    entity.emit("disconnect");
    entity.emit("connect");
    const sent = [];
    entity.send = async (stanza) => {
      sent.push(stanza);
    };
    release.resolve();
    await pending;
    await Promise.resolve();
    // The registry must not retain the interrupted exchange's nonce or key.
    const fresh = entity.saslMechanisms.create("SCRAM-SHA-1");
    const next = await fresh.response({ username: "user", password: "pencil" });
    expect(next).not.toContain(nonce);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
  },
);
