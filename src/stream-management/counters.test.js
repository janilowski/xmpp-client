import { afterEach, expect, test } from "bun:test";
import { mockClient } from "../../test/support/index.js";
import { disconnectClients } from "../../test/support/mockClient.js";
import { tick } from "../events/index.js";

afterEach(disconnectClients);
// XEP-0198 1.6.3 §§4–6 and §13 schema: counts, rollover and resumption.
// Malformed counts use bad-format by local policy; over-ack uses §6's error.
const NS = "urn:xmpp:sm:3";
const MAX_H = 4_294_967_295;

test("an acknowledgement cannot consume a disconnected session's queue", async () => {
  const xmpp = mockClient();
  const sm = xmpp.streamManagement;
  sm.outbound_q = [{ stanza: <message id="old" /> }];
  xmpp.mockInput(<a xmlns={NS} h="1" />);
  await tick();
  expect(sm.outbound_q).toHaveLength(1);
  expect(sm.outbound).toBe(0);
});

for (const mode of ["features", "sasl2"]) {
  test.each(["resumed", "failed", "invalid"])(
    `${mode}: %s accounts for the old queue before replay or failure`,
    async (result) => {
      const xmpp = mockClient();
      const sm = xmpp.streamManagement;
      sm.id = "old-session";
      sm.outbound = MAX_H;
      sm.outbound_q = ["a", "b"].map((id) => ({
        stanza: <message id={id} />,
        stamp: "2026-01-01T00:00:00Z",
      }));
      const acks = [],
        failures = [],
        sent = [],
        errors = [];
      const activeOnAck = [];
      sm.on("ack", () => activeOnAck.push(sm.enabled));
      sm.on("ack", (stanza) => acks.push(stanza.attrs.id));
      sm.on("fail", (stanza) => failures.push(stanza.attrs.id));
      xmpp.on("send", (stanza) => sent.push(stanza));
      xmpp._streamError = async (...args) => {
        errors.push(args);
      };
      const outgoing = xmpp.catchOutgoing();
      xmpp.mockInput(
        <features xmlns="http://etherx.jabber.org/streams">
          {mode === "features" ? (
            <sm xmlns={NS} />
          ) : (
            <authentication xmlns="urn:xmpp:sasl:2">
              <mechanism>PLAIN</mechanism>
              <inline>
                <sm xmlns={NS} />
              </inline>
            </authentication>
          )}
        </features>,
      );
      await outgoing;
      const response =
        result === "failed" ? (
          <failed xmlns={NS} h="0">
            <item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas" />
          </failed>
        ) : (
          <resumed
            xmlns={NS}
            previd="old-session"
            h={result === "invalid" ? "2" : "0"}
          />
        );
      const completed =
        result === "resumed"
          ? new Promise((resolve) => sm.once("resumed", resolve))
          : Promise.resolve();
      xmpp.mockInput(
        mode === "features" ? (
          response
        ) : (
          <success xmlns="urn:xmpp:sasl:2">{response}</success>
        ),
      );
      await completed;
      await tick();
      expect(acks).toEqual(result === "invalid" ? [] : ["a"]);
      expect(failures).toEqual(result === "failed" ? ["b"] : []);
      expect(
        sent
          .filter((stanza) => stanza.is("message"))
          .map((stanza) => stanza.attrs.id),
      ).toEqual(result === "resumed" ? ["b"] : []);
      expect(errors.map(([condition]) => condition)).toEqual(
        result === "invalid" ? ["undefined-condition"] : [],
      );
      expect(sm.outbound_q.map(({ stanza }) => stanza.attrs.id)).toEqual(
        result === "invalid" ? ["a", "b"] : result === "failed" ? [] : ["b"],
      );
      if (result === "resumed") {
        expect(activeOnAck).toEqual([true]);
        xmpp.mockInput(<a xmlns={NS} h="1" />);
        await tick();
        expect(acks).toEqual(["a", "b"]);
        expect(sm.outbound_q).toEqual([]);
      } else {
        expect(sm.enabled).toBe(false);
      }
    },
  );
}

