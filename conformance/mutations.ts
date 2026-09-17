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
    name: "allow callback to bypass PLAIN transport policy",
    file: "src/client/lib/createOnAuthenticate.js",
    before: "mechanism === PLAIN && !entity.isSecure()",
    after: "false",
    suite: "src/client/test/authentication-policy.test.js",
    test: "policy / insecure",
  },
  {
    name: "allow callback to select unoffered mechanisms",
    file: "src/client/lib/createOnAuthenticate.js",
    before: "!mechanisms.includes(mechanism)",
    after: "false",
    suite: "src/client/test/authentication-policy.test.js",
    test: "policy / unoffered",
  },
  {
    name: "restart without successful SASL authentication",
    file: "src/client/lib/createOnAuthenticate.js",
    before: "if (!authenticated)",
    after: "if (false)",
    suite: "conformance/rfc6120-sasl.test.ts",
    test: "callback cannot authorize restart",
  },
  {
    name: "omit server-first SASL initiation",
    file: "src/sasl/index.js",
    before: 'xml("auth", { xmlns: NS, mechanism: mech.name }, response)',
    after:
      'mech.clientFirst && xml("auth", { xmlns: NS, mechanism: mech.name }, response)',
    suite: "conformance/rfc6120-sasl.test.ts",
    test: "server-first exchange",
  },
  {
    name: "omit explicit empty SASL initial response",
    file: "src/sasl/index.js",
    before: 'encode(await mech.response(creds)) || "="',
    after: "encode(await mech.response(creds))",
    suite: "conformance/rfc6120-sasl.test.ts",
    test: "empty-initial exchange",
  },
  {
    name: "discard binary SASL responses",
    file: "src/sasl/index.js",
    before: 'resp == null ? "" : encode(resp)',
    after: 'typeof resp === "string" ? encode(resp) : ""',
    suite: "conformance/rfc6120-sasl.test.ts",
    test: "binary exchange",
  },
  {
    name: "reject explicit empty SASL success data",
    file: "src/sasl/index.js",
    before: 'element.text() === "=" ? "" : element.text()',
    after: "element.text()",
    suite: "conformance/rfc6120-sasl.test.ts",
    test: "empty-final exchange",
  },
  {
    name: "omit SASLprep password normalization",
    file: "src/sasl-scram/index.js",
    before: 'password = saslprep(password, "stored");',
    after: "",
    suite: "conformance/rfc5802.test.js",
    test: "prepares credentials before hashing",
  },
  {
    name: "allow unassigned stored SCRAM passwords",
    file: "src/sasl-scram/saslprep.js",
    before: 'if (profile === "stored") {',
    after: "if (false) {",
    suite: "conformance/rfc4013.test.js",
    test: "stored password rejects",
  },
  {
    name: "omit SASLprep bidi enforcement",
    file: "src/sasl-scram/saslprep.js",
    before: "if (RANDAL.test(normalized)) {",
    after: "if (false) {",
    suite: "conformance/rfc4013.test.js",
    test: "prohibited output / bidi",
  },
  {
    name: "ignore SCRAM server signature",
    file: "src/sasl-scram/index.js",
    before: "if (!valid) {",
    after: "if (false) {",
    suite: "conformance/rfc5802.test.js",
    test: "reject missing, forged or ambiguous",
  },
  {
    name: "skip SASL final verification",
    file: "src/sasl/index.js",
    before: "if (mech.final) {",
    after: "if (false) {",
    suite: "conformance/rfc5802-wire.test.ts",
    test: "missing server proof",
  },
  {
    name: "skip SASL2 verification when proof is absent",
    file: "src/sasl2/index.js",
    before: "if (mech.final) {",
    after: "if (additionalData && mech.final) {",
    suite: "conformance/rfc5802-wire.test.ts",
    test: "missing server proof",
  },
  {
    name: "accept expired XRD metadata",
    file: "src/resolve/lib/http.js",
    before: "!isUnexpired(expires[0])",
    after: "false",
    suite: "conformance/xep0156.test.js",
    test: "XRD expiry:",
  },
  {
    name: "compare XRD relation types case-sensitively",
    file: "src/resolve/lib/http.js",
    before: "METHODS.get(attrs.rel?.toLowerCase())",
    after: "METHODS.get(attrs.rel)",
    suite: "conformance/xep0156.test.js",
    test: "relation and URI scheme comparisons",
  },
  {
    name: "remove the HTTPS discovery deadline",
    file: "src/resolve/lib/http.js",
    before: "signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),",
    after: "",
    suite: "conformance/xep0156-https.test.ts",
    test: "local deadline bounds HTTPS discovery: body",
  },
  {
    name: "follow discovery redirects including plaintext targets",
    file: "src/resolve/lib/http.js",
    before: 'redirect: "error",',
    after: 'redirect: "follow",',
    suite: "conformance/xep0156-https.test.ts",
    test: "redirect policy never contacts",
  },
  {
    name: "treat discovery document order as priority",
    file: "src/resolve/lib/alt-connections.js",
    before: "return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;",
    after: "return 0;",
    suite: "conformance/xep0156.test.js",
    test: "endpoint preference ignores document order",
  },
  {
    name: "accept resource templates as host-wide endpoints",
    file: "src/resolve/lib/http.js",
    before: "if (attrs.template !== undefined) {",
    after: "if (false) {",
    suite: "conformance/xep0156.test.js",
    test: "excludes resource templates",
  },
  {
    name: "drop decoded Unicode ranges",
    file: "src/util/unicode-ranges.js",
    before: 'return new RegExp(`[${parts.join("")}]`, "u");',
    after: 'return new RegExp("[]", "u");',
    suite: "src/jid/test/unicode.test.js",
    test: "all Unicode 16 property tables preserve",
  },
  {
    name: "omit JID NFC normalization",
    file: "src/jid/lib/precis.js",
    before: 'value = value.toLowerCase().normalize("NFC");',
    after: "value = value.toLowerCase();",
    suite: "conformance/rfc7622.test.js",
    test: "normalizes equivalent identities",
  },
  {
    name: "omit JID byte limits",
    file: "src/jid/lib/precis.js",
    before: "export function checkLength(value) {",
    after: "export function checkLength(value) { return value;",
    suite: "conformance/rfc7622.test.js",
    test: "post-preparation UTF-8 limits",
  },
  {
    name: "omit JID contextual rules",
    file: "src/jid/lib/precis.js",
    before: "if (!valid) {",
    after: "if (false) {",
    suite: "conformance/rfc7622.test.js",
    test: "rejects localpart",
  },
  {
    name: "omit JID bidi checks",
    file: "src/jid/lib/precis.js",
    before: "export function validateBidi(value) {",
    after: "export function validateBidi(value) { return;",
    suite: "conformance/rfc7622.test.js",
    test: "rejects localpart",
  },
  {
    name: "accept IDNA-disallowed identifier characters",
    file: "src/jid/lib/domain.js",
    before: "if (unicode.idnaDisallowed.test(label)) {",
    after: "if (false) {",
    suite: "conformance/rfc7622.test.js",
    test: "rejects domain",
  },
  {
    name: "silently ignore invalid SM counters",
    file: "src/stream-management/index.js",
    before: "if (!valid || distance > sm.outbound_q.length) {",
    after: "if (!valid || distance > sm.outbound_q.length) { return;",
    suite: "conformance/xep0198.test.ts",
    test: "invalid SM acknowledgement",
  },
  {
    name: "omit SM inbound counter rollover",
    file: "src/stream-management/index.js",
    before: "sm.inbound = (sm.inbound + 1) % COUNTER_MODULUS;",
    after: "sm.inbound += 1;",
    suite: "src/stream-management/counters.test.js",
    test: "received stanza counter wraps",
  },
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
    cpSync("test/support", join(directory, "test/support"), {
      recursive: true,
    });
    for (const file of [
      "package.json",
      "tsconfig.json",
      "bunfig.toml",
      "conformance/rfc7395.test.ts",
      "conformance/rfc6120.test.ts",
      "conformance/rfc6120-sasl.test.ts",
      "conformance/rfc5802.test.js",
      "conformance/rfc4013.test.js",
      "conformance/rfc5802-wire.test.ts",
      "conformance/xep0198.test.ts",
      "conformance/xep0156.test.js",
      "conformance/xep0156-https.test.ts",
      "conformance/rfc7622.test.js",
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
