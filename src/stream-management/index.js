import { EventEmitter } from "../events/index.js";
import xml from "../xml/index.js";
import jid from "../jid/index.js";
import { datetime } from "../util/time.js";
import { ConnectionClosedError } from "../events/lib/operation.js";
import {
  QueueFullError,
  sendPolicies,
  sendReplay,
} from "../connection/lib/sendPolicy.js";
import {
  completeNegotiation,
  getAccount,
  getIdentity,
} from "../connection/lib/negotiation.js";

import { setupBind2 } from "./bind2.js";
import { setupSasl2 } from "./sasl2.js";
import { setupStreamFeature } from "./stream-feature.js";

// https://xmpp.org/extensions/xep-0198.html

export const NS = "urn:xmpp:sm:3";
const SASL2 = "urn:xmpp:sasl:2";
const BIND2 = "urn:xmpp:bind:0";
const COUNTER_MODULUS = 2 ** 32;
const DEFAULT_MAX_STANZAS = 1024;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// RFC 6120 §4.6.4 recommends no more than one idle check per five minutes.
const DEFAULT_IDLE_INTERVAL_MS = 300_000;
const QUEUE_ERRORS = "https://github.com/janilowski/xmpp-client/errors";
const STREAM = "http://etherx.jabber.org/streams";
const encoder = new TextEncoder();

export function makeEnableElement({ sm }) {
  return xml("enable", {
    xmlns: NS,
    max: sm.preferredMaximum,
    resume: "true",
  });
}

export function makeResumeElement({ sm }) {
  return xml("resume", { xmlns: NS, h: sm.inbound, previd: sm.id });
}

