import jid from "../../jid/index.js";

// Only protocol-confirmed identity and completion grant stanza routing authority.
const connections = new WeakMap();

export function resetConnection(entity) {
  connections.set(entity, { account: null, server: null, complete: false });
}

export function resetStream(entity, domain) {
  const state = connections.get(entity);
  state.server = jid("", domain).domain;
  state.complete = false;
  return state.server;
}

export function confirmIdentity(entity, address) {
  connections.get(entity).account = address.bare().toString();
}

export function completeNegotiation(entity) {
  connections.get(entity).complete = true;
}

export function canSendStanza(entity, destination) {
  const { account, server, complete } = connections.get(entity);
  if (complete || destination === undefined) {
    return true;
  }

  // RFC 6120 §4.3.5 permits the connected server and authenticated account.
  if (
    !destination.local &&
    !destination.resource &&
    destination.domain === server
  ) {
    return true;
  }

  return account !== null && destination.bare().toString() === account;
}
