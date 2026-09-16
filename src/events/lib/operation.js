import TimeoutError from "./TimeoutError.js";

export class ConnectionClosedError extends Error {
  constructor() {
    super("Connection closed");
    this.name = "AbortError";
  }
}

// Bound one exchange to its connection, including asynchronous preparation.
export default function operation(
  entity,
  run,
  timeout = entity.timeout,
  parent,
) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer;

    function finish(settle, value) {
      if (signal.aborted) {
        return;
      }
      clearTimeout(timer);
      entity.removeListener("close", onClose);
      entity.removeListener("disconnect", onClose);
      entity.removeListener("error", onError);
      parent?.removeEventListener("abort", onAbort);
      controller.abort(
        settle === reject
          ? value
          : new DOMException("Operation finished", "AbortError"),
      );
      settle(value);
    }

    function onError(error) {
      finish(reject, error);
    }

    function onClose() {
      finish(reject, new ConnectionClosedError());
    }

    function onAbort() {
      finish(reject, parent.reason);
    }

    entity.on("close", onClose);
    entity.on("disconnect", onClose);
    entity.on("error", onError);
    parent?.addEventListener("abort", onAbort, { once: true });
    if (parent?.aborted) {
      onAbort();
      return;
    }
    if (timeout) {
      timer = setTimeout(() => finish(reject, new TimeoutError()), timeout);
    }
    try {
      return Promise.resolve(run(signal)).then(
        (value) => finish(resolve, value),
        onError,
      );
    } catch (error) {
      onError(error);
    }
  });
}
