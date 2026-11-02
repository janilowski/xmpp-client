import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate } from "selfsigned";

// RFC 6120 §4.4, RFC 7395 §3.6 and RFC 9846 §6.1: normal TLS closure
// sends warning close_notify. The Linux /proc witness proves the actual socket
// stays owned until the authenticated reciprocal alert, without peer TCP EOF.
// This does not establish browser behavior or complete the entire #8 TLS gate.
const SETUP_TIMEOUT_MS = 30000;
const TEST_TIMEOUT_MS = 20000;
const CHILD_TIMEOUT_MS = 8000;
const PEER_TIMEOUT_MS = 12000;
const XMPP_TIMEOUT_MS = 2000;
const DESCRIPTOR_TIMEOUT_MS = 2000;
const DESCRIPTOR_POLL_MS = 10;
const TCP_LOCAL_ADDRESS_COLUMN = 1;
const TCP_REMOTE_ADDRESS_COLUMN = 2;
const TCP_INODE_COLUMN = 9;
const TLS_VERSION_MAJOR = 3;
const TLS12_MINOR = 3;
const TLS13_MINOR = 4;
const TLS_WARNING = 1;
const TLS_CLOSE_NOTIFY = 0;
const X25519 = 29;
const TLS12_ECDHE_RSA_AES128_GCM_SHA256 = 0xc02f;
const TLS13_AES128_GCM_SHA256 = 0x1301;
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
type Records = {
  version: number[] | null;
  cipher: number | null;
  ecdhCurve: number | null;
  alerts: (string | number)[][];
  application: string[];
  eof: boolean;
  errors: { name: string; message: string }[];
};
let directory: string;

type SocketFile = { path: string; target: string };
async function findSocket(pid: number, localPort: number, remotePort: number) {
  // Linux exposes TCP inodes separately from process-owned descriptors.
  for (const table of ["tcp", "tcp6"]) {
    const rows = (await readFile(`/proc/${pid}/net/${table}`, "utf8"))
      .trim()
      .split("\n")
      .slice(1);
    for (const row of rows) {
      const columns = row.trim().split(/\s+/);
      if (
        parseInt(columns[TCP_LOCAL_ADDRESS_COLUMN]!.split(":")[1]!, 16) !==
          localPort ||
        parseInt(columns[TCP_REMOTE_ADDRESS_COLUMN]!.split(":")[1]!, 16) !==
          remotePort
      ) {
        continue;
      }
      const target = `socket:[${columns[TCP_INODE_COLUMN]}]`;
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        const file = { path: `/proc/${pid}/fd/${fd}`, target };
        if (await ownsSocket(file)) {
          return file;
        }
      }
    }
  }
  return undefined;
}

