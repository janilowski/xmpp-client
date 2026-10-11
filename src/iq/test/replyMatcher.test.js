import { afterEach, expect, test } from "bun:test";
import { mockClient, mockInput } from "../../../test/support/index.js";
import { disconnectClients } from "../../../test/support/mockClient.js";
import { resetStream } from "../../connection/lib/negotiation.js";
import TimeoutError from "../../events/lib/TimeoutError.js";
import { setReplyMatcher, takeReplyMatcher } from "../lib/replyMatcher.js";

afterEach(disconnectClients);

const SERVER = "server.example";
const ASSIGNED_ACCOUNT = "assigned@canonical.example";
const NS_QUERY = "urn:test:iq";

test("the request consumes its exact matcher before send hooks", async () => {
  const xmpp = mockClient();
  resetStream(xmpp, SERVER);
  xmpp._ready();
  const request = (
    <iq type="get" id="owned">
      <query xmlns={NS_QUERY} />
    </iq>
  );
  const candidates = [];
  setReplyMatcher(request, (stanza) => {
    candidates.push(stanza);
    return stanza.attrs.from === ASSIGNED_ACCOUNT;
  });
  let sent = false;
  xmpp.on("send", (stanza) => {
    expect(stanza).toBe(request);
    expect(takeReplyMatcher(stanza)).toBeUndefined();
    sent = true;
  });

  const sending = xmpp.catchOutgoing();
  const pending = xmpp.iqCaller.request(request);
  expect(await sending).toBe(request);
  expect(sent).toBe(true);
  const reply = <iq type="result" id="owned" from={ASSIGNED_ACCOUNT} />;
  mockInput(xmpp, reply);
  expect(await pending).toBe(reply);
  expect(candidates).toEqual([reply]);
  expect(takeReplyMatcher(request)).toBeUndefined();
});

test.each([
  "duplicate ID",
  "invalid destination",
  "aborted signal",
  "send failure",
  "deadline",
  "success",
  "disconnect",
])("%s cannot retain matcher authority on Element reuse", async (ending) => {
  const xmpp = mockClient();
  resetStream(xmpp, SERVER);
  xmpp._ready();
  const request = (
    <iq type="get" id="once">
      <query xmlns={NS_QUERY} />
    </iq>
  );
  let calls = 0;
  setReplyMatcher(request, (stanza) => {
    calls++;
    return stanza.attrs.from === ASSIGNED_ACCOUNT;
  });

  if (ending === "duplicate ID") {
    const original = xmpp.iqCaller.request(
      <iq type="get" id="once">
        <query xmlns={NS_QUERY} />
      </iq>,
    );
    await expect(xmpp.iqCaller.request(request)).rejects.toThrow(
      "Duplicate IQ id",
    );
    const reply = <iq type="result" id="once" from={SERVER} />;
    mockInput(xmpp, reply);
    expect(await original).toBe(reply);
  } else if (ending === "invalid destination") {
    request.attrs.to = "@invalid.example";
    await expect(xmpp.iqCaller.request(request)).rejects.toBeInstanceOf(
      TypeError,
    );
    delete request.attrs.to;
  } else if (ending === "aborted signal") {
    const controller = new AbortController();
    const reason = new DOMException("Cancelled", "AbortError");
    controller.abort(reason);
    await expect(
      xmpp.iqCaller.request(request, xmpp.timeout, controller.signal),
    ).rejects.toBe(reason);
  } else if (ending === "send failure") {
    const send = xmpp.send;
    const error = new Error("Send failed");
    xmpp.send = async () => {
      throw error;
    };
    await expect(xmpp.iqCaller.request(request)).rejects.toBe(error);
    xmpp.send = send;
  } else if (ending === "deadline") {
    const outcome = await xmpp.iqCaller
      .request(request, 5)
      .catch((error) => error);
    expect(outcome).toBeInstanceOf(TimeoutError);
    expect(outcome.name).toBe("TimeoutError");
  } else if (ending === "success") {
    const pending = xmpp.iqCaller.request(request);
    const reply = <iq type="result" id="once" from={ASSIGNED_ACCOUNT} />;
    mockInput(xmpp, reply);
    expect(await pending).toBe(reply);
    expect(calls).toBe(1);
  } else {
    const pending = xmpp.iqCaller.request(request);
    const outcome = pending.catch((error) => error);
    xmpp.emit("disconnect");
    expect((await outcome).name).toBe("AbortError");
    xmpp.emit("connect");
    resetStream(xmpp, SERVER);
    xmpp._ready();
  }
  expect(xmpp.iqCaller.handlers.size).toBe(0);

  // Do not take metadata here: reuse must reject the formerly allowed sender.
  const previousCalls = calls;
  let settled = false;
  const pending = xmpp.iqCaller.request(request).then((reply) => {
    settled = true;
    return reply;
  });
  mockInput(xmpp, <iq type="result" id="once" from={ASSIGNED_ACCOUNT} />);
  await Bun.sleep(0);
  expect(settled).toBe(false);
  expect(calls).toBe(previousCalls);
  expect(xmpp.iqCaller.handlers.has("once")).toBe(true);

  const reply = <iq type="result" id="once" from={SERVER} />;
  mockInput(xmpp, reply);
  expect(await pending).toBe(reply);
  expect(xmpp.iqCaller.handlers.size).toBe(0);
  expect(takeReplyMatcher(request)).toBeUndefined();
});

