const failures = new WeakMap<object, Error>();

// RFC 6120 §4.9.3.16: WebSocket cannot force a fresh TLS security context.
// Keep this refusal outside negotiation state so stop/start cannot erase it.
export function refuseReconnect(entity: object, error: Error) {
  failures.set(entity, error);
}

export function assertCanConnect(entity: object) {
  const error = failures.get(entity);
  if (error) {
    throw error;
  }
}
