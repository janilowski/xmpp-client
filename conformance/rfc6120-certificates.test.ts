import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

// RFC 6120 §§13.7.1.1/13.7.2(4): enforce the end-entity restrictions
// exposed by native certificate APIs, on the authenticated connection.
// Empty subject + critical SAN and CA leaves can be valid generic HTTPS PKIX.
// Absence of basicConstraints is allowed: the prohibition is cA:TRUE.
// X509Certificate.ca also considers keyUsage; cA:TRUE without keyCertSign is
// not exposed as true. These cases do not claim coverage of that opaque flag.
// Other PKIX and identity cases: rfc7395-tls.test.ts.
// https://www.rfc-editor.org/rfc/rfc6120.html#section-13.7.2
const CHILD_TIMEOUT_MS = 5000;
const CLIENT_TIMEOUT_MS = 2000;
const SETUP_TIMEOUT_MS = 30000;
const TEST_TIMEOUT_MS = 10000;
const HTTP_BAD_REQUEST = 400;
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const SCENARIOS = [
  "valid",
  "organization-subject",
  "absent-basic-constraints",
  "empty-subject",
  "ca-leaf",
] as const;
type Scenario = (typeof SCENARIOS)[number];
type Certificate = Awaited<ReturnType<typeof generate>>;
let directory: string;
const certificates = new Map<Scenario, Certificate>();

