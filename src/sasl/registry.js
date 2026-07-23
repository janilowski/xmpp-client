export default class SASLMechanismRegistry {
  #mechanisms = new Map();

  get names() {
    return [...this.#mechanisms.keys()];
  }

  register(name, create) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("A SASL mechanism must have a name.");
    }
    if (typeof create !== "function") {
      throw new TypeError("A SASL mechanism must have a factory function.");
    }
    if (this.#mechanisms.has(name)) {
      throw new Error(`SASL mechanism ${name} is already registered.`);
    }

    this.#mechanisms.set(name, create);
    return this;
  }

  create(name) {
    return this.#mechanisms.get(name)?.() ?? null;
  }
}
