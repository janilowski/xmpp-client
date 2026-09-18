# reconnect

Auto reconnect for `@xmpp/client` and `@xmpp/component`.

Included and enabled in `@xmpp/component` and `@xmpp/client`.

Supports Node.js and browsers.

Each reconnect will re-use the options provided to the entity `start` method.

## delay property

Base retry window in milliseconds. RFC 6120 §3.3 recommends randomized delays
and increasing backoff. Each retry waits uniformly between half and all of
`min(delay × 2^attempt, 60000)` milliseconds. The first attempt uses exponent 0.
Only reaching the `online` status resets the retry count, including resumption;
opening a transport is not authentication. Resumption emits `status: online`
without emitting another `online` event.
Duplicate disconnect events share one timer. `stop()` cancels pending retries;
an entity's `offline` event also cancels them without disabling future sessions.

Default is `1000`.

```js
reconnect.delay; // 1000
reconnect.delay = 2000;
```

## reconnecting event

Emitted each time a re-connection is attempted.

```js
reconnect.on("reconnecting", () => {
  console.log("reconnecting");
});
```

## reconnected event

Emitted each time a re-connection succeed.

```js
reconnect.on("reconnected", () => {
  console.log("reconnected");
});
```

## error event

Emitted on entity each time a re-connection fails.

```js
entity.on("error", (err) => {
  console.error(err);
});
```
