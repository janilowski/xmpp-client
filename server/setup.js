import { execFileSync } from "node:child_process";

// Keep server extensions reproducible independently of their latest releases.
const modules = [
  "mod_sasl2-37-1",
  "mod_sasl2_bind2-19-1",
  "mod_sasl2_sm-14-1",
  "mod_sasl2_fast-34-1",
];
for (const module of modules) {
  execFileSync(
    "prosodyctl",
    [
      "--config",
      "prosody.cfg.lua",
      "install",
      `https://modules.prosody.im/rocks/${module}.src.rock`,
    ],
    { cwd: "server", stdio: "inherit" },
  );
}
