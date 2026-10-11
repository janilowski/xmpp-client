// Internal, one-shot reply policy owned by the feature issuing this request.
const matchers = new WeakMap();

export function setReplyMatcher(stanza, matcher) {
  matchers.set(stanza, matcher);
}

export function takeReplyMatcher(stanza) {
  const matcher = matchers.get(stanza);
  matchers.delete(stanza);
  return matcher;
}
