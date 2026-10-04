import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { makeSelfSignedCertificate } from "../test/helpers.js";

const ENDPOINTS = [
  { host: "127.0.0.1", port: 5347 },
  { host: "::1", port: 5347 },
  { host: "127.0.0.1", port: 5280 },
  { host: "::1", port: 5280 },
  { host: "127.0.0.1", port: 5281 },
  { host: "::1", port: 5281 },
];

function readinessScenario(state, blocked, operation = "wait") {
  // A separate process prevents fake sockets from leaking into other suites.
  const result = execFileSync(
    process.execPath,
    [
      "--eval",
      `
        import net from "node:net";
        import fs from "node:fs/promises";
        import { EventEmitter } from "node:events";

        const output = process.stdout;
        const Socket = net.Socket;
        const readFile = fs.readFile;
        const blocked = ${JSON.stringify(blocked)};
        const open = ${JSON.stringify(state === "open")};
        const operation = ${JSON.stringify(operation)};
        const probes = [];
        const pending = new Set();
        let released = false;

        class FixtureSocket extends EventEmitter {
          connect(endpoint) {
            probes.push(endpoint);
            if (!released && endpoint.host === blocked.host && endpoint.port === blocked.port) {
              pending.add(this);
            } else {
              queueMicrotask(() => this.finish());
            }
            return this;
          }

          finish() {
            this.emit(open ? "connect" : "error", Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" }));
          }

          destroy() {
            pending.delete(this);
            return this;
          }
        }

        net.Socket = FixtureSocket;
        if (operation === "start") {
          fs.readFile = async (file, ...args) => file.endsWith("prosody.pid")
            ? "12345"
            : readFile(file, ...args);
        }
        try {
          const { default: server } = await import("./server/index.js");
          let settled = false;
          const ready = (operation === "start" ? server.start()
            : open ? server.waitPortOpen() : server.waitPortClose())
            .then(() => { settled = true; });
          // Advance the event loop, not a guessed listener startup duration.
          await new Promise((resolve) => setImmediate(resolve));
          const settledBeforeRelease = settled;
          released = true;
          for (const socket of pending) {
            socket.finish();
          }
          await ready;
          output.write(JSON.stringify({ settledBeforeRelease, probes, settled }));
        } finally {
          net.Socket = Socket;
          fs.readFile = readFile;
        }
      `,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  return JSON.parse(result);
}

for (const blocked of ENDPOINTS) {
  test(`Prosody start with an existing PID waits for ${blocked.host}:${blocked.port}`, () => {
    const result = readinessScenario("open", blocked, "start");
    expect(result.settledBeforeRelease).toBe(false);
    expect(result.settled).toBe(true);
    expect(result.probes).toEqual(expect.arrayContaining(ENDPOINTS));
  });
}

test("Prosody start with a stale PID fails without removing it or launching", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--eval",
      `
        import net from "node:net";
        import fs from "node:fs/promises";
        import childProcess from "node:child_process";
        import { EventEmitter } from "node:events";

        const output = process.stdout;
        let now = 0;
        let deletions = 0;
        let launches = 0;
        let preparations = 0;
        const timers = [];
        Date.now = () => now;
        fs.readFile = async () => "12345";
        fs.unlink = async () => { deletions += 1; };
        fs.mkdir = async () => { preparations += 1; throw new Error("Unexpected preparation"); };
        childProcess.exec = (_command, _options, callback) => {
          launches += 1;
          callback(null, "", "");
        };
        globalThis.setTimeout = (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return timer;
        };
        globalThis.clearTimeout = (timer) => { if (timer) { timer.cancelled = true; } };
        net.Socket = class extends EventEmitter {
          connect() {
            queueMicrotask(() => this.emit("error", Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" })));
            return this;
          }
          destroy() { return this; }
        };

        const { default: server } = await import("./server/index.js");
        let settled = false;
        const ready = server.start().then(() => {
          settled = true;
          return undefined;
        }, (error) => {
          settled = true;
          return error.message;
        });
        await new Promise((resolve) => setImmediate(resolve));
        const beforeDeadline = settled;
        now = 10000;
        const timer = timers.find(({ cancelled }) => !cancelled);
        if (timer && !settled) { timer.callback(); }
        const message = await ready;
        output.write(JSON.stringify({ beforeDeadline, message, deletions, launches, preparations }));
      `,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  const result = JSON.parse(output);
  expect(result.beforeDeadline).toBe(false);
  expect(result.message).toBe(
    `Prosody listeners did not become open in time: ${ENDPOINTS.map(({ host, port }) => `[${host}]:${port}`).join(", ")}.`,
  );
  expect(result.deletions).toBe(0);
  expect(result.launches).toBe(0);
  expect(result.preparations).toBe(0);
});

test.each([
  ...[5347, 5280, 5281].map((port) => ({ port, failure: "occupied" })),
  { port: 5281, failure: "timeout" },
  { port: 5281, failure: "EACCES" },
  { port: 5281, failure: "ECONNRESET" },
])(
  "Prosody refuses IPv6 endpoint %j before launching",
  async ({ port, failure }) => {
    const certificate = await makeSelfSignedCertificate();
    const output = execFileSync(
      process.execPath,
      [
        "--eval",
        `
          import net from "node:net";
          import fs from "node:fs/promises";
          import childProcess from "node:child_process";
          import { EventEmitter } from "node:events";

          const output = process.stdout;
          const occupied = { host: "::1", port: ${JSON.stringify(port)} };
          const failure = ${JSON.stringify(failure)};
          const certificate = ${JSON.stringify(certificate)};
          const probes = [];
          let launches = 0;
          class FixtureSocket extends EventEmitter {
            connect(endpoint) {
              probes.push(endpoint);
              const occupiedHere = endpoint.host === occupied.host && endpoint.port === occupied.port;
              if (!launches && occupiedHere && failure === "timeout") { return this; }
              const available = launches || (occupiedHere && failure === "occupied");
              const code = occupiedHere && failure !== "occupied" && failure !== "timeout" ? failure : "ECONNREFUSED";
              queueMicrotask(() => this.emit(available ? "connect" : "error", Object.assign(new Error(code), { code })));
              return this;
            }
            destroy() { return this; }
          }
          net.Socket = FixtureSocket;
          // Make prepare() use a valid in-memory certificate and provisioned data.
          fs.mkdir = async () => {};
          fs.access = async () => {};
          fs.unlink = async () => {};
          fs.readFile = async (file) => {
            if (file.endsWith("prosody.pid")) {
              throw Object.assign(new Error("No PID"), { code: "ENOENT" });
            }
            if (file.endsWith("localhost.crt")) { return certificate.cert; }
            if (file.endsWith("localhost.key")) { return certificate.private; }
            throw new Error("Unexpected fixture read: " + file);
          };
          childProcess.exec = (_command, _options, callback) => {
            launches += 1;
            callback(null, "", "");
          };
          const { default: server } = await import("./server/index.js");
          // Deliver probe timeouts as events, not elapsed wall-clock sleeps.
          globalThis.setTimeout = (callback) => {
            const timer = { cancelled: false };
            queueMicrotask(() => { if (!timer.cancelled) { callback(); } });
            return timer;
          };
          globalThis.clearTimeout = (timer) => { if (timer) { timer.cancelled = true; } };
          let message;
          try { await server.start(); } catch (error) { message = error.message; }
          output.write(JSON.stringify({ message, launches, probes }));
        `,
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    const result = JSON.parse(output);
    expect(result.launches).toBe(0);
    expect(result.message).toContain(
      failure === "occupied"
        ? "occupied"
        : failure === "timeout"
          ? "Timed out"
          : failure,
    );
    expect(result.message).toContain(String(port));
    expect(result.message).toContain("::1");
    expect(result.probes).toContainEqual({ host: "::1", port });
  },
);

for (const state of ["open", "closed"]) {
  test(`Prosody ${state} fails immediately on a non-transient probe error`, () => {
    const output = execFileSync(
      process.execPath,
      [
        "--eval",
        `
          import net from "node:net";
          import { EventEmitter } from "node:events";
          const { default: server } = await import("./server/index.js");

          const output = process.stdout;
          const open = ${JSON.stringify(state === "open")};
          const probes = [];
          // Pending fake timers cannot hide a rejection behind a poll or deadline.
          globalThis.setTimeout = () => ({});
          globalThis.clearTimeout = () => {};
          net.Socket = class extends EventEmitter {
            connect(endpoint) {
              probes.push(endpoint);
              const denied = endpoint.host === "::1" && endpoint.port === 5281;
              const code = denied ? "EACCES" : "ECONNREFUSED";
              queueMicrotask(() => this.emit(!denied && open ? "connect" : "error", Object.assign(new Error(code), { code })));
              return this;
            }
            destroy() { return this; }
          };
          let settled = false;
          let message;
          (open ? server.waitPortOpen() : server.waitPortClose()).then(() => {
            settled = true;
          }, (error) => {
            settled = true;
            message = error.message;
          });
          await new Promise((resolve) => setImmediate(resolve));
          output.write(JSON.stringify({ settled, message, probes }));
        `,
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    const result = JSON.parse(output);
    expect(result.settled).toBe(true);
    expect(result.message).toBe(
      "Cannot probe Prosody listener [::1]:5281: EACCES",
    );
    expect(result.probes).toEqual(ENDPOINTS);
  });

  for (const blocked of ENDPOINTS) {
    test(`Prosody fixture waits for ${blocked.host}:${blocked.port} to be ${state}`, () => {
      const result = readinessScenario(state, blocked);
      expect(result.settledBeforeRelease).toBe(false);
      expect(result.settled).toBe(true);
      expect(result.probes).toEqual(expect.arrayContaining(ENDPOINTS));
    });
  }

  for (const { failure, recovery = false } of [
    { failure: "opposite state" },
    { failure: "unknown state" },
    { failure: "connection reset" },
    { failure: "connection reset", recovery: true },
  ]) {
    const name = recovery
      ? `Prosody ${state} recovers from connection reset only on a confirmed listener state`
      : `Prosody ${state} deadline retains ${failure} and caps retries`;
    test(name, () => {
      const output = execFileSync(
        process.execPath,
        [
          "--eval",
          `
          import net from "node:net";
          import { EventEmitter } from "node:events";
          const { default: server } = await import("./server/index.js");

          const output = process.stdout;
          const open = ${JSON.stringify(state === "open")};
          const unknown = ${JSON.stringify(failure === "unknown state")};
          const reset = ${JSON.stringify(failure === "connection reset")};
          const recovery = ${JSON.stringify(recovery)};
          let now = 0;
          const timers = [];
          Date.now = () => now;
          globalThis.setTimeout = (callback, timeout) => {
            const timer = { callback, timeout, at: now, cancelled: false, fired: false };
            timers.push(timer);
            return timer;
          };
          globalThis.clearTimeout = (timer) => { if (timer) { timer.cancelled = true; } };
          net.Socket = class extends EventEmitter {
            connect({ host, port }) {
              const blocked = host === "::1" && port === 5281;
              if (blocked && unknown) { return this; }
              if (blocked && reset && (!recovery || now < 9950)) {
                queueMicrotask(() => this.emit("error", Object.assign(new Error("Connection reset"), { code: "ECONNRESET" })));
                return this;
              }
              const available = blocked && !recovery ? !open : open;
              queueMicrotask(() => this.emit(available ? "connect" : "error", Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" })));
              return this;
            }
            destroy() { return this; }
          };

          let settled = false;
          const result = (open ? server.waitPortOpen() : server.waitPortClose())
            .then(() => { settled = true; return undefined; }, (error) => {
              settled = true;
              return error.message;
            });
          await new Promise((resolve) => setImmediate(resolve));
          const beforeDeadline = settled;
          if (unknown) {
            now = 1000;
            const timer = timers.find(({ cancelled, fired }) => !cancelled && !fired);
            timer.fired = true;
            timer.callback();
            await new Promise((resolve) => setImmediate(resolve));
          }
          const afterProbeTimeout = settled;
          if (!settled) {
            now = 9950;
            const timer = timers.find(({ cancelled, fired }) => !cancelled && !fired);
            timer.fired = true;
            timer.callback();
            await new Promise((resolve) => setImmediate(resolve));
          }
          const nearDeadline = settled;
          const retries = timers.filter(({ at }) => at === 9950).map(({ timeout }) => timeout);
          now = 10000;
          for (let step = 0; step < 10 && !settled; step += 1) {
            const timer = timers.find(({ cancelled, fired }) => !cancelled && !fired);
            if (!timer) { break; }
            timer.fired = true;
            timer.callback();
            await new Promise((resolve) => setImmediate(resolve));
          }
          const message = settled ? await result : "Readiness did not settle";
          output.write(JSON.stringify({ beforeDeadline, afterProbeTimeout, nearDeadline, message, retries }));
        `,
        ],
        { encoding: "utf8", timeout: 3000 },
      );
      const result = JSON.parse(output);
      expect(result.beforeDeadline).toBe(false);
      expect(result.afterProbeTimeout).toBe(false);
      expect(result.nearDeadline).toBe(recovery);
      expect(result.message).toBe(
        recovery
          ? undefined
          : `Prosody listeners did not become ${state} in time: [::1]:5281.`,
      );
      expect(result.retries.length).toBeGreaterThan(0);
      expect(
        result.retries.every((timeout) => timeout > 0 && timeout <= 50),
      ).toBe(true);
    });
  }
}
