import assert from "node:assert/strict";
import { readFile, readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { readFrame } from "../../conformance/xml.ts";

const PROCESS_TIMEOUT_MS = 18000;
const DESCRIPTOR_TIMEOUT_MS = 3000;
const POLL_MS = 10;
const PROCESS_START_TIME_INDEX = 19;
const TCP_LOCAL_ADDRESS_INDEX = 1;
const TCP_REMOTE_ADDRESS_INDEX = 2;
const TCP_INODE_INDEX = 9;
const CLOSE = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>';
type Child = Bun.Subprocess<"pipe", "pipe", "pipe">;
type Owner = { pid: number; fd: string };
export type ClosureRecords = {
  version: number[];
  cipher: number;
  ecdhCurve: number;
  alerts: (string | number)[][];
  application: string[];
  eof: boolean;
  errors: { name: string; message: string }[];
};
export type Engine = "chromium" | "firefox" | "native-end" | "native-premature";

function responses(stream: Child["stdout"]) {
  const reader = stream.getReader();
  let pending = "";
  return {
    reader,
    async receive<T>() {
      while (!pending.includes("\n")) {
        const { done, value } = await reader.read();
        assert.equal(
          done,
          false,
          "TLS closure observer exited before its response",
        );
        pending += new TextDecoder().decode(value);
      }
      const newline = pending.indexOf("\n");
      const result = JSON.parse(pending.slice(0, newline)) as T;
      pending = pending.slice(newline + 1);
      return result;
    },
    async finish() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        pending += new TextDecoder().decode(value);
      }
      assert.equal(pending, "", "Unexpected observer stdout");
    },
  };
}

