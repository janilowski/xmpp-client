import { expect, test } from "bun:test";

const CHILD_TIMEOUT_MS = 5000;
const OBSERVER_ERROR = "Native ClientHello observer exited before its response";

// Harness controls, not RFC requirements: failures must retain their cause,
// reap their observer and release its reader without weakening successful runs.
test.each(["startup", "exercise", "exit", "stderr", "valid"] as const)(
  "ClientHello observer cleanup / %s",
  async (scenario) => {
    const observer = `
      import {createInterface} from 'node:readline';
      console.log(JSON.stringify({type:'ready',port:1}));
      for await (const line of createInterface({input:process.stdin})) {
        if(line==='snapshot') {
          const body=Buffer.from('0303'+'00'.repeat(32)+'00'+'0002c02f'+'0100'+'0000','hex');
          const handshake=Buffer.concat([Buffer.from([1,0,0,body.length]),body]);
          const record=Buffer.concat([Buffer.from([22,3,1,0,handshake.length]),handshake]);
          console.log(JSON.stringify({type:'snapshot',hellos:[record.toString('base64')],errors:[]}));
        }
        if(line==='stop') {
          ${scenario === "exercise" || scenario === "stderr" ? "console.error('observer cleanup diagnostic');" : ""}
          process.exit(${scenario === "exercise" || scenario === "exit" ? 7 : 0});
        }
      }
    `;
    const source = `
      import {observeOffers} from './conformance/tls-offers.ts';
      const spawn=Bun.spawn;
      let peer;
      Bun.spawn=(args,options)=>peer=spawn(${scenario === "startup" ? "args" : JSON.stringify([process.execPath, "--eval", observer])},options);
      const unhandled=[];
      process.on('unhandledRejection',error=>unhandled.push(String(error)));
      let result;
      try {
        const hellos=await observeOffers(async()=>{${scenario === "exercise" ? "throw new Error('exercise failed');" : ""}});
        result={ciphers:hellos.map(hello=>hello.ciphers)};
      } catch(error) {
        result={error:String(error),code:error.code};
      }
      const exit=await peer.exited;
      await new Promise(resolve=>setImmediate(resolve));
      console.log(JSON.stringify({result,exit,locked:peer.stdout.locked,unhandled}));
    `;
    const child = Bun.spawn([process.execPath, "--eval", source], {
      env: { ...process.env, XMPP_TEST_NODE: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const observed = JSON.parse(stdout);
    if (scenario === "startup") {
      expect(observed.result.error).toContain(OBSERVER_ERROR);
      expect(observed.result.code).not.toBe("EPIPE");
    } else if (scenario === "exercise") {
      expect(observed.result.error).toBe("Error: exercise failed");
    } else if (scenario === "valid") {
      expect(observed.result).toEqual({ ciphers: [["c02f"]] });
    } else {
      expect(observed.result.error).toContain("AssertionError");
      expect(observed.result.error).toContain(
        scenario === "exit" ? "7" : "observer cleanup diagnostic",
      );
    }
    expect(observed.exit).toBeNumber();
    expect(observed.locked).toBe(false);
    expect(observed.unhandled).toEqual([]);
  },
  CHILD_TIMEOUT_MS * 2,
);
