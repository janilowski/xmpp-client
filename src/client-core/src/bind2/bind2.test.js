import { afterEach, test, expect } from "bun:test";
import { disconnectClients } from "../../../../test/support/mockClient.js";

afterEach(disconnectClients);

import { mockClient, id, promiseError } from "../../../../test/support/index.js";
import parseDocument from "../../../xml/lib/parseDocument.js";
import xml from "../../../xml/index.js";

for (const offer of [
  '<inline xmlns="urn:test:foreign"><feature xmlns="urn:xmpp:bind:0" var="urn:test:session-feature"/></inline>',
  '<inline><other var="urn:test:session-feature"/></inline>',
]) {
  test(`Bind2 ignores a non-Bind2 feature advertisement: ${offer}`, async () => {
    const { entity } = mockClient({ credentials: CREDENTIALS });
    let calls = 0;
    entity.bind2.use(
      "urn:test:session-feature",
      () => {
        calls += 1;
        return xml("request", "urn:test:session-feature");
      },
      () => {},
    );
    entity.mockInput(
      parseDocument(
        `<features xmlns="http://etherx.jabber.org/streams"><authentication xmlns="urn:xmpp:sasl:2"><mechanism>PLAIN</mechanism><inline><bind xmlns="urn:xmpp:bind:0">${offer}</bind></inline></authentication></features>`,
      ),
    );
    const authenticate = await catchAuthenticate(entity);
    expect(calls).toBe(0);
    expect(
      authenticate
        .getChild("bind", "urn:xmpp:bind:0")
        .getChild("request", "urn:test:session-feature"),
    ).toBeUndefined();
  });
}

const CREDENTIALS = { username: "user", password: "secret" };

function mockFeatures(entity) {
  entity.mockInput(
    <features xmlns="http://etherx.jabber.org/streams">
      <authentication xmlns="urn:xmpp:sasl:2">
        <mechanism>PLAIN</mechanism>
        <inline>
          <bind xmlns="urn:xmpp:bind:0" />
        </inline>
      </authentication>
    </features>,
  );
}

function catchAuthenticate(entity) {
  return entity.catchOutgoing((stanza) => {
    if (stanza.is("authenticate", "urn:xmpp:sasl:2")) return true;
  });
}

test("without tag", async () => {
  const { entity } = mockClient({ credentials: CREDENTIALS });
  mockFeatures(entity);
  const stanza = await catchAuthenticate(entity);

  await expect(stanza.getChild("bind", "urn:xmpp:bind:0").toString()).toEqual(
    (<bind xmlns="urn:xmpp:bind:0" />).toString(),
  );
});

test("with string tag", async () => {
  const resource = id();
  const { entity } = mockClient({ credentials: CREDENTIALS, resource });
  mockFeatures(entity);
  const stanza = await catchAuthenticate(entity);

  expect(stanza.getChild("bind", "urn:xmpp:bind:0").toString()).toEqual(
    (
      <bind xmlns="urn:xmpp:bind:0">
        <tag>{resource}</tag>
      </bind>
    ).toString(),
  );
});

test("with function resource returning string", async () => {
   
  function resource() {
    return "1k2k3";
  }

  const { entity } = mockClient({ credentials: CREDENTIALS, resource });
  mockFeatures(entity);
  const stanza = await catchAuthenticate(entity);

  expect(stanza.getChild("bind", "urn:xmpp:bind:0").toString()).toEqual(
    (
      <bind xmlns="urn:xmpp:bind:0">
        <tag>{resource()}</tag>
      </bind>
    ).toString(),
  );
});

test("with function resource throwing", async () => {
  const error = new Error("foo");

  function resource() {
    throw error;
  }

  const { entity } = mockClient({ credentials: CREDENTIALS, resource });

  const willError = promiseError(entity);

  mockFeatures(entity);

  expect(await willError).toBe(error);
});

test("with function resource returning resolved promise", async () => {
   
  async function resource() {
    return "1k2k3";
  }

  const { entity } = mockClient({ credentials: CREDENTIALS, resource });
  mockFeatures(entity);
  const stanza = await catchAuthenticate(entity);

  expect(stanza.getChild("bind", "urn:xmpp:bind:0").toString()).toEqual(
    (
      <bind xmlns="urn:xmpp:bind:0">
        <tag>{await resource()}</tag>
      </bind>
    ).toString(),
  );
});

test("with function resource returning rejected promise", async () => {
  const error = new Error("foo");

  async function resource() {
    throw error;
  }

  const { entity } = mockClient({ credentials: CREDENTIALS, resource });

  const willError = promiseError(entity);

  mockFeatures(entity);

  expect(await willError).toBe(error);
});
