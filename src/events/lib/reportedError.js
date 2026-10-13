const reported = new WeakMap();

// Remember an error already published by an entity so one active operation
// can consume the rejection caused by that same event.
export function markReported(entity, error) {
  if (error instanceof Error) {
    reported.set(entity, error);
  }
}

export function isReported(entity, error) {
  return reported.get(entity) === error;
}

export function clearReported(entity) {
  reported.delete(entity);
}
