import mech from "./mechanism.js";

export default function saslPlain(sasl) {
  sasl.use(mech);
}
