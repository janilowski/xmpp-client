import { expect, test } from "bun:test";
import server from "./index.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("fixture configuration is isolated from the repository", () => {
  expect(server.configPath).toBeDefined();
  expect(server.configPath).not.toBe(`${process.cwd()}/server/prosody.cfg.lua`);
});

test("module toggles and reset leave the source configuration unchanged", async () => {
  const original = await readFile("server/prosody.cfg.lua", "utf8");
  const runtime = await mkdtemp(path.join(tmpdir(), "xmpp-fixture-"));
  execFileSync(
    process.execPath,
    [
      "--eval",
      `
    const { default: server } = await import('./server/index.js');
    await server.reset();
    await server.disableModules(['smacks']);
  `,
    ],
    { env: { ...process.env, XMPP_TEST_DIR: runtime } },
  );
  expect(
    await readFile(path.join(runtime, "prosody.cfg.lua"), "utf8"),
  ).toContain('-- "smacks";');
  expect(await readFile("server/prosody.cfg.lua", "utf8")).toBe(original);
  execFileSync(
    process.execPath,
    [
      "--eval",
      `
    const { default: server } = await import('./server/index.js');
    await server.reset();
  `,
    ],
    { env: { ...process.env, XMPP_TEST_DIR: runtime } },
  );
  expect(await readFile(path.join(runtime, "prosody.cfg.lua"), "utf8")).toBe(
    original,
  );
});
