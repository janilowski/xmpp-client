export default class SASLFactory {
  constructor() {
    this._mechs = [];
  }

  use(name, mech) {
    if (!mech) {
      mech = name;
      name = mech?.prototype?.name;
    }

    this._mechs.push({name, mech});
    return this;
  }

  create(mechanisms) {
    for (const entry of this._mechs) {
      for (const mechanism of mechanisms) {
        if (entry.name === mechanism) {
          return new entry.mech();
        }
      }
    }

    return null;
  }
}
