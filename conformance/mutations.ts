import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const MUTATION_TIMEOUT_MS = 15_000;

const mutations = [
  {
    name: "accept an IQ reply from an unrelated sender",
    file: "src/iq/caller.js",
    before: "!deferred || !replyMatches(stanza.attrs.from, deferred)",
    after: "!deferred",
    suite: "conformance/rfc6120.test.ts",
    test: "IQ ignores a forged",
  },
  {
    name: "accept an unsupported stream version",
    file: "src/websocket/lib/FramedParser.js",
    before: "if (!version || Number(version[1]) !== 1)",
    after: "if (false)",
    suite: "src/websocket/test/frames.test.js",
    test: "rejects unsupported peer version",
  },
  {
    name: "omit the outgoing language context",
    file: "src/websocket/lib/Connection.js",
    before:
      'element.attrs["xml:lang"] ??= this.root?.attrs["xml:lang"];\n    return super.send',
    after: "return super.send",
    suite: "conformance/rfc7395.test.ts",
    test: "every outgoing stanza carries its language",
  },
  {
    name: "remove the document byte limit",
    file: "src/xml/lib/parseDocument.js",
    before: "export const MAX_XML_BYTES = 1024 * 1024;",
    after: "export const MAX_XML_BYTES = Infinity;",
    suite: "src/xml/test/limits.test.js",
    test: "document byte limit",
  },
  {
    name: "remove the document depth limit",
    file: "src/xml/lib/parseDocument.js",
    before: "const MAX_XML_DEPTH = 64;",
    after: "const MAX_XML_DEPTH = Infinity;",
    suite: "src/xml/test/limits.test.js",
    test: "document depth limit",
  },
  {
    name: "accept an unfinished XML document",
    file: "src/xml/lib/parseDocument.js",
    before: "parser.write(source).close();",
    after: "parser.write(source);",
    suite: "src/websocket/test/frames.test.js",
    test: "rejects a whole malformed frame",
  },
  {
    name: "report the wrong framing namespace condition",
    file: "src/websocket/lib/FramedParser.js",
    before: 'error.condition = "invalid-namespace";',
    after: 'error.condition = "bad-format";',
    suite: "src/websocket/test/frames.test.js",
    test: "reports invalid-namespace",
  },
  {
    name: "accept an unnegotiated subprotocol",
    file: "src/websocket/lib/Socket.js",
    before: "this.socket.protocol !== SUBPROTOCOL",
    after: "false",
    suite: "src/websocket/test/subprotocol.test.js",
    test: "rejects negotiated subprotocol",
  },
  {
    name: "omit the outgoing stanza namespace",
    file: "src/websocket/lib/Connection.js",
    before: "send(element, ...args) {\n    element.attrs.xmlns ??= this.NS;",
    after: "send(element, ...args) {\n    /* namespace omitted */",
    suite: "conformance/rfc7395.test.ts",
    test: "sends UTF-8 text",
  },
  {
    name: "open a stream to the wrong domain",
    file: "src/connection/index.js",
    before: "headerElement.attrs.to = domain;",
    after: 'headerElement.attrs.to = "wrong.test";',
    suite: "conformance/rfc7395.test.ts",
    test: "first message is a standalone",
  },
];

// Mutate disposable copies; never alter the worktree or dependencies.
for (const mutation of mutations) {
  const directory = mkdtempSync(join(tmpdir(), "xmpp-mutation-"));
  try {
    cpSync("src", join(directory, "src"), { recursive: true });
    for (const file of [
      "package.json",
      "conformance/rfc7395.test.ts",
      "conformance/rfc6120.test.ts",
      "conformance/peer.ts",
      "conformance/xml.ts",
    ]) {
      cpSync(file, join(directory, file));
    }
    symlinkSync(
      resolve("node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    const args = ["test", mutation.suite, "--test-name-pattern", mutation.test];
    const options = {
      cwd: directory,
      encoding: "utf8" as const,
      timeout: MUTATION_TIMEOUT_MS,
    };
    const baseline = spawnSync(process.execPath, args, options);
    if (baseline.status !== 0 || !baseline.stderr.includes("(pass)")) {
      throw new Error(
        `Mutation baseline failed: ${mutation.name}\n${baseline.stderr}`,
      );
    }

    const path = join(directory, mutation.file);
    const source = readFileSync(path, "utf8");
    if (source.split(mutation.before).length !== 2) {
      throw new Error(
        `Mutation target must occur exactly once: ${mutation.name}`,
      );
    }
    writeFileSync(path, source.replace(mutation.before, mutation.after));
    const result = spawnSync(process.execPath, args, options);
    // Crashes and timeouts do not prove that an assertion caught the defect.
    if (
      result.status !== 1 ||
      !result.stderr.includes("error: expect(received)")
    ) {
      throw new Error(
        `Mutation survived or failed outside an assertion: ${mutation.name}\n${result.stderr}`,
      );
    }
    console.log(`Caught mutation: ${mutation.name}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
