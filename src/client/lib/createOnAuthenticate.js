import SASLError from "../../sasl/lib/SASLError.js";

const ANONYMOUS = "ANONYMOUS";
const PLAIN = "PLAIN";

export default function createOnAuthenticate(credentials, userAgent) {
  return async function onAuthenticate(...args) {
    const [authenticate, mechanisms, fast, entity] = args;
    const socket = entity.socket;

    try {
      if (typeof credentials === "function") {
        let authenticated = false;
        let authenticating = false;

        // A custom credential provider must obey the same selection boundaries.
        await credentials(
          async (values, mechanism, agent) => {
            if (authenticating || authenticated) {
              throw new SASLError(
                "SASL: Exchange already started or completed",
              );
            }
            // FAST-only authentication has no ordinary fallback mechanism.
            if (
              !(mechanism == null && fast) &&
              !mechanisms.includes(mechanism)
            ) {
              throw new SASLError("SASL: Mechanism not offered by the server.");
            }
            if (mechanism === PLAIN && !entity.isSecure()) {
              throw new SASLError("SASL: PLAIN requires a secure transport.");
            }
            if (mechanism === PLAIN && mechanisms.indexOf(PLAIN) > 0) {
              throw new SASLError(
                "SASL: Use a preferred mechanism before PLAIN",
              );
            }
            authenticating = true;
            try {
              const result = await authenticate(values, mechanism, agent);
              authenticated = true;
              return result;
            } finally {
              authenticating = false;
            }
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
    } catch (error) {
      // RFC 6120 §6.4.5: exhausted attempts close, but never a replacement socket.
      if (socket && entity.socket === socket) {
        entity.disconnect().catch(() => {});
      }
      throw error;
    }
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
