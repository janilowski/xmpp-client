import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMAND_TIMEOUT_MS = 5000;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const CERTIFICATE_DAYS = "3";
const REVOCATION_DAYS = "1";

// An independent OpenSSL issuer owns both the certificates and their signed
// revocation state. No production parser supplies the expected status.
export async function createRevocationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "xmpp-revocation-"));
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const errors: string[] = [];
  let requestNumber = 0;

  async function openssl(args: string[], expectedExit = 0) {
    const child = Bun.spawn(["openssl", ...args], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
    });
    children.add(child);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(
        exit,
        expectedExit,
        JSON.stringify({ args, stdout, stderr }),
      );
      return { stdout, stderr };
    } finally {
      child.kill();
      await child.exited;
      children.delete(child);
    }
  }

  let responder: Bun.Server<undefined>;
  try {
    responder = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        try {
          const path = new URL(request.url).pathname;
          if (path === "/ca.crl") {
            return new Response(await readFile(join(directory, "ca.crl.der")), {
              status: HTTP_OK,
              headers: { "Content-Type": "application/pkix-crl" },
            });
          }
          if (path !== "/ocsp" || request.method !== "POST") {
            return new Response(null, { status: HTTP_NOT_FOUND });
          }

          const name = `request-${requestNumber++}`;
          await writeFile(
            join(directory, `${name}.der`),
            Buffer.from(await request.arrayBuffer()),
          );
          await openssl([
            "ocsp",
            "-index",
            "index.txt",
            "-CA",
            "ca.pem",
            "-rsigner",
            "ca.pem",
            "-rkey",
            "ca.key",
            "-reqin",
            `${name}.der`,
            "-respout",
            `${name}-response.der`,
            "-ndays",
            REVOCATION_DAYS,
          ]);
          return new Response(
            await readFile(join(directory, `${name}-response.der`)),
            {
              status: HTTP_OK,
              headers: { "Content-Type": "application/ocsp-response" },
            },
          );
        } catch (error) {
          errors.push(String(error));
          return new Response(null, { status: HTTP_INTERNAL_SERVER_ERROR });
        }
      },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const origin = `http://127.0.0.1:${responder.port}`;
  async function close() {
    await responder.stop(true);
    for (const child of children) {
      child.kill();
    }
    await Promise.all([...children].map((child) => child.exited));
    await rm(directory, { recursive: true, force: true });
  }

  try {
    await mkdir(join(directory, "newcerts"));
    await writeFile(join(directory, "index.txt"), "");
    await writeFile(join(directory, "serial"), "1000\n");
    await writeFile(join(directory, "crlnumber"), "1000\n");
    await writeFile(
      join(directory, "ca.cnf"),
      `[ca]
default_ca=issuer
[issuer]
dir=.
database=$dir/index.txt
new_certs_dir=$dir/newcerts
certificate=$dir/ca.pem
private_key=$dir/ca.key
serial=$dir/serial
crlnumber=$dir/crlnumber
default_md=sha256
default_days=${CERTIFICATE_DAYS}
default_crl_days=${REVOCATION_DAYS}
policy=policy
unique_subject=no
x509_extensions=leaf
[policy]
commonName=supplied
[leaf]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost
authorityInfoAccess=OCSP;URI:${origin}/ocsp
crlDistributionPoints=URI:${origin}/ca.crl
`,
    );
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      CERTIFICATE_DAYS,
      "-subj",
      "/CN=Disposable Revocation CA",
      "-addext",
      "basicConstraints=critical,CA:true",
      "-addext",
      "keyUsage=critical,digitalSignature,keyCertSign,cRLSign",
    ]);
    for (const name of ["good", "revoked"]) {
      await openssl([
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.csr`,
        "-subj",
        "/CN=localhost",
      ]);
      await openssl([
        "ca",
        "-batch",
        "-config",
        "ca.cnf",
        "-in",
        `${name}.csr`,
        "-out",
        `${name}.pem`,
        "-notext",
      ]);
    }
    await openssl([
      "ca",
      "-batch",
      "-config",
      "ca.cnf",
      "-revoke",
      "revoked.pem",
      "-crl_reason",
      "keyCompromise",
    ]);
    await openssl([
      "ca",
      "-batch",
      "-config",
      "ca.cnf",
      "-gencrl",
      "-out",
      "ca.crl.pem",
    ]);
    await openssl([
      "crl",
      "-in",
      "ca.crl.pem",
      "-outform",
      "DER",
      "-out",
      "ca.crl.der",
    ]);
    return { directory, origin, openssl, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}