test.each(["explicit destination", "confirmed account"])(
  "%s suppresses the exceptional matcher",
  async (context) => {
    const xmpp = mockClient();
    resetStream(xmpp, SERVER);
    if (context === "confirmed account") {
      xmpp._jid("known@server.example/resource");
    }
    xmpp._ready();
    const to = context === "explicit destination" ? "peer.example" : undefined;
    const request = (
      <iq type="get" id="restricted" to={to}>
        <query xmlns={NS_QUERY} />
      </iq>
    );
    let calls = 0;
    setReplyMatcher(request, () => {
      calls++;
      return true;
    });
    let settled = false;
    const pending = xmpp.iqCaller.request(request).then((reply) => {
      settled = true;
      return reply;
    });
    mockInput(
      xmpp,
      <iq type="result" id="restricted" from={ASSIGNED_ACCOUNT} />,
    );
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(calls).toBe(0);
    expect(xmpp.iqCaller.handlers.has("restricted")).toBe(true);

    const from = to ?? "known@server.example";
    const reply = <iq type="result" id="restricted" from={from} />;
    mockInput(xmpp, reply);
    expect(await pending).toBe(reply);
    expect(calls).toBe(0);
    expect(xmpp.iqCaller.handlers.size).toBe(0);
  },
);

test("a thrown matcher neither escapes middleware nor consumes the request", async () => {
  const xmpp = mockClient();
  resetStream(xmpp, SERVER);
  xmpp._ready();
  const request = (
    <iq type="get" id="throwing">
      <query xmlns={NS_QUERY} />
    </iq>
  );
  let calls = 0;
  setReplyMatcher(request, () => {
    calls++;
    throw new Error("Invalid candidate");
  });
  const errors = [];
  xmpp.on("error", (error) => errors.push(error));
  let settled = false;
  const pending = xmpp.iqCaller.request(request).then((reply) => {
    settled = true;
    return reply;
  });
  expect(() => {
    mockInput(xmpp, <iq type="result" id="throwing" from={ASSIGNED_ACCOUNT} />);
  }).not.toThrow();
  await Bun.sleep(0);
  expect(calls).toBe(1);
  expect(errors).toEqual([]);
  expect(settled).toBe(false);
  expect(xmpp.iqCaller.handlers.has("throwing")).toBe(true);

  const reply = <iq type="result" id="throwing" from={SERVER} />;
  mockInput(xmpp, reply);
  expect(await pending).toBe(reply);
  expect(calls).toBe(1);
  expect(errors).toEqual([]);
  expect(xmpp.iqCaller.handlers.size).toBe(0);
});
