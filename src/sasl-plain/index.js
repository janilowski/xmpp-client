const NAME = "PLAIN";
const INVALID_VALUE = /[\0\uD800-\uDFFF]/u;

export default function registerPlain(saslMechanisms) {
  saslMechanisms.register(NAME, () => ({
    name: NAME,
    clientFirst: true,
    challenge() {},
    response({ authzid, username, password }) {
      if (
        typeof username !== "string" ||
        username === "" ||
        INVALID_VALUE.test(username) ||
        typeof password !== "string" ||
        password === "" ||
        INVALID_VALUE.test(password) ||
        (authzid !== undefined &&
          authzid !== null &&
          authzid !== "" &&
          (typeof authzid !== "string" || INVALID_VALUE.test(authzid)))
      ) {
        throw new Error("PLAIN: invalid credentials");
      }

      return [authzid || "", username, password].join("\0");
    },
  }));
}
