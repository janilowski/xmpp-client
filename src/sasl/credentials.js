import jid from "../jid/index.js";

// RFC 6120 §§6.3.7–6.3.9: authcid is mechanism-specific; authzid is a bare
// client JID. A realm must come from the caller/server, never from the domain.
export default function prepareCredentials(entity, credentials) {
  const { domain } = entity.options;
  const values = {
    username: null,
    password: null,
    server: domain,
    host: domain,
    serviceType: "xmpp",
    serviceName: domain,
    ...credentials,
  };
  if (values.authzid) {
    const identity = jid(values.authzid);
    if (!identity.local || identity.resource) {
      throw new Error("SASL: Authorization identity must be a bare JID");
    }
    values.authzid = identity.toString();
  }
  return values;
}
