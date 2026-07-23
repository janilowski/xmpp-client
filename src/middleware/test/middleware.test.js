import { context, mockClient, mockInput, promiseError } from "../../../test/support/index.js";

import IncomingContext from "../lib/IncomingContext.js";
import OutgoingContext from "../lib/OutgoingContext.js";
import _middleware, { runMiddleware } from "../index.js";

let ctx;

beforeEach(() => {
  ctx = context();
  const { entity } = ctx;
  ctx.middleware = _middleware({ entity });
});

test("use", (done) => {
  expect.assertions(4);
  const stanza = <presence />;
  ctx.middleware.use((ctx, next) => {
    expect(ctx instanceof IncomingContext).toBe(true);
    expect(ctx.stanza).toEqual(stanza);
    expect(ctx.entity).toBe(ctx.entity);
    expect(next() instanceof Promise).toBe(true);
    done();
  });
  ctx.fakeIncoming(stanza);
});

test("filter", (done) => {
  expect.assertions(3);
  const stanza = <presence />;
  ctx.middleware.filter((ctx, next) => {
    expect(ctx instanceof OutgoingContext).toBe(true);
    expect(ctx.stanza).toEqual(stanza);
    expect(next() instanceof Promise).toBe(true);
    done();
  });
  ctx.fakeOutgoing(stanza);
});

test("emits an error event if a middleware throws", async () => {
  const xmpp = mockClient();
  const { middleware } = xmpp;

  const error = new Error("foobar");
  const willError = promiseError(xmpp);

  middleware.use(async () => {
    await Promise.resolve();
    throw error;
  });

  mockInput(xmpp, <presence id="hello" />);

  const err = await willError;
  expect(err).toEqual(error);
});

test("runs middleware in onion order", async () => {
  const calls = [];

  await runMiddleware(
    [
      async (_context, next) => {
        calls.push("outer:before");
        await next();
        calls.push("outer:after");
      },
      async (_context, next) => {
        calls.push("inner:before");
        await next();
        calls.push("inner:after");
      },
    ],
    {},
  );

  expect(calls).toEqual([
    "outer:before",
    "inner:before",
    "inner:after",
    "outer:after",
  ]);
});

test("rejects a second call to the same next function", async () => {
  expect(
    runMiddleware(
      [async (_context, next) => {
        await next();
        await next();
      }],
      {},
    ),
  ).rejects.toThrow("next() called multiple times");
});

test("rejects a non-function middleware", async () => {
  expect(runMiddleware([null], {})).rejects.toThrow(
    "Every middleware must be a function.",
  );
});
