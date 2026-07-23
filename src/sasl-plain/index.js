const NAME = "PLAIN";

export default function registerPlain(saslMechanisms) {
  saslMechanisms.register(NAME, () => ({
    name: NAME,
    clientFirst: true,
    challenge() {},
    response({ authzid, username, password }) {
      const authorizationIdentity = authzid ? String(authzid) : "";
      return [
        authorizationIdentity,
        String(username),
        String(password),
      ].join("\0");
    },
  }));
}
