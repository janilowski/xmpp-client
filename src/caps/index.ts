import parseXML, {
  XML_CONTEXT,
  XML_DIRECTION,
} from "../xml/lib/parseDocument.js";
import isIRI from "../xml/lib/isIRI.js";
import jid from "../jid/index.js";
import { discoState } from "../disco/state.ts";
import { outgoingPresence } from "../connection/lib/outgoingPresence.ts";
import { UnverifiableFormError, verificationString } from "./verification.ts";
import type {
  Caps,
  CapsOptions,
  CapsResult,
  Disco,
  DiscoInfo,
  Element,
  EventEmitter,
  JID,
} from "../../types/index.js";

const CAPS = "http://jabber.org/protocol/caps";
const INFO = "http://jabber.org/protocol/disco#info";
const STREAM = "http://etherx.jabber.org/streams";
const CLIENT = "jabber:client";
// Local resource policies, not protocol maxima or authentication guarantees.
const MAX_PEERS = 128;
const MAX_HINT_BYTES = 64 * 1024;
const MAX_RECORDS = 128;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_QUERIES = 4;
const MAX_JOBS = 64;
const MAX_VERSIONS = 8;
const MAX_ERROR_LENGTH = 512;
const DEFAULT_QUERY_TIMEOUT_MS = 2000;
const encoder = new TextEncoder();
const parseDocument = parseXML as unknown as (
  source: string,
  context?: string,
  direction?: string,
) => Element;

