import operation from "./operation.js";

export default function procedure(entity, stanza = null, handler, parent) {
  return operation(
    entity,
    (signal) =>
      new Promise((resolve, reject) => {
        const cleanup = () => entity.removeListener("nonza", listener);
        signal.addEventListener("abort", cleanup, { once: true });

        function done(value) {
          cleanup();
          resolve(value);
        }

        async function listener(element) {
          if (signal.aborted) {
            return;
          }
          try {
            await handler(element, done, signal);
          } catch (error) {
            reject(error);
          }
        }

        // Observe responses and termination before sending, including synchronous peers.
        entity.on("nonza", listener);
        if (stanza) {
          try {
            Promise.resolve(entity.send(stanza)).catch(reject);
          } catch (error) {
            reject(error);
          }
        }
      }),
    entity.timeout,
    parent,
  );
}
