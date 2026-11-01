import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

const FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAM = "http://etherx.jabber.org/streams";
const SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const PROCESS_TIMEOUT_MS = 5000;
const OBSERVATION_MS = 50;
const HTTP_BAD_REQUEST = 400;
let directory: string;
let certificate: Awaited<ReturnType<typeof generate>>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "xmpp-discovery-cancellation-"));
  const authority = await generate(
    [{ name: "commonName", value: "Cancellation fixture CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, critical: true },
      ],
    },
  );
  await writeFile(join(directory, "ca.pem"), authority.cert);
  certificate = await generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    ca: { key: authority.private, cert: authority.cert },
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
    ],
  });
});
afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

// XEP-0156 discovery is preparatory work, not a fresh user connection request.
// Cancellation/replacement ownership is local lifecycle policy (#93), consistent
// with RFC 6120 §4.4 / RFC 7395 §3.6; it is not an extra XEP wire requirement.
// Fetch is a controlled noncooperative seam. WSS and its CA/hostname checks are
// real native behavior; neither a TLS adapter nor a verification bypass is used.
for (const phase of ["headers", "body"] as const) {
  for (const cancel of ["stop", "disconnect"] as const) {
    test(`XEP-0156 lifecycle: ${cancel} retires pending ${phase} before credentials and permits fresh start`, async () => {
      const requests: string[] = [];
      const frames: { path: string; source: string }[] = [];
      const server = Bun.serve<{ path: string; authenticated: boolean }>({
        hostname: "127.0.0.1",
        port: 0,
        tls: { cert: certificate.cert, key: certificate.private },
        fetch(request, server) {
          const path = new URL(request.url).pathname;
          requests.push(path);
          if (
            server.upgrade(request, {
              headers: { "Sec-WebSocket-Protocol": "xmpp" },
              data: { path, authenticated: false },
            })
          ) {
            return;
          }
          return new Response("Expected upgrade", { status: HTTP_BAD_REQUEST });
        },
        websocket: {
          message(socket, data) {
            const source = String(data);
            frames.push({ path: socket.data.path, source });
            if (source.startsWith("<open")) {
              socket.send(
                `<open xmlns="${FRAMING}" from="example.test" version="1.0"/>`,
              );
              socket.send(
                `<features xmlns="${STREAM}">${socket.data.authenticated ? `<bind xmlns="${BIND}"/>` : `<mechanisms xmlns="${SASL}"><mechanism>PLAIN</mechanism></mechanisms>`}</features>`,
              );
            } else if (source.startsWith("<auth")) {
              socket.data.authenticated = true;
              socket.send(`<success xmlns="${SASL}"/>`);
            } else if (source.startsWith("<iq")) {
              const id = / id="([^"]+)"/.exec(source)![1];
              socket.send(
                `<iq xmlns="jabber:client" type="result" id="${id}"><bind xmlns="${BIND}"><jid>user@example.test/r</jid></bind></iq>`,
              );
            } else if (source.startsWith("<close")) {
              socket.send(`<close xmlns="${FRAMING}"/>`);
            }
          },
        },
      });
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            "--eval",
            `
          import {client} from './src/client/index.js';
          const entered=Promise.withResolvers(), release=Promise.withResolvers();
          let body, cancelled=false, signal;
          const document='<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="urn:xmpp:alt-connections:websocket" href="wss://localhost:${server.port}/cancelled"/></XRD>';
          globalThis.fetch=async (_url,options)=>{
            signal=options.signal;
            if(${JSON.stringify(phase)}==='headers'){entered.resolve();return release.promise;}
            return new Response(new ReadableStream({
              start(controller){body=controller;controller.enqueue(new TextEncoder().encode(document));},
              pull(){entered.resolve();},cancel(){cancelled=true;}
            }));
          };
          const c=client({service:'discovery.example',domain:'example.test',username:'user',password:'secret',timeout:500});
          c.reconnect.stop();const events=[],errors=[];
          c.on('connect',()=>events.push('connect'));c.on('online',()=>events.push('online'));c.on('error',e=>errors.push(e.message));
          const pending=c.start().then(()=>({state:'connected'}),error=>({state:'rejected',name:error.name}));
          await entered.promise;await c[${JSON.stringify(cancel)}]();
          let timer;const result=await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve({state:'pending'}),${OBSERVATION_MS})})]);clearTimeout(timer);
          const aborted=signal.aborted;
          if(${JSON.stringify(phase)}==='headers')release.resolve(new Response(document));
          else if(!cancelled)body.close();
          await pending;
          const retired={result,aborted,cancelled,status:c.status,events:[...events],errors:[...errors]};
          await c.stop();events.length=0;errors.length=0;
          Object.assign(c.options,{service:'wss://localhost:${server.port}/fresh'});
          const fresh=(await c.start()).toString();
          await c.stop();
          console.log(JSON.stringify({retired,fresh,events,errors}));
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
            timeout: PROCESS_TIMEOUT_MS,
          },
        );
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        const result = JSON.parse(stdout);
        expect(result.retired.result).toEqual({
          state: "rejected",
          name: "AbortError",
        });
        expect(result.retired.aborted).toBe(true);
        if (phase === "body") {
          expect(result.retired.cancelled).toBe(true);
        }
        expect(result.retired.events).toEqual([]);
        expect(result.retired.errors).toEqual([]);
        expect(result.fresh).toBe("user@example.test/r");
        expect(result.events).toEqual(["connect", "online"]);
        expect(result.errors).toEqual([]);
        expect(requests).toEqual(["/fresh"]);
        expect(frames.every(({ path }) => path === "/fresh")).toBe(true);
        expect(frames.some(({ source }) => source.startsWith("<auth"))).toBe(
          true,
        );
      } finally {
        await server.stop(true);
      }
    });
  }
}
