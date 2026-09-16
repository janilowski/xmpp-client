import { afterEach, expect, test } from "bun:test";
import { mockClient, mockInput } from "../../../test/support/index.js";
import { disconnectClients } from "../../../test/support/mockClient.js";

afterEach(disconnectClients);

// RFC 6120 §§8.1.2.1, 8.2.3, 8.3.1: correlate identity as well as ID.
const identities = [
  [undefined, undefined, true],
  [undefined, "bar", true],
  [undefined, "foo@bar", true],
  [undefined, "attacker@bar", false],
  [undefined, "foo@bar/other", false],
  ["bar", "bar", true],
  ["bar", undefined, true],
  ["foo@bar", undefined, true],
  ["peer@remote", "peer@remote", true],
  ["peer@remote", "peer@remote/device", true],
  ["Peer@REMOTE", "peer@remote", true],
  ["peer@remote", "PEER@REMOTE/Device", true],
  ["foo@bar/test", undefined, false],
  ["peer@remote/Device", "peer@remote/Device", true],
  ["peer@remote/Device/", "peer@remote/Device/", true],
  ["peer@remote", "peer@remote/Device/", true],
  ["peer@remote/Device", "peer@remote/device", false],
  ["peer@remote/Device", "peer@remote", false],
  ["peer@remote/Device", "peer@remote/other", false],
  ["expected.example", "different.example", false],
  ["expected.example", undefined, false],
  ["peer@remote", "bar", false],
  ["peer@remote", "other@remote", false],
  ["peer@remote", "peer@remote.evil", false],
  ["peer@remote", "", false],
  ["bar", "@bar", false],
  ["peer@remote", "peer@remote/", false],
];

for (const type of ["result", "error"]) {
  test.each(identities)(
    `${type}: to=%s from=%s accepted=%s`,
    async (to, from, accepted) => {
      const xmpp = mockClient({ domain: "bar" });
      let settled = false;
      const pending = xmpp.iqCaller.request(
        <iq type="get" id="identity" to={to} />,
      );
      const outcome = pending.then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      const reply = (
        <iq type={type} id="identity" from={from}>
          {type === "error" && (
            <error type="cancel" by="router.example">
              <service-unavailable xmlns="urn:ietf:params:xml:ns:xmpp-stanzas" />
            </error>
          )}
        </iq>
      );
      mockInput(xmpp, reply);
      await Bun.sleep(0);
      expect(settled).toBe(accepted);
      if (!accepted) {
        expect(xmpp.iqCaller.handlers.has("identity")).toBe(true);
        const valid = <iq type="result" id="identity" from={to} />;
        mockInput(xmpp, valid);
        expect(await outcome).toEqual(valid);
      } else if (type === "error") {
        expect((await outcome).condition).toBe("service-unavailable");
      } else {
        expect(await outcome).toEqual(reply);
      }
      expect(xmpp.iqCaller.handlers.size).toBe(0);
    },
  );
}

test("duplicate active ID is rejected without replacing or sending the request", async () => {
  const xmpp = mockClient();
  let sent = 0;
  xmpp.send = async () => {
    sent++;
  };
  const original = xmpp.iqCaller.request(
    <iq type="get" id="same" to="first.example" />,
  );
  const outcome = original.catch((error) => error);
  await expect(
    xmpp.iqCaller.request(<iq type="get" id="same" to="second.example" />, 10),
  ).rejects.toThrow("Duplicate IQ id");
  expect(sent).toBe(1);
  const reply = <iq type="result" id="same" from="first.example" />;
  mockInput(xmpp, reply);
  expect(await outcome).toEqual(reply);
});

test.each(["timeout", "disconnect"])(
  "forged reply preserves %s cleanup",
  async (mode) => {
    const xmpp = mockClient();
    const pending = xmpp.iqCaller.request(
      <iq type="get" id="cleanup" to="peer.example" />,
      30,
    );
    const outcome = pending.catch((error) => error);
    mockInput(xmpp, <iq type="result" id="cleanup" from="attacker.example" />);
    if (mode === "disconnect") {
      xmpp.emit("disconnect");
    }
    expect((await outcome).name).toBe(
      mode === "timeout" ? "TimeoutError" : "AbortError",
    );
    expect(xmpp.iqCaller.handlers.size).toBe(0);
  },
);

test("request identity is stable when the caller mutates its stanza", async () => {
  const xmpp = mockClient();
  const stanza = <iq type="get" id="snapshot" to="expected.example" />;
  const pending = xmpp.iqCaller.request(stanza);
  stanza.attrs.to = "attacker.example";
  stanza.attrs.id = "changed";
  mockInput(xmpp, <iq type="result" id="snapshot" from="attacker.example" />);
  expect(xmpp.iqCaller.handlers.has("snapshot")).toBe(true);
  const reply = <iq type="result" id="snapshot" from="expected.example" />;
  mockInput(xmpp, reply);
  expect(await pending).toEqual(reply);
  expect(xmpp.iqCaller.handlers.size).toBe(0);
});

test("a completed ID can be reused without accepting the previous peer", async () => {
  const xmpp = mockClient();
  const first = xmpp.iqCaller.request(
    <iq type="get" id="reuse" to="first.example" />,
  );
  mockInput(xmpp, <iq type="result" id="reuse" from="first.example" />);
  await first;
  const second = xmpp.iqCaller.request(
    <iq type="get" id="reuse" to="second.example" />,
  );
  mockInput(xmpp, <iq type="result" id="reuse" from="first.example" />);
  expect(xmpp.iqCaller.handlers.has("reuse")).toBe(true);
  const reply = <iq type="result" id="reuse" from="second.example" />;
  mockInput(xmpp, reply);
  expect(await second).toEqual(reply);
});