export default function streamManagement({
  streamFeatures,
  entity,
  middleware,
  bind2,
  sasl2,
}) {
  let timeoutTimeout = null;
  let requestAckTimeout = null;
  let requestAckDebounce = null;
  let session = null;
  const charges = new WeakMap();
  const attempts = new WeakMap();
  let outboundBytes = 0;
  let closing = false;
  let enabling = null;
  const enableState = { attempted: false };
  const options = entity.options.streamManagement;
  if (
    options !== undefined &&
    (!options || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new TypeError("Invalid Stream Management options");
  }
  const { maxStanzas = DEFAULT_MAX_STANZAS, maxBytes = DEFAULT_MAX_BYTES } =
    options ?? {};
  if (
    !Number.isSafeInteger(maxStanzas) ||
    maxStanzas < 1 ||
    maxStanzas >= COUNTER_MODULUS
  ) {
    throw new RangeError("Invalid Stream Management maxStanzas");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Invalid Stream Management maxBytes");
  }

  // A present opaque ID can be empty; public ID hints still need validation.
  function hasResumeId() {
    return Boolean(sm.id) || (session !== null && session.id === sm.id);
  }

  const sm = Object.assign(new EventEmitter(), {
    preferredMaximum: null,
    enabled: false,
    enableSent: false,
    id: "",
    outbound_q: [],
    outbound: 0,
    inbound: 0,
    max: null,
    timeout: 60_000,
    requestAckInterval: DEFAULT_IDLE_INTERVAL_MS,
    requestAckDebounce: 250,
  });

  // Admission uses the validated wire snapshot and includes in-flight writes.
  sendPolicies.set(entity, {
    prepare({ element, source, name, namespace, replay }) {
      if (closing && !(namespace === STREAM && name === "error")) {
        throw new ConnectionClosedError();
      }
      if (namespace === NS && name === "enable") {
        const attempt = {};
        enabling = attempt;
        sm.enableSent = true;
        return {
          rollback() {
            if (enabling === attempt && !sm.enabled) {
              sm.enableSent = false;
            }
          },
        };
      }
      if (
        namespace !== entity.NS ||
        !["message", "presence", "iq"].includes(name) ||
        (!sm.enabled && !sm.enableSent)
      ) {
        return;
      }
      const attempt = {};
      if (replay) {
        if (!sm.outbound_q.includes(replay)) {
          return { skip: true };
        }
        // Replay retains its original admission charge, not a second slot.
        attempts.set(replay, attempt);
        return;
      }
      const available = maxBytes - outboundBytes;
      if (sm.outbound_q.length >= maxStanzas || source.length > available) {
        throw new QueueFullError();
      }
      const bytes = encoder.encode(source).length;
      if (bytes > available) {
        throw new QueueFullError();
      }
      const item = { stanza: element, stamp: datetime() };
      sm.outbound_q.push(item);
      charges.set(item, bytes);
      attempts.set(item, attempt);
      outboundBytes += bytes;
      return {
        rollback() {
          // A late old failure cannot erase a replay or an acknowledged item.
          if (attempts.get(item) !== attempt) {
            return;
          }
          const index = sm.outbound_q.indexOf(item);
          if (index !== -1) {
            sm.outbound_q.splice(index, 1);
            release(item);
          }
        },
      };
    },
    async fail() {
      if (closing) {
        return;
      }
      closing = true;
      sm.id = "";
      session = null;
      sm.enableSent = false;
      clearTimeout(timeoutTimeout);
      clearTimeout(requestAckTimeout);
      clearTimeout(requestAckDebounce);
      sm.enabled = false;
      const failed = takeQueue();
      // Capture the old transport before failure observers can replace it.
      const shutdown = entity._streamError(
        "undefined-condition",
        undefined,
        xml("queue-full", { xmlns: QUEUE_ERRORS }),
      );
      try {
        failQueue(failed);
      } finally {
        await shutdown;
      }
    },
  });

  function release(item) {
    outboundBytes -= charges.get(item) ?? 0;
    charges.delete(item);
    attempts.delete(item);
  }

  entity.on("connecting", () => {
    closing = false;
    enabling = null;
  });

  async function sendAck() {
    try {
      await entity.send(xml("a", { xmlns: NS, h: sm.inbound }));
    } catch {
      // An acknowledgement is best-effort while the stream is closing.
    }
  }

  entity.on("disconnect", () => {
    clearTimeout(timeoutTimeout);
    clearTimeout(requestAckTimeout);
    clearTimeout(requestAckDebounce);
    sm.enabled = false;
    sm.enableSent = false;
    enabling = null;
    enableState.attempted = false;
    if (!session) {
      failQueue();
      sm.inbound = 0;
    }
  });

  // It is RECOMMENDED that initiating entities (usually clients) send an element right before they gracefully close the stream, in order to inform the peer about received stanzas
  entity.hook("close", async () => {
    if (!sm.enabled || closing) {
      return;
    }
    await sendAck();
  });

  async function resumed(resumed, signal, authorizationIdentifier) {
    signal?.throwIfAborted();
    // XEP-0198 §§5/9.2: resumption keeps this session's account and resource.
    const retained = session?.id === sm.id ? session : null;
    const address =
      authorizationIdentifier === undefined ? null : jid(authorizationIdentifier);
    const account = getAccount(entity);
    if (
      !retained?.jid ||
      resumed.attrs.previd !== sm.id ||
      (address &&
        (address.bare().toString() !== retained.account ||
          (address.resource && address.toString() !== retained.jid))) ||
      (account && retained?.account && account !== retained.account)
    ) {
      sm.enabled = false;
      sm.enableSent = false;
      entity._streamError("bad-format").catch(() => {});
      throw new ConnectionClosedError();
    }
    sm.enabled = true;
    ackQueue(resumed.attrs.h);
    signal?.throwIfAborted();
    // Restore only the immutable full identity saved by this exact session.
    if (retained?.jid) {
      entity._jid(retained.jid);
    }
    // A validated resumed stream can replay before the public ready event.
    completeNegotiation(entity);
    const q = [...sm.outbound_q];
    // Keep unacknowledged items owned by SM even if replay is cancelled.
    for (const item of q) {
      signal?.throwIfAborted();
      if (!sm.outbound_q.includes(item)) {
        continue;
      }
      await sendReplay(entity, item, queueToStanza({ entity, item }));
    }
    signal?.throwIfAborted();
    sm.emit("resumed");
    entity._ready(true);
    scheduleRequestAck();
  }

  function failed(element) {
    if (element?.attrs.h !== undefined) {
      ackQueue(element.attrs.h);
    }
    sm.enabled = false;
    sm.enableSent = false;
    sm.id = "";
    session = null;
    failQueue();
  }

  function ackQueue(h) {
    // XEP-0198 h is an XML Schema unsignedInt, not a JS numeric expression.
    const n = Number(h);
    const valid =
      /^[\t\n\r ]*[+-]?[0-9]+[\t\n\r ]*$/.test(h) &&
      Number.isInteger(n) &&
      n >= 0 &&
      n < COUNTER_MODULUS;
    const distance = (n - sm.outbound + COUNTER_MODULUS) % COUNTER_MODULUS;
    if (!valid || distance > sm.outbound_q.length) {
      sm.enabled = false;
      sm.enableSent = false;
      const detail = valid
        ? xml("handled-count-too-high", {
            xmlns: NS,
            h,
            "send-count":
              (sm.outbound + sm.outbound_q.length) % COUNTER_MODULUS,
          })
        : undefined;
      // Validate before consuming the queue or allowing resumption to continue.
      entity
        ._streamError(
          valid ? "undefined-condition" : "bad-format",
          undefined,
          detail,
        )
        .catch(() => {});
      throw new ConnectionClosedError();
    }
    const acknowledged = sm.outbound_q.splice(0, distance);
    sm.outbound = n;
    for (const item of acknowledged) {
      release(item);
    }
    for (const item of acknowledged) {
      sm.emit("ack", item.stanza);
    }
  }

  function takeQueue() {
    const failed = sm.outbound_q.splice(0);
    sm.outbound = 0;
    for (const item of failed) {
      release(item);
    }
    return failed;
  }

  function failQueue(failed = takeQueue()) {
    for (const item of failed) {
      sm.emit("fail", item.stanza);
    }
  }

  function enabled({ id, max, resume }) {
    enabling = null;
    // XEP-0198 §§3/5: ID presence alone does not authorize resumption.
    const resumable =
      /^[\t\n\r ]*(true|1)[\t\n\r ]*$/.test(resume) && id !== undefined;
    sm.enabled = true;
    sm.id = resumable ? id : "";
    session = resumable
      ? { id, account: getAccount(entity), jid: getIdentity(entity) }
      : null;
    sm.max = max;
    // > The counter for the received stanzas ('h') is set to zero and started after receiving either <enable/> or <enabled/>.
    // https://xmpp.org/extensions/xep-0198.html#example-7
    sm.inbound = 0;
    scheduleRequestAck();
  }

  entity.on("offline", () => {
    sm.inbound = 0;
    sm.enabled = false;
    sm.enableSent = false;
    sm.id = "";
    session = null;
    failQueue();
  });

  middleware.use(async (context, next) => {
    const { stanza } = context;
    clearTimeout(timeoutTimeout);
    timeoutTimeout = null;
    if (entity.isStanza(stanza)) {
      sm.inbound = (sm.inbound + 1) % COUNTER_MODULUS;
    } else if (stanza.is("r", NS)) {
      // > When an <r/> element ("request") is received, the recipient MUST acknowledge it by sending an <a/> element to the sender containing a value of 'h' that is equal to the number of stanzas handled by the recipient of the <r/> element.
      await sendAck();
    } else if (stanza.is("a", NS)) {
      if (!sm.enabled) {
        return next();
      }
      // > When a party receives an <a/> element, it SHOULD keep a record of the 'h' value returned as the sequence number of the last handled outbound stanza for the current stream (and discard the previous value).
      ackQueue(stanza.attrs.h);
    }

    scheduleRequestAck();

    return next();
  });

  if (bind2) {
    setupBind2({ bind2, sm, failed, enabled, enableState });
  }
  if (sasl2) {
    setupSasl2({ sasl2, sm, failed, resumed, hasResumeId });
  }

  // Periodically send r to check the connection
  // If a stanza goes out it will cancel this and set a sooner timer
  function scheduleRequestAck(timeout = sm.requestAckInterval) {
    clearTimeout(requestAckTimeout);

    if (!sm.enabled || closing) {
      return;
    }
    if (!timeout) return;

    requestAckTimeout = setTimeout(requestAck, timeout);
  }

  function requestAck() {
    clearTimeout(requestAckTimeout);
    clearTimeout(requestAckDebounce);

    if (!sm.enabled || closing) {
      return;
    }

    if (sm.timeout && !timeoutTimeout) {
      timeoutTimeout = setTimeout(() => {
        clearTimeout(requestAckTimeout);
        entity.disconnect().catch(() => {});
      }, sm.timeout);
    }
    entity.send(xml("r", { xmlns: NS })).catch(() => {});

    scheduleRequestAck();
  }

  middleware.filter((context, next) => {
    const { stanza } = context;
    if (stanza.is("enable", NS)) {
      sm.enableSent = true;
    } else if (
      stanza.is("authenticate", SASL2) &&
      stanza.getChild("bind", BIND2)?.getChild("enable", NS)
    ) {
      // Count sent inline requests, never abandoned asynchronous builders.
      enableState.attempted = true;
    }
    if (!sm.enabled && !sm.enableSent) return next();
    if (!entity.isStanza(stanza)) {
      return next();
    }

    if (closing) {
      return next();
    }
    // Debounce requests so we send only one after a big run of stanza together
    clearTimeout(requestAckTimeout);
    clearTimeout(requestAckDebounce);
    requestAckDebounce = setTimeout(requestAck, sm.requestAckDebounce);

    return next();
  });

  if (streamFeatures) {
    setupStreamFeature({
      streamFeatures,
      sm,
      entity,
      resumed,
      failed,
      enabled,
      hasResumeId,
      enableState,
    });
  }

  return sm;
}

function queueToStanza({ entity, item }) {
  const { stanza, stamp } = item;
  if (
    stanza.name === "message" &&
    !stanza.getChild("delay", "urn:xmpp:delay")
  ) {
    stanza.append(
      xml("delay", {
        xmlns: "urn:xmpp:delay",
        from: entity.jid.toString(),
        stamp,
      }),
    );
  }
  return stanza;
}
