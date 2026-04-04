export default class AnonymousMechanism {
  get name() {
    return "ANONYMOUS";
  }

  get clientFirst() {
    return true;
  }

  response(credentials) {
    return credentials.trace || "";
  }

  challenge() {}
}