test.each([
  undefined,
  "",
  " ",
  "-1",
  "4294967296",
  "1.5",
  "1e0",
  "0x1",
  "NaN",
  "Infinity",
  "1x",
])("invalid acknowledgement h=%s cannot consume queued stanzas", async (h) => {
  const xmpp = mockClient();
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  const errors = [];
  xmpp._streamError = async (...args) => {
    errors.push(args);
  };
  const acks = [];
  sm.on("ack", (stanza) => acks.push(stanza));
  await xmpp.send(<message id="pending" />);
  xmpp.mockInput(<a xmlns={NS} h={h} />);
  await tick();
  expect(errors.map(([condition]) => condition)).toEqual(["bad-format"]);
  expect(acks).toEqual([]);
  expect(sm.outbound).toBe(0);
  expect(sm.outbound_q).toHaveLength(1);
  expect(sm.enabled).toBe(false);
});

test.each([0, 1, 2])(
  "over-ack is atomic with %s queued stanzas",
  async (count) => {
    const xmpp = mockClient();
    const sm = xmpp.streamManagement;
    sm.enabled = true;
    const errors = [];
    xmpp._streamError = async (...args) => {
      errors.push(args);
    };
    const acks = [];
    sm.on("ack", (stanza) => acks.push(stanza));
    for (let i = 0; i < count; i++) {
      await xmpp.send(<message id={String(i)} />);
    }
    xmpp.mockInput(<a xmlns={NS} h={String(count + 1)} />);
    await tick();
    expect(errors.map(([condition]) => condition)).toEqual([
      "undefined-condition",
    ]);
    expect(errors[0][2]).toEqual(
      <handled-count-too-high
        xmlns={NS}
        h={String(count + 1)}
        send-count={count}
      />,
    );
    expect(acks).toEqual([]);
    expect(sm.outbound).toBe(0);
    expect(sm.outbound_q).toHaveLength(count);
  },
);

test("acknowledgements wrap, repeat and leave an ordered suffix", async () => {
  const xmpp = mockClient();
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  sm.outbound = MAX_H - 1;
  const acks = [];
  sm.on("ack", (stanza) => acks.push(stanza.attrs.id));
  for (const id of ["a", "b", "c"]) {
    await xmpp.send(<message id={id} />);
  }
  xmpp.mockInput(<a xmlns={NS} h="0" />);
  await tick();
  expect(acks).toEqual(["a", "b"]);
  expect(sm.outbound).toBe(0);
  expect(sm.outbound_q.map(({ stanza }) => stanza.attrs.id)).toEqual(["c"]);
  xmpp.mockInput(<a xmlns={NS} h="0" />);
  xmpp.mockInput(<a xmlns={NS} h="1" />);
  await tick();
  expect(acks).toEqual(["a", "b", "c"]);
  expect(sm.outbound).toBe(1);
  expect(sm.outbound_q).toEqual([]);
});

test("received stanza counter wraps in outgoing acknowledgements", async () => {
  const xmpp = mockClient();
  const sm = xmpp.streamManagement;
  sm.enabled = true;
  sm.inbound = MAX_H;
  const ack = xmpp.catchOutgoing((stanza) => stanza.is("a", NS));
  xmpp.mockInput(<message />);
  xmpp.mockInput(<r xmlns={NS} />);
  expect((await ack).attrs.h).toBe("0");
  expect(sm.inbound).toBe(0);
});

test.each(["+0001", " 1 ", "\t1\n"])(
  "XML unsignedInt lexical form %s is accepted",
  async (h) => {
    const xmpp = mockClient();
    xmpp.streamManagement.enabled = true;
    await xmpp.send(<message />);
    xmpp.mockInput(<a xmlns={NS} h={h} />);
    await tick();
    expect(xmpp.streamManagement.outbound).toBe(1);
    expect(xmpp.streamManagement.outbound_q).toEqual([]);
  },
);
