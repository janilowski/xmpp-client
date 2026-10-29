import type { Disco, DiscoNode, Element } from "../../types/index.js";

// Other protocol modules can observe owned information, never the mutable registry.
export const discoState = new WeakMap<
  Disco,
  {
    snapshot(): Element;
    onChange(listener: () => void): () => void;
    installFeature(feature: string): void;
    setNode(node: string, value: DiscoNode): void;
    removeNode(node: string): void;
  }
>();
