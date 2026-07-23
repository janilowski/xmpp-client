export type Awaitable<T> = T | PromiseLike<T>;

export interface EventEmitter {
  addListener<Arguments extends unknown[]>(
    eventName: string | symbol,
    listener: (...arguments_: Arguments) => void,
  ): this;
  on<Arguments extends unknown[]>(
    eventName: string | symbol,
    listener: (...arguments_: Arguments) => void,
  ): this;
  once<Arguments extends unknown[]>(
    eventName: string | symbol,
    listener: (...arguments_: Arguments) => void,
  ): this;
  removeListener<Arguments extends unknown[]>(
    eventName: string | symbol,
    listener: (...arguments_: Arguments) => void,
  ): this;
  off<Arguments extends unknown[]>(
    eventName: string | symbol,
    listener: (...arguments_: Arguments) => void,
  ): this;
  removeAllListeners(eventName?: string | symbol): this;
  emit(eventName: string | symbol, ...arguments_: unknown[]): boolean;
  listenerCount(eventName: string | symbol): number;
}

export type XMLAttributeValue =
  string | number | boolean | JID | null | undefined;

export type XMLAttributes = Record<string, XMLAttributeValue>;

export type XMLChild =
  Element | string | number | boolean | null | undefined | XMLChild[];

export interface Element {
  name: string;
  parent: Element | null;
  children: Array<Element | string | number>;
  attrs: Record<string, string>;

  is(name: string, xmlns?: string): boolean;
  getName(): string;
  getNS(): string | undefined;
  getAttr(name: string, xmlns?: string): string | null | undefined;
  getChild(name: string, xmlns?: string): Element | undefined;
  getChildren(name: string, xmlns?: string): Element[];
  getChildElements(): Element[];
  getChildText(name: string, xmlns?: string): string | null;
  getText(): string;
  root(): Element;
  up(): Element;
  c(name: string, attrs?: XMLAttributes | string): Element;
  cnode<T extends Element | string | number>(child: T): T;
  append(...nodes: Array<Element | string | number>): void;
  prepend(...nodes: Array<Element | string | number>): void;
  t(text: string | number): Element;
  remove(element: Element): Element;
  remove(name: string, xmlns?: string): Element;
  text(value?: string): Element | string;
  attr(name: string): string | undefined;
  attr(name: string, value: XMLAttributeValue): Element;
  toString(): string;
}

export interface ElementConstructor {
  new (name: string, attrs?: XMLAttributes | string): Element;
}

export interface XMLFactory {
  (
    name: string,
    attrs?: XMLAttributes | string | null,
    ...children: XMLChild[]
  ): Element;
  Element: ElementConstructor;
  createElement: XMLFactory;
  xml: XMLFactory;
  escapeXML(value: string): string;
  unescapeXML(value: string): string;
  escapeXMLText(value: string): string;
  unescapeXMLText(value: string): string;
}

export interface JID {
  local: string;
  domain: string;
  resource: string;
  bare(): JID;
  equals(other: JID): boolean;
  getLocal(unescape?: boolean): string;
  getDomain(): string;
  getResource(): string;
  setLocal(local: string, escape?: boolean): JID;
  setDomain(domain: string): JID;
  setResource(resource: string): JID;
  toString(unescape?: boolean): string;
}

export interface JIDConstructor {
  new (local: string | null, domain: string, resource?: string | null): JID;
}

export interface JIDFactory {
  (address: string): JID;
  (local: string | null, domain: string, resource?: string | null): JID;
  jid: JIDFactory;
  JID: JIDConstructor;
  parse(address: string): JID;
  equal(a: JID, b: JID): boolean;
  detectEscape(local: string): boolean;
  escapeLocal(local: string): string;
  unescapeLocal(local: string): string;
}

export interface FastToken {
  mechanism: string;
  token: string;
  expiry: string;
}

export interface Credentials {
  username?: string;
  password?: string;
  token?: FastToken;
}

export type Authenticate = (
  credentials: Credentials,
  mechanism: string,
  userAgent?: Element,
) => Promise<void>;

export type CredentialsProvider = (
  authenticate: Authenticate,
  mechanisms: string[],
  fast: unknown,
  client: XMPPClient,
) => Awaitable<void>;

export interface ClientOptions {
  service?: string;
  domain?: string;
  lang?: string;
  resource?: string | (() => Awaitable<string>);
  username?: string;
  password?: string;
  credentials?: Credentials | CredentialsProvider;
  userAgent?: Element;
  timeout?: number;
}

export type ConnectionStatus =
  | "offline"
  | "connecting"
  | "connect"
  | "opening"
  | "open"
  | "online"
  | "closing"
  | "close"
  | "disconnecting"
  | "disconnect";

export interface ReconnectController extends EventEmitter {
  delay: number;
  reconnect(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface XMPPClient extends EventEmitter {
  jid: JID | null;
  status: ConnectionStatus;
  readonly options: ClientOptions;
  readonly reconnect: ReconnectController;

  start(): Promise<JID>;
  stop(): Promise<Element | undefined>;
  disconnect(): Promise<Element | undefined>;
  send(element: Element): Promise<void>;
  sendMany(elements: Iterable<Element>): Promise<void>;
  sendReceive(element: Element, timeout?: number): Promise<Element>;
  isSecure(): boolean;
  hook(event: "close", handler: () => Awaitable<void>): void;
  unhook(event: "close", handler: () => Awaitable<void>): void;
}

export interface ClientFactory {
  (options?: ClientOptions): XMPPClient;
}

export declare const client: ClientFactory;
export declare const jid: JIDFactory;
export declare const xml: XMLFactory;
