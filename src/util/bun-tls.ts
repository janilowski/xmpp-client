import type { ConnectionOptions } from "node:tls";

// RFC 9525 §§2, 6.3; RFC 10015 §4: tighten Bun's compatibility defaults
// on the same verified connection, without changing browser-owned TLS.
const NO_RSA_KEY_EXCHANGE = "!kRSA";
// RFC 9325 §4.2: Bun has no EtM or generic CBC selector. Exclude its
// CBC-SHA1 MAC suites and both explicitly supported CBC-SHA256 suites.
const NO_CBC_CIPHERS =
  "!SHA1:!ECDHE-RSA-AES128-SHA256:!ECDHE-ECDSA-AES128-SHA256";
// RFC 9155 §2: Bun 1.4.4's native order without SHA-1. BoringSSL has no
// defaults-minus-hash expression; actual-offer tests detect upstream drift.
const SIGNATURE_ALGORITHMS = [
  "ecdsa_secp256r1_sha256",
  "rsa_pss_rsae_sha256",
  "rsa_pkcs1_sha256",
  "ecdsa_secp384r1_sha384",
  "rsa_pss_rsae_sha384",
  "rsa_pkcs1_sha384",
  "rsa_pss_rsae_sha512",
  "rsa_pkcs1_sha512",
  "ed25519",
  "ecdsa_secp521r1_sha512",
].join(":");
const TLS13_CIPHERS = new Set([
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_GCM_SHA256",
]);

export default function getBunTLSOptions(
  endpoint?: string,
): ConnectionOptions | undefined {
  const process = globalThis.process;
  if (!process?.versions?.bun) {
    return undefined;
  }

  const tls = process.getBuiltinModule("node:tls") as typeof import("node:tls");
  const { X509Certificate } = process.getBuiltinModule(
    "node:crypto",
  ) as typeof import("node:crypto");
  const { isIP } = process.getBuiltinModule(
    "node:net",
  ) as typeof import("node:net");
  const { domainToASCII } = process.getBuiltinModule(
    "node:url",
  ) as typeof import("node:url");
  const hostname = endpoint ? new URL(endpoint).hostname : "";

  const ciphers = tls.DEFAULT_CIPHERS;
  // Bun raises its native default minimum to TLS 1.3 when the legacy list is
  // empty. An explicit list would bypass that guard or reject valid policy.
  const tls13Only = ciphers
    .split(":")
    .every((cipher) => TLS13_CIPHERS.has(cipher));

  return {
    // RFC 6066 §3: normalize SNI only; retain the URL and HTTP authority.
    ...(hostname.endsWith(".") ? { servername: hostname.slice(0, -1) } : {}),
    ciphers: tls13Only
      ? undefined
      : `${ciphers}:${NO_RSA_KEY_EXCHANGE}:${NO_CBC_CIPHERS}`,
    sigalgs: SIGNATURE_ALGORITHMS,
    rejectUnauthorized: true,
    checkServerIdentity(hostname, certificate) {
      try {
        const unbracketed = hostname.slice(1, -1);
        if (
          hostname.startsWith("[") &&
          hostname.endsWith("]") &&
          isIP(unbracketed) === 6
        ) {
          hostname = unbracketed;
        }
        const ip = isIP(hostname);
        if (!ip) {
          hostname = domainToASCII(hostname).replace(/\.$/, "");
        }

        const error = tls.checkServerIdentity(hostname, certificate);
        if (error) {
          return error;
        }

        // Parse DER, not the display SAN string: CN fallback and partial
        // wildcard matching must not turn an unrelated SAN into an identity.
        const parsed = new X509Certificate(certificate.raw);
        // RFC 6120 §13.7.1.1: enforce the native end-entity profile metadata.
        if (!parsed.subject || parsed.ca) {
          return new Error("Invalid TLS end-entity certificate");
        }

        const match = ip
          ? parsed.checkIP(hostname)
          : parsed.checkHost(hostname, {
              subject: "never",
              partialWildcards: false,
            });
        return match ? undefined : new Error("TLS SAN identity required");
      } catch {
        return new Error("Invalid TLS server identity");
      }
    },
  };
}