function endpoint(certificate: Certificate) {
  const counts = { probes: 0, discoveries: 0, upgrades: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: certificate.cert, key: certificate.private },
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/probe") {
        counts.probes++;
        return new Response("authenticated");
      }
      if (path === "/.well-known/host-meta") {
        counts.discoveries++;
        return new Response(
          `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://localhost:${server.port}/xmpp"/></XRD>`,
        );
      }
      if (path !== "/xmpp") {
        return new Response(null, { status: HTTP_BAD_REQUEST });
      }
      counts.upgrades++;
      if (
        server.upgrade(request, {
          headers: { "Sec-WebSocket-Protocol": "xmpp" },
        })
      ) {
        return;
      }
      return new Response(null, { status: HTTP_BAD_REQUEST });
    },
    websocket: { message() {} },
  });
  return { server, counts };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-end-entity-"));
  const authority = await generate(
    [{ name: "commonName", value: "Disposable end-entity profile CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyCertSign: true,
          cRLSign: true,
          critical: true,
        },
      ],
    },
  );
  const root = new X509Certificate(authority.cert);
  expect(root.ca).toBe(true);
  expect(root.verify(root.publicKey)).toBe(true);
  await writeFile(join(directory, "ca.pem"), authority.cert);
  let keys: { privateKey: string; publicKey: string } | undefined;
  for (const scenario of SCENARIOS) {
    const certificate = await generate(
      scenario === "empty-subject"
        ? []
        : scenario === "organization-subject"
          ? [{ name: "organizationName", value: "Example" }]
          : [{ name: "commonName", value: "localhost" }],
      {
        algorithm: "sha256",
        ...(keys ? { keyPair: keys } : {}),
        ca: { key: authority.private, cert: authority.cert },
        extensions: [
          ...(scenario === "absent-basic-constraints"
            ? []
            : [
                {
                  name: "basicConstraints" as const,
                  cA: scenario === "ca-leaf",
                  critical: true,
                },
              ]),
          {
            name: "keyUsage",
            digitalSignature: true,
            keyEncipherment: true,
            keyCertSign: scenario === "ca-leaf",
            critical: true,
          },
          { name: "extKeyUsage", serverAuth: true },
          {
            name: "subjectAltName",
            critical: true,
            altNames: [{ type: 2, value: "localhost" }],
          },
        ],
      },
    );
    keys ??= { privateKey: certificate.private, publicKey: certificate.public };
    const parsed = new X509Certificate(certificate.cert);
    expect(certificate.private).toBe(keys.privateKey);
    expect(certificate.public).toBe(keys.publicKey);
    expect(parsed.verify(root.publicKey)).toBe(true);
    expect(parsed.checkPrivateKey(createPrivateKey(certificate.private))).toBe(
      true,
    );
    expect(parsed.issuer).toBe(root.subject);
    expect(parsed.ca).toBe(scenario === "ca-leaf");
    expect(parsed.subject ?? "").toBe(
      scenario === "empty-subject"
        ? ""
        : scenario === "organization-subject"
          ? "O=Example"
          : "CN=localhost",
    );
    expect(parsed.keyUsage).toEqual([SERVER_AUTH]);
    expect(parsed.checkHost("localhost", { subject: "never" })).toBe(
      "localhost",
    );
    expect(parsed.subjectAltName).toBe("DNS:localhost");
    for (const certificate of [root, parsed]) {
      expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
    }
    const filename = join(directory, `${scenario}.pem`);
    await writeFile(filename, certificate.cert);
    // Decode the issued fields independently: a folded native ca getter is
    // not itself evidence of the raw basicConstraints or keyUsage values.
    const decoded = Bun.spawnSync(
      [
        "openssl",
        "x509",
        "-in",
        filename,
        "-noout",
        "-subject",
        "-nameopt",
        "RFC2253",
        "-ext",
        "basicConstraints,keyUsage,extendedKeyUsage,subjectAltName",
      ],
      { timeout: CHILD_TIMEOUT_MS },
    );
    expect({
      exit: decoded.exitCode,
      errors: decoded.stderr.toString(),
    }).toEqual({
      exit: 0,
      errors: "",
    });
    expect(
      decoded.stdout
        .toString()
        .trim()
        .replace(/[ \t]+$/gm, ""),
    ).toBe(
      [
        `subject=${scenario === "empty-subject" ? "" : scenario === "organization-subject" ? "O=Example" : "CN=localhost"}`,
        ...(scenario === "absent-basic-constraints"
          ? []
          : [
              "X509v3 Basic Constraints: critical",
              `    CA:${scenario === "ca-leaf" ? "TRUE" : "FALSE"}`,
            ]),
        "X509v3 Key Usage: critical",
        `    Digital Signature, Key Encipherment${scenario === "ca-leaf" ? ", Certificate Sign" : ""}`,
        "X509v3 Extended Key Usage:",
        "    TLS Web Server Authentication",
        "X509v3 Subject Alternative Name: critical",
        "    DNS:localhost",
      ].join("\n"),
    );
    const verified = Bun.spawnSync(
      [
        "openssl",
        "verify",
        "-CAfile",
        join(directory, "ca.pem"),
        "-purpose",
        "sslserver",
        "-verify_hostname",
        "localhost",
        filename,
      ],
      { timeout: CHILD_TIMEOUT_MS },
    );
    expect({
      exit: verified.exitCode,
      errors: verified.stderr.toString(),
    }).toEqual({
      exit: 0,
      errors: "",
    });
    expect(verified.stdout.toString().trim()).toBe(`${filename}: OK`);
    certificates.set(scenario, certificate);
    const remote = endpoint(certificate);
    try {
      // Native HTTPS and WSS must accept every valid-PKIX fixture before the
      // application-policy negatives can count as certificate-profile evidence.
      const probe = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
          const response=await fetch('https://localhost:${remote.server.port}/probe');
          if(await response.text()!=='authenticated'){throw Error('Missing authenticated HTTP');}
          await new Promise((resolve,reject)=>{
            const socket=new WebSocket('wss://localhost:${remote.server.port}/xmpp',['xmpp']);
            socket.addEventListener('error',reject);socket.addEventListener('open',()=>socket.close());socket.addEventListener('close',()=>resolve());
          });
          console.log(JSON.stringify({accepted:true}));
        `,
        ],
        {
          env: {
            ...process.env,
            NODE_TLS_REJECT_UNAUTHORIZED: "1",
            NODE_EXTRA_CA_CERTS: join(directory, "ca.pem"),
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: CHILD_TIMEOUT_MS,
        },
      );
      const [exit, output, errors] = await Promise.all([
        probe.exited,
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
      ]);
      expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
      expect(JSON.parse(output)).toEqual({ accepted: true });
      expect(remote.counts).toEqual({ probes: 1, discoveries: 0, upgrades: 1 });
    } finally {
      await remote.server.stop(true);
    }
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of SCENARIOS) {
  for (const artifact of ["source", "ESM", "minified"]) {
    for (const mode of ["direct", "discovery"]) {
      test(
        `RFC 6120 §§13.7.1.1/13.7.2(4): ${scenario} / ${artifact} / ${mode}`,
        async () => {
          const remote = endpoint(certificates.get(scenario)!);
          try {
            const service =
              mode === "direct"
                ? `wss://localhost:${remote.server.port}/xmpp`
                : `localhost:${remote.server.port}`;
            const child = Bun.spawn(
              [
                process.execPath,
                "--eval",
                `
          const {client}=${artifact === "source" ? 'await import("./src/client/index.js")' : artifact === "ESM" ? 'await import("./dist/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
          const entity=client({service:${JSON.stringify(service)},domain:'different-xmpp-domain.test',timeout:${CLIENT_TIMEOUT_MS}});
          entity.reconnect.stop();entity.on('error',()=>{});let result;
          try{await entity.connect(entity.options.service);result={accepted:true};}
          catch(error){result={accepted:false,name:error.name};}
          finally{await entity.stop();}console.log(JSON.stringify(result));
        `,
              ],
              {
                env: {
                  ...process.env,
                  NODE_TLS_REJECT_UNAUTHORIZED: "1",
                  NODE_EXTRA_CA_CERTS: join(directory, "ca.pem"),
                },
                stdout: "pipe",
                stderr: "pipe",
                timeout: CHILD_TIMEOUT_MS,
              },
            );
            const [exit, output, errors] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
            const result = JSON.parse(output);
            expect(result.name).not.toBe("TimeoutError");
            const accepted =
              scenario === "valid" ||
              scenario === "organization-subject" ||
              scenario === "absent-basic-constraints";
            expect(result.accepted).toBe(accepted);
            expect(remote.counts).toEqual({
              probes: 0,
              discoveries: accepted && mode === "discovery" ? 1 : 0,
              upgrades: accepted ? 1 : 0,
            });
          } finally {
            await remote.server.stop(true);
          }
        },
        TEST_TIMEOUT_MS,
      );
    }
  }
}
