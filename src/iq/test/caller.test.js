import { mockClient, mockInput } from "../../../test/support/index.js";
import StanzaError from "../../middleware/lib/StanzaError.js";

test("deadline includes a send that never settles", async () => {
  const xmpp = mockClient();
  xmpp.send = () => new Promise(() => {});
  let error;
  const pending = xmpp.iqCaller.request(<iq type="get" />, 5).catch((error_) => { error = error_; });
  await Bun.sleep(25);
  expect(error?.name).toBe("TimeoutError");
  expect(xmpp.iqCaller.handlers.size).toBe(0);
  await pending;
});

test("disconnect rejects old IQ while a new session can receive its own response", async () => {
  const xmpp = mockClient();
  const old = xmpp.iqCaller.request(<iq type="get" id="old" />);
  xmpp.emit("disconnect");
  await expect(old).rejects.toThrow("Connection closed");
  xmpp.emit("connect");
  const current = xmpp.iqCaller.request(<iq type="get" id="new" />);
  mockInput(xmpp, <iq type="result" id="old" />);
  expect(xmpp.iqCaller.handlers.has("new")).toBe(true);
  const reply = <iq type="result" id="new" />;
  mockInput(xmpp, reply);
  expect(await current).toEqual(reply);
  expect(xmpp.iqCaller.handlers.size).toBe(0);
});

test("#request", async () => {
  const xmpp = mockClient();
  const { iqCaller } = xmpp;

  xmpp.send = (el) => {
    expect(el).toEqual(
      <iq type="get" id="foobar">
        <foo />
      </iq>,
    );
    mockInput(xmpp, <iq type="result" id="foobar" />);
    return Promise.resolve();
  };

  await iqCaller.request(
    <iq type="get" id="foobar">
      <foo />
    </iq>,
  );
});

test("removes the handler if sending failed", async () => {
  const xmpp = mockClient();
  const { iqCaller } = xmpp;

  const error = new Error("foobar");

  xmpp.send = () => {
    return Promise.reject(error);
  };

  const promise = iqCaller.request(
    <iq type="get">
      <foo />
    </iq>,
  );

  expect(iqCaller.handlers.size).toBe(1);

  try {
    await promise;
  } catch (error_) {
    expect(error_).toBe(error);
    expect(iqCaller.handlers.size).toBe(0);
  }
});

test("resolves with with the stanza for result reply", async () => {
  const xmpp = mockClient();
  const { iqCaller } = xmpp;

  const id = "foo";

  const promiseRequest = iqCaller.request(<iq type="get" id={id} />);

  const reply = <iq type="result" id={id} />;
  mockInput(xmpp, reply);

  expect(await promiseRequest).toEqual(reply);
});

test("rejects with a StanzaError for error reply", async () => {
  expect.assertions(1);
  const xmpp = mockClient();
  const { iqCaller } = xmpp;

  const id = "foo";

  const promiseRequest = iqCaller.request(<iq type="get" id={id} />);

  const errorElement = (
    <error type="modify">
      <service-unavailable xmlns="urn:ietf:params:xml:ns:xmpp-stanzas" />
    </error>
  );
  const stanzaElement = (
    <iq type="error" id={id}>
      {errorElement}
    </iq>
  );
  mockInput(xmpp, stanzaElement);

  try {
    await promiseRequest;
  } catch (error) {
    expect(error).toEqual(StanzaError.fromElement(errorElement));
  }
});

test("rejects with a TimeoutError if no answer is received within timeout", async () => {
  const xmpp = mockClient();
  const { iqCaller } = xmpp;

  const promise = iqCaller.request(
    <iq type="get">
      <foo />
    </iq>,
    1,
  );

  expect(iqCaller.handlers.size).toBe(1);

  try {
    await promise;
  } catch (error) {
    expect(error.name).toBe("TimeoutError");
    expect(iqCaller.handlers.size).toBe(0);
  }
});

test("#get", async () => {
  const xmpp = mockClient();
  const { iqCaller } = xmpp;

  const requestChild = <foo xmlns="foo:bar" />;
  const promiseGet = iqCaller.get(requestChild, "hello@there");
  const { id } = requestChild.parent.attrs;

  const replyChild = <foo xmlns="foo:bar" />;
  const reply = (
    <iq type="result" id={id} from="hello@there">
      {replyChild}
    </iq>
  );
  mockInput(xmpp, reply);

  expect(await promiseGet).toEqual(replyChild);
});

test("#set", async () => {
  const xmpp = mockClient();
  const { iqCaller } = xmpp;

  const requestChild = <foo xmlns="foo:bar" />;
  const promiseSet = iqCaller.set(requestChild, "hello@there");
  const { id } = requestChild.parent.attrs;

  const replyChild = <foo xmlns="foo:bar" />;
  const reply = (
    <iq type="result" id={id} from="hello@there">
      {replyChild}
    </iq>
  );
  mockInput(xmpp, reply);

  expect(await promiseSet).toEqual(replyChild);
});
