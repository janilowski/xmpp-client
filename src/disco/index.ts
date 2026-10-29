import xmlFactory from "../xml/index.js";
import jid from "../jid/index.js";
import isLanguageTag from "../xml/lib/language.js";
import { validateDocument, XML_CONTEXT } from "../xml/lib/parseDocument.js";
import { discoState } from "./state.ts";
import type {
  Disco,
  DiscoIdentity,
  DiscoInfo,
  DiscoItem,
  DiscoItems,
  DiscoNode,
  DiscoOptions,
  DiscoQueryOptions,
  Element,
  IQCaller,
  IQCallee,
  IQContext,
  JID,
  XMLFactory,
} from "../../types/index.js";

const INFO = "http://jabber.org/protocol/disco#info";
const ITEMS = "http://jabber.org/protocol/disco#items";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const xml: (...args: Parameters<XMLFactory>) => Element = xmlFactory;

interface NodeData {
  identities: DiscoIdentity[];
  features: Set<string>;
  items: DiscoItem[];
}

// Nodes and feature identifiers are opaque strings, not URLs or pathnames.
function validateIdentifier(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Expected a nonempty discovery identifier");
  }
  validateDocument(
    xml("value", { value }).toString(),
    XML_CONTEXT.XMPP,
    undefined,
    undefined,
    undefined,
  );
}

function copyIdentities(values: readonly DiscoIdentity[]): DiscoIdentity[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("Discovery information needs an identity");
  }
  const names = new Map<string, string>();
  return values.map((value: DiscoIdentity) => {
    const { category, type, name, lang } = value;
    validateIdentifier(category);
    validateIdentifier(type);
    if (
      (name !== undefined && typeof name !== "string") ||
      (lang !== undefined && typeof lang !== "string") ||
      (lang !== undefined && lang !== "" && !isLanguageTag(lang)) ||
      (category === "hierarchy" && type !== "branch" && type !== "leaf")
    ) {
      throw new TypeError("Invalid discovery identity");
    }
    const key = JSON.stringify([category, type, lang ?? ""]);
    if (names.has(key) && names.get(key) !== (name ?? "")) {
      throw new TypeError("Conflicting discovery identity names");
    }
    names.set(key, name ?? "");
    const identity = {
      category,
      type,
      ...(name === undefined ? {} : { name }),
      ...(lang === undefined ? {} : { lang }),
    };
    validateDocument(
      xml("identity", { category, type, name, "xml:lang": lang }).toString(),
      XML_CONTEXT.XMPP,
      undefined,
      undefined,
      undefined,
    );
    return identity;
  });
}

function copyItems(values: readonly DiscoItem[]): DiscoItem[] {
  if (!Array.isArray(values)) {
    throw new TypeError("Expected discovery items");
  }
  return values.map((value: DiscoItem) => {
    const { jid: address, node, name } = value;
    if (
      typeof address !== "string" ||
      (name !== undefined && typeof name !== "string")
    ) {
      throw new TypeError("Invalid discovery item");
    }
    if (node !== undefined) {
      validateIdentifier(node);
    }
    const prepared = jid(address).toString();
    if (!prepared) {
      throw new TypeError("Invalid discovery item JID");
    }
    const item = {
      jid: prepared,
      ...(node === undefined ? {} : { node }),
      ...(name === undefined ? {} : { name }),
    };
    validateDocument(
      xml("item", item).toString(),
      XML_CONTEXT.XMPP,
      undefined,
      undefined,
      undefined,
    );
    return item;
  });
}

// Local snapshots deduplicate owned records. Remote duplicates stay observable.
function prepareNode(value: DiscoNode): NodeData {
  const identities = copyIdentities(value.identities);
  const features = value.features ?? [];
  if (!Array.isArray(features)) {
    throw new TypeError("Expected discovery features");
  }
  for (const feature of features) {
    validateIdentifier(feature);
  }
  const items = copyItems(value.items ?? []);
  return {
    identities: [
      ...new Map(
        identities.map((identity) => [
          JSON.stringify([
            identity.category,
            identity.type,
            identity.lang ?? "",
          ]),
          identity,
        ]),
      ).values(),
    ],
    features: new Set(features),
    items: [
      ...new Map(
        items.map((item) => [JSON.stringify([item.jid, item.node]), item]),
      ).values(),
    ],
  };
}

