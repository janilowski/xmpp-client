import { afterEach, test, expect } from "bun:test";
import { disconnectClients } from "../../test/support/mockClient.js";

afterEach(disconnectClients);

import { mockClient } from "../../test/support/index.js";
import { tick } from "../events/index.js";

const CREDENTIALS = { username: "user", password: "secret" };
const SM = "urn:xmpp:sm:3";
const SASL2 = "urn:xmpp:sasl:2";
const STREAM = "http://etherx.jabber.org/streams";

test("clearing a public SM ID cannot invent a session", async () => {
  const { entity, streamManagement: sm } = mockClient({
    credentials: CREDENTIALS,
  });
  sm.id = undefined;
  entity.mockInput(
    <features xmlns={STREAM}>
      <authentication xmlns={SASL2}>
        <mechanism>PLAIN</mechanism>
        <inline>
          <sm xmlns={SM} />
        </inline>
      </authentication>
    </features>,
  );
  const request = await entity.catchOutgoing();
  expect(request.is("authenticate", SASL2)).toBe(true);
  expect(request.getChild("resume", SM)).toBeUndefined();
});

test("resume", async () => {
  const { entity, streamManagement: sm } = mockClient({
    credentials: CREDENTIALS,
  });

  // A resumable session already owns a bound resource and its opaque ID.
  entity.streamFeatures.authenticated = true;
  entity._jid("foo@bar/test");
  entity.status = "online";
  const enabling = entity.catchOutgoing();
  entity.mockInput(
    <features xmlns="http://etherx.jabber.org/streams">
      <sm xmlns="urn:xmpp:sm:3" />
    </features>,
  );
  await enabling;
  entity.mockInput(
    <enabled xmlns="urn:xmpp:sm:3" id="session" resume="true" />,
  );
  await tick();
  entity.emit("disconnect");

  entity.mockInput(
    <features xmlns="http://etherx.jabber.org/streams">
      <authentication xmlns="urn:xmpp:sasl:2">
        <mechanism>PLAIN</mechanism>
        <inline>
          <sm xmlns="urn:xmpp:sm:3" />
        </inline>
      </authentication>
    </features>,
  );

  sm.outbound = 45;
  sm.inbound = 54;

   
  const element_resume = (await entity.catchOutgoing()).getChild("resume");
  element_resume.parent = null;
  expect(element_resume).toEqual(
    <resume xmlns="urn:xmpp:sm:3" h="0" previd={sm.id} />,
  );

  entity.mockInput(
    <success xmlns="urn:xmpp:sasl:2">
      <authorization-identifier>foo@bar</authorization-identifier>
      <resumed xmlns="urn:xmpp:sm:3" previd={sm.id} h="45" />
    </success>,
  );
  await tick();

  expect(entity.streamManagement.outbound).toBe(45);
  expect(entity.streamManagement.inbound).toBe(54);
  expect(entity.streamManagement.enabled).toBe(true);
});

// https://xmpp.org/extensions/xep-0198.html#example-30
test("Client failed to resume stream", async () => {
  const { entity, streamManagement: sm } = mockClient({
    credentials: CREDENTIALS,
  });

  sm.id = Math.random().toString().slice(2);

  entity.mockInput(
    <features xmlns="http://etherx.jabber.org/streams">
      <authentication xmlns="urn:xmpp:sasl:2">
        <mechanism>PLAIN</mechanism>
        <inline>
          <sm xmlns="urn:xmpp:sm:3" />
        </inline>
      </authentication>
    </features>,
  );

  sm.outbound = 45;
  sm.inbound = 54;

   
  const element_resume = (await entity.catchOutgoing()).getChild("resume");
  element_resume.parent = null;
  expect(element_resume).toEqual(
    <resume xmlns="urn:xmpp:sm:3" h="0" previd={sm.id} />,
  );

  entity.mockInput(
    <success xmlns="urn:xmpp:sasl:2">
      <authorization-identifier>foo@bar</authorization-identifier>
      <failed xmlns="urn:xmpp:sm:3" h="45">
        <item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas" />
      </failed>
    </success>,
  );
  await tick();

  expect(entity.streamManagement.outbound).toBe(0);
  expect(entity.streamManagement.inbound).toBe(54);
  expect(entity.streamManagement.enabled).toBe(false);
});
