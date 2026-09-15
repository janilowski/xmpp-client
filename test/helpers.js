import selfsigned from "selfsigned";

export async function makeSelfSignedCertificate(options = {}) {
  const attrs = [{ name: "commonName", value: "localhost" }];
  const pem = await selfsigned.generate(attrs, {
    algorithm: "sha256",
    days: 365,
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: "extKeyUsage", serverAuth: true, clientAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
    keySize: 2048,
    ...options,
  });
  return pem;
}
