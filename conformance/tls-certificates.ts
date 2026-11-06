import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generate } from "selfsigned";

const CHILD_TIMEOUT_MS = 10000;
const MAX_OUTPUT_BYTES = 262144;
const CHILD_OPTIONS = {
  encoding: "utf8" as const,
  stdio: "pipe" as const,
  timeout: CHILD_TIMEOUT_MS,
  maxBuffer: MAX_OUTPUT_BYTES,
};
// RFC 8017 Appendix A.2; RFC 5758 §3.2: certificate signature OIDs.
const RSA_PKCS1_SHA256 = "1.2.840.113549.1.1.11";
const ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const RSA_PSS = "1.2.840.113549.1.1.10";
const PSS_SALT_BYTES = 32;
const CERTIFICATE_DAYS = 1;
// Fixed fixture size, not a restriction on the client's accepted RSA keys.
const RSA_KEY_BITS = 2048;

export type TLSCertificateProfile = {
  name: "rsa-pkcs1" | "ecdsa-p256" | "rsa-pss";
  directory: string;
  ca: string;
};

// RFC 9846 §9.1 separates certificate signatures from CertificateVerify.
// Generate real issuer-signed leaves; a trusted root's self-signature alone
// cannot establish certificate-signature verification support.
export async function createTLSCertificates(
  directory: string,
): Promise<TLSCertificateProfile[]> {
  const profiles: TLSCertificateProfile[] = [];
  let rsaAuthority: Awaited<ReturnType<typeof generate>> | undefined;
  let rsaLeaf: Awaited<ReturnType<typeof generate>> | undefined;
  for (const name of ["rsa-pkcs1", "ecdsa-p256"] as const) {
    const options =
      name === "ecdsa-p256"
        ? { keyType: "ec" as const, curve: "P-256" as const }
        : { keyType: "rsa" as const, keySize: RSA_KEY_BITS };
    const authority = await generate(
      [{ name: "commonName", value: `${name} fixture CA` }],
      {
        ...options,
        algorithm: "sha256",
        extensions: [
          { name: "basicConstraints", cA: true, critical: true },
          {
            name: "keyUsage",
            keyCertSign: true,
            cRLSign: true,
            critical: true,
          },
        ],
      },
    );
    // selfsigned imports the issuer using keyType: keep issuer/leaf types
    // homogeneous rather than accidentally importing an RSA CA as ECDSA.
    const leaf = await generate([{ name: "commonName", value: "localhost" }], {
      ...options,
      algorithm: "sha256",
      ca: { key: authority.private, cert: authority.cert },
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
      ],
    });
    const profile = {
      name,
      directory: join(directory, name),
      ca: authority.cert,
    };
    await mkdir(profile.directory, { recursive: true });
    await Promise.all([
      writeFile(join(profile.directory, "ca.pem"), authority.cert),
      writeFile(join(profile.directory, "leaf.pem"), leaf.cert),
      writeFile(join(profile.directory, "key.pem"), leaf.private),
    ]);
    profiles.push(profile);
    if (name === "rsa-pkcs1") {
      rsaAuthority = authority;
      rsaLeaf = leaf;
    }
  }
  assert.ok(rsaAuthority && rsaLeaf);

  // Keep ordinary rsaEncryption keys, changing the leaf issuer signature to
  // PSS/SHA-256. Restricted RSA-PSS keys would exercise rsa_pss_pss instead.
  const pss = {
    name: "rsa-pss" as const,
    directory: join(directory, "rsa-pss"),
    ca: rsaAuthority.cert,
  };
  await mkdir(pss.directory, { recursive: true });
  await Promise.all([
    writeFile(join(pss.directory, "ca.pem"), rsaAuthority.cert),
    writeFile(join(pss.directory, "issuer-key.pem"), rsaAuthority.private),
    writeFile(join(pss.directory, "key.pem"), rsaLeaf.private),
    writeFile(
      join(pss.directory, "leaf.ext"),
      "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\n" +
        "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n",
    ),
  ]);
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-key",
      join(pss.directory, "key.pem"),
      "-subj",
      "/CN=localhost",
      "-sha256",
      "-out",
      join(pss.directory, "leaf.csr"),
    ],
    CHILD_OPTIONS,
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      join(pss.directory, "leaf.csr"),
      "-CA",
      join(pss.directory, "ca.pem"),
      "-CAkey",
      join(pss.directory, "issuer-key.pem"),
      "-CAcreateserial",
      "-days",
      String(CERTIFICATE_DAYS),
      "-sha256",
      "-sigopt",
      "rsa_padding_mode:pss",
      "-sigopt",
      `rsa_pss_saltlen:${PSS_SALT_BYTES}`,
      "-sigopt",
      "rsa_mgf1_md:sha256",
      "-extfile",
      join(pss.directory, "leaf.ext"),
      "-out",
      join(pss.directory, "leaf.pem"),
    ],
    CHILD_OPTIONS,
  );
  profiles.push(pss);

  // Native Node validates metadata independently of the generator and Bun's
  // X509 compatibility layer. All subprocesses are bounded and fail setup.
  const result = execFileSync(
    process.env.XMPP_TEST_NODE ?? "node",
    [
      "--input-type=module",
      "--eval",
      `
import assert from 'node:assert/strict';
import {createPrivateKey, X509Certificate} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
assert.equal(process.versions.bun, undefined, 'Native Node required');
for (const {name,directory} of JSON.parse(process.argv[1])) {
  const authority=new X509Certificate(readFileSync(join(directory,'ca.pem')));
  const leaf=new X509Certificate(readFileSync(join(directory,'leaf.pem')));
  const key=createPrivateKey(readFileSync(join(directory,'key.pem')));
  const ec=name==='ecdsa-p256';
  assert.equal(authority.ca,true);
  assert.equal(leaf.ca,false);
  assert.equal(authority.verify(authority.publicKey),true);
  assert.equal(leaf.issuer,authority.subject);
  assert.notEqual(leaf.subject,authority.subject);
  assert.equal(leaf.verify(authority.publicKey),true);
  assert.equal(leaf.checkPrivateKey(key),true);
  assert.equal(leaf.subjectAltName,'DNS:localhost');
  assert.equal(leaf.checkHost('localhost',{subject:'never'}),'localhost');
  assert.deepEqual(leaf.keyUsage,['1.3.6.1.5.5.7.3.1']);
  assert.equal(authority.signatureAlgorithmOid,ec?${JSON.stringify(ECDSA_SHA256)}:${JSON.stringify(RSA_PKCS1_SHA256)});
  assert.equal(leaf.signatureAlgorithmOid,ec?${JSON.stringify(ECDSA_SHA256)}:name==='rsa-pss'?${JSON.stringify(RSA_PSS)}:${JSON.stringify(RSA_PKCS1_SHA256)});
  for (const certificate of [authority,leaf]) {
    assert.equal(certificate.publicKey.asymmetricKeyType,ec?'ec':'rsa');
    if(ec){assert.equal(certificate.publicKey.asymmetricKeyDetails.namedCurve,'prime256v1');}
    else{assert.equal(certificate.publicKey.asymmetricKeyDetails.modulusLength,${RSA_KEY_BITS});}
    assert.ok(Date.parse(certificate.validFrom)<=Date.now());
    assert.ok(Date.parse(certificate.validTo)>Date.now());
  }
}
`,
      JSON.stringify(
        profiles.map(({ name, directory }) => ({ name, directory })),
      ),
    ],
    CHILD_OPTIONS,
  );
  assert.equal(result, "");

  for (const profile of profiles) {
    const verified = execFileSync(
      "openssl",
      [
        "verify",
        "-CAfile",
        join(profile.directory, "ca.pem"),
        "-purpose",
        "sslserver",
        "-verify_hostname",
        "localhost",
        join(profile.directory, "leaf.pem"),
      ],
      CHILD_OPTIONS,
    );
    assert.equal(verified.trim(), `${join(profile.directory, "leaf.pem")}: OK`);
    for (const name of ["ca.pem", "leaf.pem"]) {
      const details = execFileSync(
        "openssl",
        ["x509", "-in", join(profile.directory, name), "-noout", "-text"],
        CHILD_OPTIONS,
      );
      // Inspect original issuer and leaf SPKIs: both RSA keys must use
      // rsaEncryption, not id-RSASSA-PSS (a different TLS signature scheme).
      assert.deepEqual(
        [...details.matchAll(/Public Key Algorithm: ([^\s]+)/g)].map(
          (match) => match[1],
        ),
        [profile.name === "ecdsa-p256" ? "id-ecPublicKey" : "rsaEncryption"],
      );
    }
  }
  const details = execFileSync(
    "openssl",
    ["x509", "-in", join(pss.directory, "leaf.pem"), "-noout", "-text"],
    CHILD_OPTIONS,
  );
  // Both inner and outer AlgorithmIdentifiers must carry the exact PSS
  // parameters; merely seeing the rsassaPss OID does not establish SHA-256.
  for (const expression of [
    /Signature Algorithm: rsassaPss/g,
    /Hash Algorithm: sha256/g,
    /Mask Algorithm: mgf1 with sha256/g,
    /Salt Length: 0x20/g,
    /Trailer Field: 0x01/g,
  ]) {
    assert.equal(details.match(expression)?.length, 2, String(expression));
  }
  return profiles;
}
