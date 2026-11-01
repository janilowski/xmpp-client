import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";

// RFC 6120 §4.4, RFC 7395 §3.6 and RFC 9846 §6.1: normal TLS closure
// sends warning close_notify. The independent authenticated peer withholds its
// alert until the client alert arrives. This proves transmission, NOT client
// processing of the reciprocal alert, and does not complete the #8 TLS gate.
const SETUP_TIMEOUT_MS = 30000;
const TEST_TIMEOUT_MS = 20000;
const CHILD_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 12000;
const XMPP_TIMEOUT_MS = 2000;
const TLS_VERSION_MAJOR = 3;
const TLS12_MINOR = 3;
const TLS13_MINOR = 4;
const TLS_WARNING = 1;
const TLS_CLOSE_NOTIFY = 0;
const TLS12_ECDHE_RSA_AES128_GCM_SHA256 = 0xc02f;
const TLS13_AES128_GCM_SHA256 = 0x1301;
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
type Records = {
  version: number[];
  cipher: number;
  alerts: (string | number)[][];
  application: string[];
  eof: boolean;
  errors: { name: string; message: string }[];
};
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-tls-closure-"));
  const authority = await generate(
    [{ name: "commonName", value: "TLS closure test CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
  );
  const certificate = await generate(
    [{ name: "commonName", value: "localhost" }],
    {
      algorithm: "sha256",
      ca: { key: authority.private, cert: authority.cert },
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
      ],
    },
  );
  const root = new X509Certificate(authority.cert);
  const leaf = new X509Certificate(certificate.cert);
  expect(root.ca).toBe(true);
  expect(root.verify(root.publicKey)).toBe(true);
  expect(leaf.ca).toBe(false);
  expect(leaf.verify(root.publicKey)).toBe(true);
  expect(leaf.checkHost("localhost", { subject: "never" })).toBe("localhost");
  expect(leaf.checkPrivateKey(createPrivateKey(certificate.private))).toBe(
    true,
  );
  for (const parsed of [root, leaf]) {
    expect(Date.parse(parsed.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(parsed.validTo)).toBeGreaterThan(Date.now());
  }
  await Promise.all([
    writeFile(join(directory, "ca.pem"), authority.cert),
    writeFile(join(directory, "leaf.pem"), certificate.cert),
    writeFile(join(directory, "key.pem"), certificate.private),
  ]);
}, SETUP_TIMEOUT_MS);
afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const version of [TLS12_MINOR, TLS13_MINOR] as const) {
  test.each(["native-end", "native-destroy", "source", "minified"] as const)(
    `RFC 6120 §4.4: authenticated TLS 1.${version - 1} client alert / %s`,
    async (mode) => {
      const native = mode.startsWith("native-");
      const peer = Bun.spawn(
        [
          process.env.XMPP_TEST_PYTHON ?? "python3",
          "conformance/fixtures/tls-closure.py",
          resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
          directory,
          String(version),
          native ? "control" : "xmpp",
        ],
        { stdout: "pipe", stderr: "pipe", timeout: PEER_TIMEOUT_MS },
      );
      const reader = peer.stdout.getReader();
      let pending = "";
      async function receive() {
        while (!pending.includes("\n")) {
          const { done, value } = await reader.read();
          if (done) {
            throw new Error(
              "TLS closure peer exited before its response; run bun run test:tls:setup",
            );
          }
          pending += new TextDecoder().decode(value);
        }
        const end = pending.indexOf("\n");
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        return message;
      }
      let child: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const ready = (await receive()) as { port: number; tlslite: string };
        expect(ready.tlslite).toBe("0.8.2");
        expect(Number.isInteger(ready.port) && ready.port > 0).toBe(true);
        const protocol = version === TLS12_MINOR ? "TLSv1.2" : "TLSv1.3";
        const code = native
          ? `
          import assert from 'node:assert/strict';
          import {connect} from 'node:tls';
          import {readFileSync} from 'node:fs';
          if(process.versions.bun){throw new Error('Native Node required; set XMPP_TEST_NODE=/usr/bin/node');}
          let authorized,protocol,received='';
          const socket=connect({host:'localhost',port:${ready.port},ca:readFileSync(${JSON.stringify(join(directory, "ca.pem"))}),rejectUnauthorized:true,minVersion:${JSON.stringify(protocol)},maxVersion:${JSON.stringify(protocol)}});
          socket.on('secureConnect',()=>{authorized=socket.authorized;protocol=socket.getProtocol();assert.equal(authorized,true);socket.write('PING');});
          socket.on('data',data=>{received+=data.toString();if(received.length<4){return;}assert.equal(received,'PONG');socket.${mode === "native-end" ? "end" : "destroy"}();});
          socket.on('error',error=>{throw error;});
          socket.on('close',()=>console.log(JSON.stringify({outcome:'closed',authorized,protocol})));
        `
          : `
          import assert from 'node:assert/strict';
          const {client,xml}=${mode === "source" ? 'await import("./src/client/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
          const xmpp=client({service:'wss://localhost:${ready.port}/xmpp',domain:'example.test',username:'user',password:'password',resource:'r',timeout:${XMPP_TIMEOUT_MS}});
          const errors=[];xmpp.reconnect.stop();xmpp.on('error',error=>errors.push({name:error.name,message:error.message}));
          try{
            await xmpp.start();assert.equal(xmpp.jid.toString(),'user@example.test/r');
            const received=new Promise(resolve=>xmpp.on('stanza',element=>{if(element.is('message')){resolve(element.getChildText('body'));}}));
            await xmpp.send(xml('message',{to:'friend@example.test'},xml('body',{},'probe')));
            assert.equal(await received,'reply');
            await xmpp.stop();assert.deepEqual(errors,[]);console.log(JSON.stringify({outcome:'closed',reply:'reply'}));
          }finally{await xmpp.stop();}
        `;
        const probe = Bun.spawn(
          [
            native ? (process.env.XMPP_TEST_NODE ?? "node") : process.execPath,
            "--input-type=module",
            "--eval",
            code,
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
        child = probe;
        const [exit, stdout, stderr] = await Promise.all([
          probe.exited,
          new Response(probe.stdout).text(),
          new Response(probe.stderr).text(),
        ]);
        const observed = (await receive()) as Records;
        const [peerExit, peerStderr] = await Promise.all([
          peer.exited,
          new Response(peer.stderr).text(),
        ]);
        expect({ exit, stderr, peerExit, peerStderr }).toEqual({
          exit: 0,
          stderr: "",
          peerExit: 0,
          peerStderr: "",
        });
        expect(JSON.parse(stdout)).toEqual(
          native
            ? { outcome: "closed", authorized: true, protocol }
            : { outcome: "closed", reply: "reply" },
        );
        expect(observed.version).toEqual([TLS_VERSION_MAJOR, version]);
        expect(observed.cipher).toBe(
          version === TLS12_MINOR
            ? TLS12_ECDHE_RSA_AES128_GCM_SHA256
            : TLS13_AES128_GCM_SHA256,
        );
        if (mode === "native-destroy") {
          expect(observed.application).toEqual(["PING"]);
          expect(observed.alerts).toEqual([]);
          expect(observed.eof).toBe(true);
          expect(observed.errors.map((error) => error.name)).toEqual([
            "TLSAbruptCloseError",
          ]);
          return;
        }
        expect(observed.alerts).toEqual([
          ["received", TLS_WARNING, TLS_CLOSE_NOTIFY],
          ["sent", TLS_WARNING, TLS_CLOSE_NOTIFY],
        ]);
        expect(observed.errors).toEqual([]);
        if (native) {
          expect(observed.application).toEqual(["PING"]);
        } else {
          expect(observed.application).toHaveLength(7);
          expect(observed.application.slice(-2)).toEqual([CLOSE, "WS_CLOSE"]);
        }
      } finally {
        child?.kill();
        peer.kill();
        await Promise.all([child?.exited, peer.exited]);
        reader.releaseLock();
      }
    },
    TEST_TIMEOUT_MS,
  );
}
