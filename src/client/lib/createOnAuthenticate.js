import SASLError from "../../sasl/lib/SASLError.js";

const ANONYMOUS = "ANONYMOUS";
const PLAIN = "PLAIN";

export default function createOnAuthenticate(credentials, userAgent) {
  return async function onAuthenticate(...args) {
    const [authenticate, mechanisms, fast, entity] = args;

    if (typeof credentials === "function") {
      let authenticated = false;

      // A custom credential provider must obey the same selection boundaries.
      await credentials(
        async (values, mechanism, agent) => {
          // FAST-only authentication has no ordinary fallback mechanism.
          if (!(mechanism == null && fast) && !mechanisms.includes(mechanism)) {
            throw new SASLError("SASL: Mechanism not offered by the server.");
          }
          if (mechanism === PLAIN && !entity.isSecure()) {
            throw new SASLError("SASL: PLAIN requires a secure transport.");
          }
          const result = await authenticate(values, mechanism, agent);
          authenticated = true;
          return result;
        },
        mechanisms,
        fast,
        entity,
      );
      if (!authenticated) {
        throw new SASLError("SASL authentication did not complete.");
      }
      return;
    }

    credentials.token ??= await fast?.fetch();

    const mechanism = getMechanism({ mechanisms, entity, credentials });
    await authenticate(credentials, mechanism, userAgent);
  };
}

export function getMechanism({ mechanisms, entity, credentials }) {
  if (
    !credentials?.username &&
    !credentials?.password &&
    !credentials?.token &&
    mechanisms.includes(ANONYMOUS)
  ) {
    return ANONYMOUS;
  }

  if (entity.isSecure()) return mechanisms[0];

  return mechanisms.find((mechanism) => mechanism !== PLAIN);
}