async function identity(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[
      PROCESS_START_TIME_INDEX
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

async function killOwnedProcess(pid: number, start: string) {
  // Check pinned identities before signalling; unlike pidfds, this is not atomic.
  if ((await identity(pid)) !== start) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

// Walk only the owned process tree. Bun can spawn from non-main threads.
async function descendants(pid: number, seen: Map<number, string>) {
  const start = await identity(pid);
  if (!start || (seen.has(pid) && seen.get(pid) !== start)) {
    return;
  }
  if (!seen.has(pid)) {
    seen.set(pid, start);
  }
  let tasks;
  try {
    tasks = await readdir(`/proc/${pid}/task`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return;
  }
  for (const task of tasks) {
    let children;
    try {
      children = await readFile(`/proc/${pid}/task/${task}/children`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      continue;
    }
    for (const child of children.trim().split(/\s+/).filter(Boolean)) {
      await descendants(Number(child), seen);
    }
  }
}

async function owners(pid: number, inode: string, seen: Map<number, string>) {
  await descendants(pid, seen);
  const result: Owner[] = [];
  for (const [process, start] of seen) {
    if ((await identity(process)) !== start) {
      continue;
    }
    let descriptors;
    try {
      descriptors = await readdir(`/proc/${process}/fd`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      continue;
    }
    for (const fd of descriptors) {
      try {
        if (
          (await readlink(`/proc/${process}/fd/${fd}`)) === `socket:[${inode}]`
        ) {
          result.push({ pid: process, fd });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  return result;
}

async function socketInode(pid: number, localPort: number, remotePort: number) {
  for (const table of ["tcp", "tcp6"]) {
    for (const row of (await readFile(`/proc/${pid}/net/${table}`, "utf8"))
      .trim()
      .split("\n")
      .slice(1)) {
      const columns = row.trim().split(/\s+/);
      if (
        parseInt(columns[TCP_LOCAL_ADDRESS_INDEX]!.split(":")[1]!, 16) ===
          localPort &&
        parseInt(columns[TCP_REMOTE_ADDRESS_INDEX]!.split(":")[1]!, 16) ===
          remotePort
      ) {
        assert.notEqual(columns[TCP_INODE_INDEX], "0");
        return columns[TCP_INODE_INDEX]!;
      }
    }
  }
  throw new Error("No exact connected TCP inode");
}

export async function observeClosure(
  engine: Engine,
  version: 3 | 4,
  directory: string,
) {
  assert.equal(
    process.platform,
    "linux",
    "Native descriptor evidence requires Linux /proc",
  );
  const native = engine.startsWith("native-");
  const peer = Bun.spawn(
    [
      process.env.XMPP_TEST_PYTHON ?? "python3",
      "conformance/fixtures/tls-closure.py",
      resolve(process.env.XMPP_TEST_TLS_PEER ?? "server/.cache/tls-peer"),
      directory,
      String(version),
      native ? "control" : "xmpp",
      "reciprocal-eof",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: PROCESS_TIMEOUT_MS,
    },
  );
  const peerResponses = responses(peer.stdout);
  const peerErrors = new Response(peer.stderr).text();
  let child: Child | undefined;
  let clientResponses: ReturnType<typeof responses> | undefined;
  let clientErrors: Promise<string> | undefined;
  const seen = new Map<number, string>();
  try {
    const ready = await peerResponses.receive<{
      port: number;
      tlslite: string;
    }>();
    assert.equal(ready.tlslite, "0.8.2");
    assert.ok(Number.isInteger(ready.port) && ready.port > 0);
    const nativeCode = `import assert from 'node:assert/strict';import{connect}from'node:tls';import{readFileSync}from'node:fs';
      assert.equal(process.versions.bun,undefined,'Native Node required');
      const keepAlive=setInterval(()=>{},1000);process.stdin.once('data',()=>{clearInterval(keepAlive);process.stdin.destroy();});
      console.log(JSON.stringify({phase:'ready',version:process.versions.node}));
      const socket=connect({host:'localhost',port:${ready.port},ca:readFileSync(${JSON.stringify(resolve(directory, "ca.pem"))}),rejectUnauthorized:true,minVersion:'TLSv1.${version - 1}',maxVersion:'TLSv1.${version - 1}',ecdhCurve:'X25519'});
      let received='',protocol;socket.on('secureConnect',()=>{assert.equal(socket.authorized,true);protocol=socket.getProtocol();socket.write('PING');});
      socket.on('data',data=>{received+=data.toString();if(received.length<4){return;}assert.equal(received,'PONG');socket.end(()=>${engine === "native-premature" ? "socket.destroy()" : "console.log(JSON.stringify({phase:'stopping'}))"});});
      socket.on('error',error=>{throw error;});socket.on('close',()=>{${engine === "native-premature" ? "console.log(JSON.stringify({phase:'stopping'}));" : ""}console.log(JSON.stringify({phase:'result',result:{authorized:true,protocol}}));});`;
    child = Bun.spawn(
      native
        ? [
            process.env.XMPP_TEST_NODE ?? "node",
            "--input-type=module",
            "--eval",
            nativeCode,
          ]
        : [
            process.execPath,
            "test/support/browser-tls-closure.ts",
            engine,
            directory,
            String(ready.port),
          ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: PROCESS_TIMEOUT_MS,
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "1" },
      },
    );
    clientResponses = responses(child.stdout);
    clientErrors = new Response(child.stderr).text();
    await descendants(child.pid, seen);
    const runtime = await clientResponses.receive<{
      phase: string;
      version: string;
    }>();
    assert.equal(runtime.phase, "ready");
    assert.match(runtime.version, /^\d+\.\d+(?:\.\d+){0,2}$/);
    await descendants(child.pid, seen);
    const connected = await peerResponses.receive<{
      phase: string;
      clientPort: number;
    }>();
    assert.equal(connected.phase, "connected");
    const inode = await socketInode(
      child.pid,
      connected.clientPort,
      ready.port,
    );
    assert.ok(
      (await owners(child.pid, inode, seen)).length > 0,
      "No owned connected descriptor",
    );
    peer.stdin.write("exchange\n");
    await peer.stdin.flush();
    const held = await peerResponses.receive<{
      phase: string;
      alerts?: ClosureRecords["alerts"];
      eof?: boolean;
      records?: ClosureRecords;
    }>();
    assert.ok(
      held.phase === "held" || held.phase === "eof",
      "Neither an authenticated alert nor explicit EOF",
    );
    if (held.phase === "held") {
      assert.deepEqual(held.alerts, [["received", 1, 0]]);
      assert.equal(held.eof, false);
    } else {
      assert.equal(held.records?.eof, true);
      assert.deepEqual(held.records?.alerts, []);
      assert.deepEqual(
        held.records?.errors.map((error) => error.name),
        ["TLSAbruptCloseError"],
      );
    }
    assert.deepEqual(await clientResponses.receive(), { phase: "stopping" });
    const retained = (await owners(child.pid, inode, seen)).length > 0;
    if (held.phase === "held") {
      peer.stdin.write("alert\n");
      await peer.stdin.flush();
      const sent = await peerResponses.receive<{
        phase: string;
        alerts: ClosureRecords["alerts"];
      }>();
      assert.equal(sent.phase, "sent");
      assert.deepEqual(sent.alerts, [
        ["received", 1, 0],
        ["sent", 1, 0],
      ]);
    }
    const deadline = Date.now() + DESCRIPTOR_TIMEOUT_MS;
    while (
      (await owners(child.pid, inode, seen)).length &&
      Date.now() < deadline
    ) {
      await Bun.sleep(POLL_MS);
    }
    assert.deepEqual(
      await owners(child.pid, inode, seen),
      [],
      "Descriptor retained after reciprocal alert",
    );
    const result = await clientResponses.receive<{
      phase: string;
      result: unknown;
      pageErrors?: string[];
    }>();
    assert.equal(result.phase, "result");
    if (native) {
      assert.deepEqual(result.result, {
        authorized: true,
        protocol: `TLSv1.${version - 1}`,
      });
    } else {
      assert.deepEqual(result.result, {
        address: "user@example.test/r",
        reply: "reply",
        errors: [],
      });
      assert.deepEqual(result.pageErrors, []);
    }
    peer.stdin.write("finish\n");
    await peer.stdin.flush();
    const records = await peerResponses.receive<ClosureRecords>();
    assert.deepEqual(records.version, [3, version]);
    assert.equal(records.cipher, version === 3 ? 0xc02f : 0x1301);
    assert.equal(records.ecdhCurve, 29);
    if (held.phase === "held") {
      assert.deepEqual(records.errors, []);
    } else {
      assert.deepEqual(records, held.records);
    }
    if (native) {
      assert.deepEqual(records.application, ["PING"]);
    } else {
      assert.equal(records.application.length, 7);
      for (const index of [0, 2]) {
        const events = readFrame(records.application[index]!);
        const root = events[0];
        assert.ok(root && "open" in root);
        assert.equal(root.open, "{urn:ietf:params:xml:ns:xmpp-framing}open");
        assert.equal(root.attributes["{}to"], "example.test");
        assert.equal(root.attributes["{}version"], "1.0");
        assert.deepEqual(events.slice(1), [{ close: root.open }]);
      }
      assert.deepEqual(
        readFrame(records.application[1]!),
        readFrame(
          '<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">AHVzZXIAcGFzc3dvcmQ=</auth>',
        ),
      );
      const binding = readFrame(records.application[3]!);
      const iq = binding[0];
      assert.ok(iq && "open" in iq && iq.attributes["{}id"]);
      // Only the generated correlation ID is normalized in this wire oracle.
      iq.attributes["{}id"] = "binding";
      assert.deepEqual(
        binding,
        readFrame(
          '<iq type="set" id="binding" xmlns="jabber:client"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>r</resource></bind></iq>',
        ),
      );
      assert.deepEqual(
        readFrame(records.application[4]!),
        readFrame(
          '<message to="friend@example.test" xmlns="jabber:client"><body>probe</body></message>',
        ),
      );
      assert.deepEqual(readFrame(records.application[5]!), readFrame(CLOSE));
      assert.equal(records.application[6], "WS_CLOSE");
    }
    child.stdin.write("finish\n");
    await child.stdin.flush();
    assert.deepEqual(
      await Promise.all([child.exited, clientErrors, peer.exited, peerErrors]),
      [0, "", 0, ""],
    );
    await Promise.all([clientResponses.finish(), peerResponses.finish()]);
    const reapedDeadline = Date.now() + DESCRIPTOR_TIMEOUT_MS;
    for (;;) {
      const remaining = await Promise.all(
        [...seen].map(async ([pid, start]) => (await identity(pid)) === start),
      );
      if (!remaining.some(Boolean)) {
        break;
      }
      assert.ok(Date.now() < reapedDeadline, "Owned subprocess not reaped");
      await Bun.sleep(POLL_MS);
    }
    return { version: runtime.version, alerts: records.alerts, retained };
  } finally {
    try {
      if (child) {
        await descendants(child.pid, seen);
      }
    } finally {
      try {
        for (const [pid, start] of [...seen].reverse()) {
          await killOwnedProcess(pid, start);
        }
      } finally {
        child?.kill();
        peer.kill();
        try {
          await Promise.all([
            child?.exited,
            peer.exited,
            clientErrors,
            peerErrors,
          ]);
        } finally {
          clientResponses?.reader.releaseLock();
          peerResponses.reader.releaseLock();
        }
      }
    }
  }
}
