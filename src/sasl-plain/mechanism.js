export default class PlainMechanism {
  get name() {
    return "PLAIN";
  }

  get clientFirst() {
    return true;
  }

  response(credentials) {
    return `${credentials.authzid || ""}\0${credentials.username}\0${credentials.password}`;
  }

  challenge() {
    return this;
  }
}
