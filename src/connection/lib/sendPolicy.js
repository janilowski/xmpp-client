// Internal admission and single-use replay capabilities, not public send hooks.
export const sendPolicies = new WeakMap();
const replays = new WeakMap();

export class QueueFullError extends Error {
  code = "ERR_SM_QUEUE_FULL";

  constructor() {
    super("Stream Management queue is full");
    this.name = "QueueFullError";
  }
}

export function takeReplay(entity, token) {
  const replay = replays.get(token);
  replays.delete(token);
  return replay?.entity === entity ? replay.item : undefined;
}

export async function sendReplay(entity, item, stanza) {
  const token = {};
  replays.set(token, { entity, item });
  try {
    await entity.send(stanza, token);
  } finally {
    replays.delete(token);
  }
}
