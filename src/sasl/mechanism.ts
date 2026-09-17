type Awaitable<T> = T | PromiseLike<T>;

// Internal exchange inputs; each mechanism retains its runtime validation.
export interface SASLCredentials {
  username?: string | null;
  password?: string | null;
  authzid?: string | null;
  trace?: string | null;
  server?: string;
  host?: string;
  realm?: string;
  serviceType?: string;
  serviceName?: string;
}

// RFC 4422 §§3.4, 3.6: exchanges and final data are mechanism-specific.
// Text/byte decoding and nullable responses describe the existing local API.
interface MechanismExchange<Data> {
  name: string;
  clientFirst: boolean;
  response: (
    credentials: SASLCredentials,
  ) => Awaitable<string | Uint8Array | null | undefined>;
  challenge?: (data: Data) => Awaitable<void>;
  final?: (data: Data) => Awaitable<void>;
}

export type SASLMechanism =
  | (MechanismExchange<string> & { binary?: false })
  | (MechanismExchange<Uint8Array> & { binary: true });

export type SASLMechanismFactory = () => SASLMechanism;