async function ownsSocket(file: SocketFile) {
  try {
    return (await readlink(file.path)) === file.target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

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

// P-256/FFDHE refusal is local fixture hardening, not an RFC group prohibition.
// Successful exchanges retain the normative closure assertions referenced above.
for (const version of [TLS12_MINOR, TLS13_MINOR] as const) {
  test.each([
    "native-end",
    "native-destroy",
    "native-premature",
    "native-p256",
    ...(version === TLS13_MINOR ? (["native-ffdhe"] as const) : []),
    "source",
    "minified",
  ] as const)(
    `TLS 1.${version - 1} closure fixture / %s`,
    async (mode) => {
      const native = mode.startsWith("native-");
      const restrictedGroup = mode === "native-p256" || mode === "native-ffdhe";
      const gated = !restrictedGroup && mode !== "native-destroy";
      if (gated) {
        expect(process.platform).toBe("linux");
      }
      const group =
        mode === "native-p256"
          ? "P-256"
          : mode === "native-ffdhe"
            ? "ffdhe2048"
            : "X25519";
      const peer = Bun.spawn(
        [
          process.env.XMPP_TEST_PYTHON ?? "python3",
          "conformance/fixtures/tls-closure.py",
          resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
          directory,
          String(version),
          native ? "control" : "xmpp",
          ...(gated ? ["reciprocal"] : []),
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          timeout: PEER_TIMEOUT_MS,
        },
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
      let clientReader: typeof reader | undefined;
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
          ${gated ? "const keepAlive=setInterval(()=>{},1000);process.stdin.once('data',()=>{clearInterval(keepAlive);process.stdin.destroy();});" : ""}
          let authorized,protocol,received='',code,outcome='closed';
          const socket=connect({host:'localhost',port:${ready.port},ca:readFileSync(${JSON.stringify(join(directory, "ca.pem"))}),rejectUnauthorized:true,minVersion:${JSON.stringify(protocol)},maxVersion:${JSON.stringify(protocol)},ecdhCurve:${JSON.stringify(group)}});
          socket.on('secureConnect',()=>{authorized=socket.authorized;protocol=socket.getProtocol();assert.equal(authorized,true);socket.write('PING');});
          socket.on('data',data=>{received+=data.toString();if(received.length<4){return;}assert.equal(received,'PONG');socket.${gated ? `end(()=>${mode === "native-premature" ? "socket.destroy()" : "console.log(JSON.stringify({phase:'output-ended'}))"})` : "destroy()"};});
          socket.on('error',error=>{if(!${restrictedGroup}){throw error;}outcome='rejected';code=error.code;});
          socket.on('close',()=>{${mode === "native-premature" ? "console.log(JSON.stringify({phase:'output-ended'}));" : ""}console.log(JSON.stringify({outcome,authorized,protocol,...(code?{code}:{})}));});
        `
          : `
          import assert from 'node:assert/strict';
          const keepAlive=setInterval(()=>{},1000);process.stdin.once('data',()=>{clearInterval(keepAlive);process.stdin.destroy();});
          const {client,xml}=${mode === "source" ? 'await import("./src/client/index.js")' : 'Function((await Bun.file("./dist/xmpp.min.js").text())+"\\n;return XMPP;")()'};
          const xmpp=client({service:'wss://localhost:${ready.port}/xmpp',domain:'example.test',username:'user',password:'password',resource:'r',timeout:${XMPP_TIMEOUT_MS}});
          const errors=[];xmpp.reconnect.stop();xmpp.on('error',error=>errors.push({name:error.name,message:error.message}));
          try{
            await xmpp.start();assert.equal(xmpp.jid.toString(),'user@example.test/r');
            const received=new Promise(resolve=>xmpp.on('stanza',element=>{if(element.is('message')){resolve(element.getChildText('body'));}}));
            await xmpp.send(xml('message',{to:'friend@example.test'},xml('body',{},'probe')));
            assert.equal(await received,'reply');
            const stopped=xmpp.stop();setImmediate(()=>console.log(JSON.stringify({phase:'stopping'})));await stopped;assert.deepEqual(errors,[]);console.log(JSON.stringify({outcome:'closed',reply:'reply'}));
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
            stdin: "pipe",
            timeout: CHILD_TIMEOUT_MS,
          },
        );
        child = probe;
        let clientPending = "";
        clientReader = gated ? probe.stdout.getReader() : undefined;
        async function receiveClient() {
          while (!clientPending.includes("\n")) {
            const { done, value } = await clientReader!.read();
            if (done) {
              throw new Error("TLS closure client exited before its response");
            }
            clientPending += new TextDecoder().decode(value);
          }
          const newline = clientPending.indexOf("\n");
          const response = JSON.parse(clientPending.slice(0, newline));
          clientPending = clientPending.slice(newline + 1);
          return response;
        }
        if (gated) {
          const connected = await receive();
          expect(connected.phase).toBe("connected");
          const file = await findSocket(
            probe.pid,
            connected.clientPort,
            ready.port,
          );
          expect(file).toBeDefined();
          peer.stdin.write("exchange\n");
          await peer.stdin.flush();
          expect(await receive()).toEqual({
            phase: "held",
            alerts: [["received", TLS_WARNING, TLS_CLOSE_NOTIFY]],
            eof: false,
          });
          expect(await receiveClient()).toEqual({
            phase: native ? "output-ended" : "stopping",
          });
          const retained = await ownsSocket(file!);
          if (mode === "native-premature") {
            // The same oracle must reject a client that destroys its read side.
            expect(() => assert.equal(retained, true)).toThrow(
              assert.AssertionError,
            );
          } else {
            expect(retained).toBe(true);
          }
          peer.stdin.write("alert\n");
          await peer.stdin.flush();
          expect(await receive()).toEqual({
            phase: "sent",
            alerts: [
              ["received", TLS_WARNING, TLS_CLOSE_NOTIFY],
              ["sent", TLS_WARNING, TLS_CLOSE_NOTIFY],
            ],
          });
          const deadline = Date.now() + DESCRIPTOR_TIMEOUT_MS;
          while ((await ownsSocket(file!)) && Date.now() < deadline) {
            await Bun.sleep(DESCRIPTOR_POLL_MS);
          }
          expect(await ownsSocket(file!)).toBe(false);
          peer.stdin.write("finish\n");
          await peer.stdin.flush();
          probe.stdin.write("finish\n");
          await probe.stdin.flush();
        }
        const [exit, stdout, stderr] = await Promise.all([
          probe.exited,
          gated
            ? receiveClient().then(JSON.stringify)
            : new Response(probe.stdout).text(),
          new Response(probe.stderr).text(),
        ]);
        if (clientReader) {
          let trailing = clientPending;
          for (;;) {
            const { done, value } = await clientReader.read();
            if (done) {
              break;
            }
            trailing += new TextDecoder().decode(value);
          }
          expect(trailing).toBe("");
        }
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
        if (restrictedGroup) {
          expect(JSON.parse(stdout)).toEqual({
            outcome: "rejected",
            code: expect.stringMatching(
              /^ERR_SSL_(SSLV3|SSL\/TLS)_ALERT_HANDSHAKE_FAILURE$/,
            ),
          });
          expect(observed.version).toBeNull();
          expect(observed.cipher).toBeNull();
          expect(observed.ecdhCurve).toBeNull();
          expect(observed.application).toEqual([]);
          expect(observed.errors).toEqual([
            {
              name: "TLSLocalAlert",
              message:
                version === TLS12_MINOR || mode === "native-ffdhe"
                  ? "handshake_failure: No mutual ciphersuite"
                  : "handshake_failure: No acceptable group advertised by client",
            },
          ]);
          return;
        }
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
        expect(observed.ecdhCurve).toBe(X25519);
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
        clientReader?.releaseLock();
      }
    },
    TEST_TIMEOUT_MS,
  );
}