class ServiceDiscovery implements Disco {
  readonly #caller: IQCaller;
  readonly #authorize: DiscoOptions["authorize"];
  readonly #nodes = new Map<string | undefined, NodeData>();
  readonly #installedNodes = new Map<string, NodeData>();
  readonly #rootFeatures: Set<string>;
  readonly #listeners = new Set<() => void>();

  constructor(
    {
      iqCaller,
      iqCallee,
      features = [],
    }: {
      iqCaller: IQCaller;
      iqCallee: IQCallee;
      features?: readonly string[];
    },
    options?: DiscoOptions,
  ) {
    this.#caller = iqCaller;
    this.#authorize = options?.authorize;
    if (
      this.#authorize !== undefined &&
      typeof this.#authorize !== "function"
    ) {
      throw new TypeError("Expected a discovery authorization function");
    }
    this.#rootFeatures = new Set([INFO, ITEMS, ...features]);
    this.#nodes.set(
      undefined,
      options === undefined
        ? { identities: [], features: new Set(), items: [] }
        : prepareNode(options),
    );
    discoState.set(this, {
      snapshot: () => this.#information(undefined, this.#getNode()),
      onChange: (listener) => {
        this.#listeners.add(listener);
        return () => {
          this.#listeners.delete(listener);
        };
      },
      installFeature: (feature) => {
        validateIdentifier(feature);
        this.#change(undefined, () => {
          this.#rootFeatures.add(feature);
        });
      },
      setNode: (node, value) => {
        validateIdentifier(node);
        if (this.#nodes.has(node)) {
          throw new TypeError("Discovery node belongs to the application");
        }
        this.#installedNodes.set(node, prepareNode(value));
      },
      removeNode: (node) => {
        validateIdentifier(node);
        this.#installedNodes.delete(node);
      },
    });
    iqCallee.get(INFO, "query", (context) => this.#respond("info", context));
    iqCallee.get(ITEMS, "query", (context) => this.#respond("items", context));
  }

  #getNode(node?: string): NodeData {
    if (node !== undefined) {
      validateIdentifier(node);
      if (this.#installedNodes.has(node)) {
        throw new TypeError("Cannot modify an installed discovery node");
      }
    }
    const value = this.#nodes.get(node);
    if (!value) {
      throw new TypeError("Unknown discovery node");
    }
    return value;
  }

  setIdentities(identities: readonly DiscoIdentity[], node?: string): void {
    const current = this.#getNode(node);
    const prepared = prepareNode({ identities }).identities;
    this.#change(node, () => {
      current.identities = prepared;
    });
  }

  addFeature(feature: string, node?: string): void {
    validateIdentifier(feature);
    const current = this.#getNode(node);
    this.#change(node, () => {
      current.features.add(feature);
    });
  }

  removeFeature(feature: string, node?: string): void {
    validateIdentifier(feature);
    const current = this.#getNode(node);
    if (
      feature === INFO ||
      feature === ITEMS ||
      (node === undefined && this.#rootFeatures.has(feature))
    ) {
      throw new TypeError("Cannot remove an installed discovery feature");
    }
    this.#change(node, () => {
      current.features.delete(feature);
    });
  }

  // Only root info affects advertised caps; items and named nodes are separate.
  #change(node: string | undefined, apply: () => void): void {
    if (node !== undefined || this.#listeners.size === 0) {
      apply();
      return;
    }
    const before = this.#information(undefined, this.#getNode()).toString();
    apply();
    if (before === this.#information(undefined, this.#getNode()).toString()) {
      return;
    }
    for (const listener of this.#listeners) {
      listener();
    }
  }

  setItems(items: readonly DiscoItem[], node?: string): void {
    const current = this.#getNode(node);
    const copies = copyItems(items);
    current.items = [
      ...new Map(
        copies.map((item) => [JSON.stringify([item.jid, item.node]), item]),
      ).values(),
    ];
  }

  setNode(node: string, value: DiscoNode): void {
    validateIdentifier(node);
    if (this.#installedNodes.has(node)) {
      throw new TypeError("Cannot modify an installed discovery node");
    }
    this.#nodes.set(node, prepareNode(value));
  }

  removeNode(node: string): void {
    validateIdentifier(node);
    if (this.#installedNodes.has(node)) {
      throw new TypeError("Cannot modify an installed discovery node");
    }
    this.#nodes.delete(node);
  }

  #respond(type: "info" | "items", { element, stanza }: IQContext): Element {
    const node = element.attrs.node;
    const error = (condition: string, errorType = "cancel") =>
      xml("error", { type: errorType }, xml(condition, { xmlns: STANZAS }));
    // XEP-0030 §§3–4 requests are empty. Never treat an empty node as the root.
    if (element.children.length !== 0 || node === "") {
      return error("bad-request", "modify");
    }
    if (
      this.#authorize &&
      this.#authorize({
        type,
        node,
        from: stanza.attrs.from,
        to: stanza.attrs.to,
      }) !== true
    ) {
      return error("service-unavailable");
    }
    const value = this.#nodes.get(node) ?? this.#installedNodes.get(node);
    if (!value) {
      return error("item-not-found");
    }
    if (type === "items") {
      return xml(
        "query",
        { xmlns: ITEMS, node },
        ...value.items.map((item) => xml("item", { ...item })),
      );
    }
    if (value.identities.length === 0) {
      return error("service-unavailable");
    }
    return this.#information(node, value);
  }

  #information(node: string | undefined, value: NodeData): Element {
    const features = new Set(
      node === undefined ? this.#rootFeatures : [INFO, ITEMS],
    );
    for (const feature of value.features) {
      features.add(feature);
    }
    return xml(
      "query",
      { xmlns: INFO, node },
      ...value.identities.map(({ category, type, name, lang }) =>
        xml("identity", { category, type, name, "xml:lang": lang }),
      ),
      ...[...features].map((feature) => xml("feature", { var: feature })),
    );
  }

  async #request(
    namespace: string,
    to: string | JID | undefined,
    { node, timeout, signal }: DiscoQueryOptions,
  ): Promise<Element> {
    if (node !== undefined) {
      validateIdentifier(node);
    }
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
    ) {
      throw new TypeError("Invalid discovery timeout");
    }
    const stanza = await this.#caller.request(
      xml("iq", { type: "get", to }, xml("query", { xmlns: namespace, node })),
      timeout,
      signal,
    );
    const children = stanza.getChildElements();
    const query = children[0];
    if (
      children.length !== 1 ||
      !query?.is("query", namespace) ||
      query.attrs.node !== node ||
      query.getText().trim()
    ) {
      throw new TypeError("Invalid discovery response");
    }
    return query;
  }

  async info(
    to?: string | JID,
    options: DiscoQueryOptions = {},
  ): Promise<DiscoInfo> {
    const query = await this.#request(INFO, to, options);
    const identities = copyIdentities(
      query.getChildren("identity", INFO).map((element) => ({
        category: element.attrs.category,
        type: element.attrs.type,
        ...(element.attrs.name === undefined
          ? {}
          : { name: element.attrs.name }),
        ...(element.attrs["xml:lang"] === undefined
          ? {}
          : { lang: element.attrs["xml:lang"] }),
      })),
    );
    const features = query.getChildren("feature", INFO).map((element) => {
      if (element.children.length !== 0) {
        throw new TypeError("Discovery features must be empty");
      }
      validateIdentifier(element.attrs.var);
      return element.attrs.var;
    });
    // XEP-0030 §3.1 inference must not alter data later hashed for XEP-0115.
    if (!features.includes(INFO)) {
      features.push(INFO);
    }
    return {
      identities,
      features,
      query,
      ...(query.attrs.node === undefined ? {} : { node: query.attrs.node }),
    };
  }

  async items(
    to?: string | JID,
    options: DiscoQueryOptions = {},
  ): Promise<DiscoItems> {
    const query = await this.#request(ITEMS, to, options);
    const items = copyItems(
      query.getChildren("item", ITEMS).map((element) => {
        // §4.1 permits foreign XML, not character data or disco-owned children.
        if (
          element.children.some(
            (child) => typeof child !== "object" || child.getNS() === ITEMS,
          )
        ) {
          throw new TypeError("Invalid discovery item content");
        }
        return {
          jid: element.attrs.jid,
          ...(element.attrs.node === undefined
            ? {}
            : { node: element.attrs.node }),
          ...(element.attrs.name === undefined
            ? {}
            : { name: element.attrs.name }),
        };
      }),
    );
    return {
      items,
      query,
      ...(query.attrs.node === undefined ? {} : { node: query.attrs.node }),
    };
  }
}

export default function disco(
  dependencies: ConstructorParameters<typeof ServiceDiscovery>[0],
  options?: DiscoOptions,
): Disco {
  return new ServiceDiscovery(dependencies, options);
}