function isSoftwareNode(node: string): boolean {
  if (!isIRI(node)) {
    return false;
  }
  if (!/^https?:/i.test(node)) {
    return true;
  }
  // RFC 9110 requires a host; do not normalize opaque node identifiers as URLs.
  const authority = /^https?:\/\/([^/?#]*)/i.exec(node)?.[1];
  const host = authority?.slice(authority.lastIndexOf("@") + 1);
  return Boolean(host && !host.startsWith(":"));
}

interface Entity extends EventEmitter {
  status: string;
  timeout: number;
  send(element: Element): Promise<void>;
}

interface Advertisement {
  jid: string;
  node: string;
  ver: string;
  hash: string;
}

interface Peer extends Advertisement {
  bytes: number;
  status: CapsResult["status"];
  job: string;
  record?: string;
  error?: string;
}

interface Record {
  source: string;
  info: Omit<DiscoInfo, "query">;
  bytes: number;
  verified: boolean;
}

interface Job {
  key: string;
  epoch: number;
  controller: AbortController;
  source?: Peer;
}

interface Version {
  query: Element;
  ver: string;
}

class EntityCapabilities implements Caps {
  readonly #entity: Entity;
  readonly #disco: Disco;
  readonly #peers = new Map<string, Peer>();
  readonly #records = new Map<string, Record>();
  readonly #jobs = new Map<string, Job>();
  readonly #active = new Set<Job>();
  readonly #versions = new Map<string, true>();
  readonly #presenceRevisions = new WeakMap<Element, number>();
  #presenceRevision = 0;
  #broadcastRevision = 0;
  #bytes = 0;
  #hintBytes = 0;
  #epoch = 0;
  #node = "";
  #local?: Promise<Version>;
  #broadcast?: string;
  #refreshing = false;
  #resuming = false;
  #serverFrom?: string;
  #serverHint?: Advertisement;

  constructor(
    {
      entity,
      disco,
      streamManagement,
    }: {
      entity: Entity;
      disco: Disco;
      streamManagement: EventEmitter;
    },
    options?: CapsOptions,
  ) {
    this.#entity = entity;
    this.#disco = disco;
    if (options === undefined) {
      return;
    }
    const node = options?.node;
    if (typeof node !== "string" || !isSoftwareNode(node)) {
      throw new TypeError("Capabilities need an application software URI");
    }
    const local = discoState.get(disco)!;
    if (local.snapshot().getChildren("identity", INFO).length === 0) {
      throw new TypeError(
        "Capabilities require configured discovery identities",
      );
    }
    this.#node = node;
    local.installFeature(CAPS);
    local.onChange(() => this.#updateLocal());
    this.#updateLocal();
    outgoingPresence.set(entity, (source, original) =>
      this.#prepare(source, original),
    );

    entity.on("send", (element: Element) => {
      const revision = this.#presenceRevisions.get(element);
      this.#presenceRevisions.delete(element);
      if (!element.is("presence", CLIENT) || element.attrs.to) {
        return;
      }
      if (revision !== undefined && revision !== this.#presenceRevision) {
        return;
      }
      if (element.attrs.type === "unavailable") {
        this.#broadcast = undefined;
      } else if (!element.attrs.type) {
        this.#broadcast = element.toString();
        this.#broadcastRevision = this.#presenceRevision;
      }
    });
    entity.on("stanza", (element: Element) => {
      if (!element.is("presence", CLIENT) || entity.status !== "online") {
        return;
      }
      const from = element.attrs.from;
      if (!from) {
        return;
      }
      if (element.attrs.type === "unavailable") {
        try {
          const address = jid(from).toString();
          if (address) {
            this.#removePeer(address);
          }
        } catch {
          // Malformed peer addresses must not escape presence processing.
        }
        return;
      }
      if (element.attrs.type) {
        return;
      }
      const declarations = element.getChildren("c", CAPS);
      if (declarations.length === 1) {
        const hint = this.#advertisement(from, declarations[0]);
        if (hint) {
          this.#accept(hint);
        }
      }
    });
    entity.on("open", (element: Element) => {
      this.#serverFrom = element.attrs.from;
    });
    entity.on("nonza", (element: Element) => {
      if (!element.is("features", STREAM) || !this.#serverFrom) {
        return;
      }
      const declarations = element.getChildren("c", CAPS);
      if (declarations.length === 1) {
        this.#serverHint = this.#advertisement(
          this.#serverFrom,
          declarations[0],
        );
        if (this.#serverHint && entity.status === "online") {
          this.#accept(this.#serverHint);
        }
      }
    });
    streamManagement.on("resumed", () => {
      this.#resuming = true;
    });
    entity.on("status", (status: string) => {
      if (status !== "online" || !this.#resuming) {
        return;
      }
      this.#resuming = false;
      for (const peer of this.#peers.values()) {
        if (peer.status === "pending") {
          this.#enqueue(peer);
        }
      }
      if (this.#serverHint) {
        this.#accept(this.#serverHint);
      }
      this.#refresh();
    });
    entity.on("online", () => {
      this.#clearPeers();
      this.#broadcast = undefined;
      if (this.#serverHint) {
        this.#accept(this.#serverHint);
      }
    });
    entity.on("disconnect", () => {
      this.#cancel();
      this.#serverFrom = undefined;
      this.#serverHint = undefined;
      this.#resuming = false;
    });
    entity.on("offline", () => {
      this.#clearPeers();
      this.#broadcast = undefined;
    });
  }

  get(address: string | JID): CapsResult | undefined {
    const prepared = jid(address.toString()).toString();
    const peer = prepared && this.#peers.get(prepared);
    if (!peer) {
      return;
    }
    const record = peer.record && this.#records.get(peer.record);
    let info: DiscoInfo | undefined;
    if (record) {
      // Keep ancestor namespace declarations without retaining a caller-owned tree.
      const root = parseDocument(record.source);
      const query = root.is("query", INFO)
        ? root
        : root.getChild("query", INFO)!;
      info = {
        ...record.info,
        identities: record.info.identities.map((identity) => ({ ...identity })),
        features: [...record.info.features],
        query,
      };
    }
    return {
      jid: peer.jid,
      node: peer.node,
      ver: peer.ver,
      hash: peer.hash,
      status: peer.status,
      ...(info ? { info } : {}),
      ...(peer.error === undefined ? {} : { error: new Error(peer.error) }),
    };
  }

  #updateLocal(): void {
    const query = discoState.get(this.#disco)!.snapshot();
    this.#local = verificationString(query).then((ver) => ({ query, ver }));
    // A future send observes failures even when no presence is currently owned.
    this.#local.catch(() => {});
    this.#refresh();
  }

  #refresh(): void {
    if (
      this.#refreshing ||
      !this.#broadcast ||
      this.#broadcastRevision !== this.#presenceRevision ||
      this.#entity.status !== "online"
    ) {
      return;
    }
    this.#refreshing = true;
    const epoch = this.#epoch;
    const revision = this.#presenceRevision;
    queueMicrotask(async () => {
      this.#refreshing = false;
      try {
        const version = await this.#currentVersion();
        if (
          epoch !== this.#epoch ||
          revision !== this.#presenceRevision ||
          revision !== this.#broadcastRevision ||
          !this.#broadcast ||
          this.#entity.status !== "online"
        ) {
          return;
        }
        const presence = parseDocument(
          this.#broadcast,
          XML_CONTEXT.XMPP,
          XML_DIRECTION.OUTPUT,
        );
        const previous = presence.getChild("c", CAPS);
        if (
          previous?.attrs.ver === version.ver &&
          previous.attrs.node === this.#node
        ) {
          return;
        }
        // Single-use intent: a later application presence can supersede this refresh.
        this.#presenceRevisions.set(presence, revision);
        await this.#entity.send(presence);
      } catch (error) {
        const superseded =
          revision !== this.#presenceRevision &&
          error instanceof DOMException &&
          error.name === "AbortError";
        if (
          epoch === this.#epoch &&
          !superseded &&
          this.#entity.status === "online"
        ) {
          this.#entity.emit("error", error);
        }
      }
    });
  }

  async #currentVersion(): Promise<Version> {
    let pending;
    let version;
    do {
      pending = this.#local!;
      version = await pending;
    } while (pending !== this.#local);
    return version;
  }

  async #prepare(source: string, original: Element): Promise<Element> {
    const presence = parseDocument(
      source,
      XML_CONTEXT.XMPP,
      XML_DIRECTION.OUTPUT,
    );
    const automatic = this.#presenceRevisions.get(original);
    this.#presenceRevisions.delete(original);
    // Respect the application's latest presence intent before asynchronous hashing.
    if (
      !presence.attrs.to &&
      (!presence.attrs.type || presence.attrs.type === "unavailable")
    ) {
      if (automatic === undefined) {
        this.#presenceRevision++;
      }
      if (presence.attrs.type === "unavailable") {
        this.#broadcast = undefined;
      }
    }
    const revision = automatic ?? this.#presenceRevision;
    const version = await this.#currentVersion();
    if (automatic !== undefined && automatic !== this.#presenceRevision) {
      throw new DOMException("Presence refresh was superseded", "AbortError");
    }
    const node = `${this.#node}#${version.ver}`;
    if (!this.#versions.has(node)) {
      discoState.get(this.#disco)!.setNode(node, {
        identities: version.query
          .getChildren("identity", INFO)
          .map(({ attrs }) => ({
            category: attrs.category,
            type: attrs.type,
            name: attrs.name,
            lang: attrs["xml:lang"],
          })),
        features: version.query
          .getChildren("feature", INFO)
          .map(({ attrs }) => attrs.var),
      });
    }
    this.#versions.delete(node);
    this.#versions.set(node, true);
    while (this.#versions.size > MAX_VERSIONS) {
      const oldest = this.#versions.keys().next().value!;
      this.#versions.delete(oldest);
      discoState.get(this.#disco)!.removeNode(oldest);
    }
    presence.children = presence.children.filter(
      (child) => typeof child !== "object" || !child.is("c", CAPS),
    );
    presence.c("c", {
      xmlns: CAPS,
      node: this.#node,
      ver: version.ver,
      hash: "sha-1",
    });
    this.#presenceRevisions.set(presence, revision);
    return presence;
  }

  #advertisement(from: string, element: Element): Advertisement | undefined {
    const { node, ver, hash } = element.attrs;
    if (
      !node ||
      !ver ||
      !hash ||
      from.length + node.length + ver.length + hash.length > MAX_HINT_BYTES ||
      !isSoftwareNode(node) ||
      element.children.length !== 0
    ) {
      return;
    }
    try {
      const address = jid(from).toString();
      if (address) {
        return { jid: address, node, ver, hash };
      }
    } catch {
      return;
    }
  }

  #accept(hint: Advertisement): void {
    const bytes = encoder.encode(
      JSON.stringify([hint.jid, hint.node, hint.ver, hint.hash]),
    ).length;
    if (bytes > MAX_HINT_BYTES) {
      return;
    }
    const previous = this.#peers.get(hint.jid);
    if (
      previous &&
      previous.node === hint.node &&
      previous.ver === hint.ver &&
      previous.hash === hint.hash &&
      !(
        previous.status === "unverified" &&
        !previous.record &&
        !this.#jobs.has(previous.job)
      )
    ) {
      return;
    }
    this.#removePeer(hint.jid);
    while (
      this.#peers.size >= MAX_PEERS ||
      this.#hintBytes + bytes > MAX_HINT_BYTES
    ) {
      this.#removePeer(this.#peers.keys().next().value!);
    }
    const supported = hint.hash === "sha-1" || hint.hash === "sha-256";
    const key = JSON.stringify([hint.hash, hint.ver]);
    const peer: Peer = {
      ...hint,
      bytes,
      job: supported
        ? key
        : JSON.stringify([hint.jid, hint.hash, hint.node, hint.ver]),
      status: "pending",
    };
    this.#peers.set(peer.jid, peer);
    this.#hintBytes += bytes;
    if (supported && this.#records.get(key)?.verified) {
      this.#settle(peer, "verified", key);
      return;
    }
    this.#notify(peer);
    this.#enqueue(peer);
  }

  #enqueue(peer: Peer): void {
    if (this.#jobs.has(peer.job)) {
      return;
    }
    if (this.#jobs.size >= MAX_JOBS) {
      this.#settle(
        peer,
        "unverified",
        undefined,
        new Error("Capabilities query queue is full"),
      );
      return;
    }
    this.#jobs.set(peer.job, {
      key: peer.job,
      epoch: this.#epoch,
      controller: new AbortController(),
    });
    this.#pump();
  }

  #pump(): void {
    if (this.#entity.status !== "online") {
      return;
    }
    for (const job of this.#jobs.values()) {
      if (this.#active.size >= MAX_QUERIES) {
        break;
      }
      if (this.#active.has(job)) {
        continue;
      }
      this.#active.add(job);
      this.#run(job)
        .finally(() => {
          this.#active.delete(job);
          if (this.#jobs.get(job.key) === job) {
            this.#jobs.delete(job.key);
          }
          this.#pump();
        })
        .catch(() => {});
    }
  }

  async #run(job: Job): Promise<void> {
    while (job.epoch === this.#epoch) {
      const peer = [...this.#peers.values()].find(
        (entry) => entry.job === job.key && entry.status === "pending",
      );
      if (!peer) {
        return;
      }
      job.source = peer;
      job.controller = new AbortController();
      let info;
      try {
        info = await this.#disco.info(peer.jid, {
          node: `${peer.node}#${peer.ver}`,
          signal: job.controller.signal,
          timeout:
            Number.isFinite(this.#entity.timeout) && this.#entity.timeout > 0
              ? this.#entity.timeout
              : DEFAULT_QUERY_TIMEOUT_MS,
        });
      } catch (error) {
        if (job.epoch === this.#epoch && this.#peers.get(peer.jid) === peer) {
          this.#settle(
            peer,
            error instanceof TypeError ? "invalid" : "unverified",
            undefined,
            error,
          );
        }
        continue;
      }
      if (job.epoch !== this.#epoch || this.#peers.get(peer.jid) !== peer) {
        continue;
      }
      const supported = peer.hash === "sha-1" || peer.hash === "sha-256";
      let status: CapsResult["status"] = "unverified";
      let failure;
      if (supported) {
        try {
          const reconstructed = await verificationString(
            info.query,
            peer.hash as "sha-1" | "sha-256",
          );
          if (reconstructed !== peer.ver) {
            throw new TypeError(
              "Capability verification string does not match",
            );
          }
          status = "verified";
        } catch (error) {
          failure = error;
          status =
            error instanceof UnverifiableFormError ? "unverified" : "invalid";
        }
      }
      if (job.epoch !== this.#epoch || this.#peers.get(peer.jid) !== peer) {
        continue;
      }
      if (status === "invalid") {
        this.#settle(peer, status, undefined, failure);
        continue;
      }
      const key =
        status === "verified" ? job.key : JSON.stringify([peer.jid, peer.job]);
      if (!this.#store(key, info, status)) {
        this.#settle(
          peer,
          "unverified",
          undefined,
          new Error("Capabilities exceed the cache budget"),
        );
        continue;
      }
      if (status === "verified") {
        for (const candidate of this.#peers.values()) {
          if (candidate.job === job.key) {
            this.#settle(candidate, "verified", key);
          }
        }
        return;
      }
      this.#settle(peer, "unverified", key, failure);
    }
  }

  #store(key: string, info: DiscoInfo, status: CapsResult["status"]): boolean {
    const source = info.query.root().toString();
    const bytes = encoder.encode(source).length;
    if (bytes > MAX_CACHE_BYTES) {
      return false;
    }
    const previous = this.#records.get(key);
    if (previous) {
      this.#bytes -= previous.bytes;
      this.#records.delete(key);
    }
    while (
      this.#records.size >= MAX_RECORDS ||
      this.#bytes + bytes > MAX_CACHE_BYTES
    ) {
      const oldest = this.#records.keys().next().value!;
      this.#bytes -= this.#records.get(oldest)!.bytes;
      this.#records.delete(oldest);
      for (const peer of this.#peers.values()) {
        if (peer.record === oldest) {
          this.#settle(
            peer,
            "unverified",
            undefined,
            new Error("Capabilities were evicted from the cache"),
          );
        }
      }
    }
    this.#records.set(key, {
      source,
      bytes,
      verified: status === "verified",
      info: {
        identities: info.identities.map((identity) => ({ ...identity })),
        features: [...info.features],
        ...(info.node === undefined ? {} : { node: info.node }),
      },
    });
    this.#bytes += bytes;
    return true;
  }

  #settle(
    peer: Peer,
    status: CapsResult["status"],
    record?: string,
    error?: unknown,
  ): void {
    peer.status = status;
    peer.record = record;
    peer.error =
      error === undefined
        ? undefined
        : (error instanceof Error ? error.message : String(error)).slice(
            0,
            MAX_ERROR_LENGTH,
          );
    this.#notify(peer);
  }

  #notify(peer: Peer): void {
    const epoch = this.#epoch;
    queueMicrotask(() => {
      if (epoch === this.#epoch && this.#peers.get(peer.jid) === peer) {
        this.#entity.emit("capabilities", this.get(peer.jid));
      }
    });
  }

  #removePeer(address: string): void {
    const peer = this.#peers.get(address);
    if (!peer) {
      return;
    }
    this.#hintBytes -= peer.bytes;
    this.#peers.delete(address);
    if (peer?.record) {
      const record = this.#records.get(peer.record);
      if (record && !record.verified) {
        this.#bytes -= record.bytes;
        this.#records.delete(peer.record);
      }
    }
    for (const job of this.#active) {
      if (job.source === peer) {
        job.controller.abort();
      }
    }
  }

  #cancel(): void {
    this.#epoch++;
    for (const job of this.#jobs.values()) {
      job.controller.abort();
    }
    this.#jobs.clear();
    // Aborted IQs settle promptly; uncancellable digests still own their slots.
  }

  #clearPeers(): void {
    this.#cancel();
    for (const address of this.#peers.keys()) {
      this.#removePeer(address);
    }
  }
}

export default function caps(
  dependencies: ConstructorParameters<typeof EntityCapabilities>[0],
  options?: CapsOptions,
): Caps {
  return new EntityCapabilities(dependencies, options);
}
