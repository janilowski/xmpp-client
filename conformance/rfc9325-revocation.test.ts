import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRevocationFixture } from "./fixtures/revocation.ts";

// RFC 9325 §7.5 requires a revocation strategy; RFC 6120 §13.7.2 step 5
// concerns initial checks, unlike periodic SHOULDs in §13.7.2.3.
// These independent oracle/runtime capability controls do NOT establish the
// library's default policy, browser revocation, or full revocation coverage.
// Runtime/deployment ownership is documented in docs/profile.md (#95).
// https://www.rfc-editor.org/rfc/rfc9325.html#section-7.5
// https://www.rfc-editor.org/rfc/rfc6120.html#section-13.7.2
const SETUP_TIMEOUT_MS = 30000;
const CLIENT_TIMEOUT_MS = 3000;
const CHILD_TIMEOUT_MS = 5000;
const TEST_TIMEOUT_MS = 15000;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const OPENSSL_VERIFY_FAILURE = 2;
let fixture: Awaited<ReturnType<typeof createRevocationFixture>>;

beforeAll(async () => {
  fixture = await createRevocationFixture();
}, SETUP_TIMEOUT_MS);
afterAll(async () => {
  if (fixture) {
    await fixture.close();
  }
});

test.each(["good", "revoked"] as const)(
  "§7.5 oracle: trusted %s SAN leaf has an independently signed status",
  async (name) => {
    const ca = new X509Certificate(
      await readFile(join(fixture.directory, "ca.pem")),
    );
    const leaf = new X509Certificate(
      await readFile(join(fixture.directory, `${name}.pem`)),
    );
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.issuer).toBe(ca.subject);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(
      leaf.checkPrivateKey(
        createPrivateKey(
          await readFile(join(fixture.directory, `${name}.key`)),
        ),
      ),
    ).toBe(true);
    expect(leaf.subjectAltName).toBe("DNS:localhost");
    for (const certificate of [ca, leaf]) {
      expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
    }
    const extensions = await fixture.openssl([
      "x509",
      "-in",
      `${name}.pem`,
      "-noout",
      "-ext",
      "authorityInfoAccess,crlDistributionPoints",
    ]);
    expect(extensions.stdout).toContain(`OCSP - URI:${fixture.origin}/ocsp`);
    expect(extensions.stdout).toContain(`URI:${fixture.origin}/ca.crl`);

    const path = await fixture.openssl([
      "verify",
      "-CAfile",
      "ca.pem",
      "-purpose",
      "sslserver",
      `${name}.pem`,
    ]);
    expect(path.stdout.trim()).toBe(`${name}.pem: OK`);
    const crl = await fixture.openssl([
      "crl",
      "-in",
      "ca.crl.pem",
      "-noout",
      "-verify",
      "-CAfile",
      "ca.pem",
    ]);
    expect(crl.stderr.trim()).toBe("verify OK");
    const checked = await fixture.openssl(
      [
        "verify",
        "-CAfile",
        "ca.pem",
        "-CRLfile",
        "ca.crl.pem",
        "-crl_check",
        `${name}.pem`,
      ],
      name === "good" ? 0 : OPENSSL_VERIFY_FAILURE,
    );
    if (name === "good") {
      expect(checked.stdout.trim()).toBe("good.pem: OK");
    } else {
      expect(checked.stderr).toContain(
        "error 23 at 0 depth lookup: certificate revoked",
      );
    }
    const status = await fixture.openssl([
      "ocsp",
      "-issuer",
      "ca.pem",
      "-cert",
      `${name}.pem`,
      "-url",
      `${fixture.origin}/ocsp`,
      "-CAfile",
      "ca.pem",
    ]);
    expect(status.stderr.trim()).toBe("Response verify OK");
    expect(status.stdout).toContain(
      `${name}.pem: ${name === "good" ? "good" : "revoked"}`,
    );
    expect(
      Date.parse(status.stdout.match(/This Update: (.+)/)![1]!),
    ).toBeLessThanOrEqual(Date.now());
    expect(
      Date.parse(status.stdout.match(/Next Update: (.+)/)![1]!),
    ).toBeGreaterThan(Date.now());
    if (name === "revoked") {
      expect(status.stdout).toContain("Reason: keyCompromise");
    }
    expect(fixture.errors).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

test("§7.5 oracle: advertised CRL endpoint serves the signed DER bytes", async () => {
  const response = await fetch(`${fixture.origin}/ca.crl`, {
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
  });
  expect(response.status).toBe(HTTP_OK);
  expect(response.headers.get("Content-Type")).toBe("application/pkix-crl");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(
    await readFile(join(fixture.directory, "ca.crl.der")),
  );
  expect(fixture.errors).toEqual([]);
});

for (const mode of ["fetch", "websocket"] as const) {
  test.each(["good", "revoked", "wrong-host", "untrusted"] as const)(
    `§7.5 native Bun ${mode} with explicit CRL: %s`,
    async (scenario) => {
      const name = scenario === "revoked" ? "revoked" : "good";
      let requests = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: {
          key: await readFile(join(fixture.directory, `${name}.key`)),
          cert: await readFile(join(fixture.directory, `${name}.pem`)),
        },
        fetch(request, peer) {
          requests += 1;
          if (mode === "websocket") {
            if (
              peer.upgrade(request, {
                headers: { "Sec-WebSocket-Protocol": "xmpp" },
              })
            ) {
              return;
            }
            return new Response(null, { status: HTTP_BAD_REQUEST });
          }
          return new Response("authenticated", { status: HTTP_OK });
        },
        websocket: { message() {} },
      });
      let child: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const probe = Bun.spawn(
          [
            process.execPath,
            "--eval",
            `
          const directory=${JSON.stringify(fixture.directory)};
          const tls={rejectUnauthorized:true,crl:await Bun.file(directory+'/ca.crl.pem').text(),...(${JSON.stringify(scenario)}==='untrusted'?{}:{ca:await Bun.file(directory+'/ca.pem').text()})};
          const host=${JSON.stringify(scenario === "wrong-host" ? "127.0.0.1" : "localhost")};
          let outcome,code,body,protocol;
          if(${JSON.stringify(mode)}==='fetch'){
            try{const response=await fetch('https://'+host+':${server.port}/',{tls,signal:AbortSignal.timeout(${CLIENT_TIMEOUT_MS})});body=await response.text();outcome='accepted';}
            catch(error){if(error.name==='TimeoutError'){throw error;}outcome='rejected';code=error.code;}
          }else{
            outcome=await new Promise((resolve,reject)=>{
              const socket=new WebSocket('wss://'+host+':${server.port}/',{protocols:['xmpp'],tls});
              const timer=setTimeout(()=>{socket.close();reject(new Error('Missing WebSocket verdict'));},${CLIENT_TIMEOUT_MS});
              socket.onopen=()=>{clearTimeout(timer);protocol=socket.protocol;socket.close();resolve('accepted');};
              socket.onerror=()=>{clearTimeout(timer);resolve('rejected');};
            });
          }
          console.log(JSON.stringify({bun:Bun.version,outcome,code,body,protocol}));
        `,
          ],
          {
            env: {
              ...process.env,
              NODE_TLS_REJECT_UNAUTHORIZED: "1",
              NODE_EXTRA_CA_CERTS: "",
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: CHILD_TIMEOUT_MS,
          },
        );
        child = probe;
        const [exit, stdout, stderr] = await Promise.all([
          probe.exited,
          new Response(probe.stdout).text(),
          new Response(probe.stderr).text(),
        ]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        const result = JSON.parse(stdout);
        expect(result.bun).toBe(Bun.version);
        expect(result.outcome).toBe(
          scenario === "good" ? "accepted" : "rejected",
        );
        expect(requests).toBe(scenario === "good" ? 1 : 0);
        if (scenario === "good") {
          expect(mode === "fetch" ? result.body : result.protocol).toBe(
            mode === "fetch" ? "authenticated" : "xmpp",
          );
        }
        if (mode === "fetch" && scenario === "revoked") {
          expect(result.code).toBe("CERT_REVOKED");
        }
        expect(fixture.errors).toEqual([]);
      } finally {
        child?.kill();
        await child?.exited;
        await server.stop(true);
      }
    },
    TEST_TIMEOUT_MS,
  );
}
