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
    name: "reuse the former resource after stream conflict",
    file: "src/resource-binding/index.js",
    before: 'error instanceof StreamError && error.condition === "conflict"',
    after: "false",
    suite: "conformance/rfc6120-binding.test.ts",
    test: "resource selection on reconnect / fixed",
  },
  {
    name: "compare conflicted resources before Unicode preparation",
    file: "src/resource-binding/index.js",
    before: "(!selected || selected === conflictedResource)",
    after: "(!selected || requested === conflictedResource)",
    suite: "conformance/rfc6120-binding.test.ts",
    test: "resource selection on reconnect / normalized",
  },
  {
    name: "retain feature deadline during local close",
    file: "src/stream-features/index.js",
    before: 'entity.on("closing", clearFeatureTimer);',
    after: "",
    suite: "conformance/rfc6120-streams.test.ts",
    test: "clear features deadline / silent stop",
  },
  {
    name: "enable SM before SASL2 inline binding finishes",
    file: "src/stream-management/stream-feature.js",
    before: "await streamFeatures.authentication;",
    after: "",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "permits inline binding only after verification / TEST-NEGOTIATION",
  },
  {
    name: "leave stream features unbounded",
    file: "src/stream-features/index.js",
    before: 'entity.on("open", () => {',
    after: 'entity.on("unused-open", () => {',
    suite: "conformance/rfc6120-streams.test.ts",
    test: "local features deadline / start / initial",
  },
  {
    name: "retain feature deadline after negotiation",
    file: "src/stream-features/index.js",
    before: "    clearFeatureTimer();\n    if (\n      stanza",
    after: "    if (\n      stanza",
    suite: "conformance/rfc6120-streams.test.ts",
    test: "clear features deadline / online",
  },
  {
    name: "enable Stream Management before binding",
    file: "src/stream-management/stream-feature.js",
    before: 'if (entity.status !== "online")',
    after: "if (false)",
    suite: "conformance/rfc6120-streams.test.ts",
    test: "SM without binding",
  },
  {
    name: "accept multi-payload IQ results",
    file: "src/iq/caller.js",
    before: "children.length > 1 || errors.length !== 0",
    after: "errors.length !== 0",
    suite: "conformance/rfc6120-iq.test.ts",
    test: "two result payloads",
  },
  {
    name: "omit required IQ response ID",
    file: "src/iq/callee.js",
    before: 'id: stanza.attrs.id ?? "",',
    after: "id: stanza.attrs.id,",
    suite: "conformance/rfc6120-iq.test.ts",
    test: "request get $",
  },
  {
    name: "accept unknown stanza error conditions as understood",
    file: "src/error/index.js",
    before: "(!known || known.has(condition))",
    after: "true",
    suite: "conformance/rfc6120-iq.test.ts",
    test: "namespaced stanza error / future-condition",
  },
  {
    name: "leave unsupported features pending",
    file: "src/stream-features/index.js",
    before: 'entity.status === "open"',
    after: "false",
    suite: "conformance/rfc6120-streams.test.ts",
    test: "empty before authentication",
  },
  {
    name: "remove reconnect jitter",
    file: "src/reconnect/index.js",
    before: "0.5 + Math.random() / 2",
    after: "1",
    suite: "./src/reconnect/test.js",
    test: "randomizes the initial delay",
  },
  {
    name: "remove reconnect backoff",
    file: "src/reconnect/index.js",
    before: "this.#attempt++;",
    after: "",
    suite: "./src/reconnect/test.js",
    test: "grows to a cap",
  },
  {
    name: "bind before asynchronous SASL2 proof verification completes",
    file: "src/resource-binding/index.js",
    before: "await streamFeatures.authentication;",
    after: "",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "SASL2 success permits classic binding",
  },
  {
    name: "accept overlapping SASL messages",
    file: "src/sasl/exchange.js",
    before: "responding ||",
    after: "false ||",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "overlapping success",
  },
  {
    name: "respond after protocol abort",
    file: "src/sasl/exchange.js",
    before: "aborted = true;",
    after: "aborted = false;",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "abort permits",
  },
  {
    name: "accept non-bare authorization identities",
    file: "src/sasl/credentials.js",
    before: "if (!identity.local || identity.resource)",
    after: "if (false)",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "authorization identity",
  },
  {
    name: "invent an authentication realm from the domain",
    file: "src/sasl/credentials.js",
    before: "serviceName: domain,",
    after: "serviceName: domain, realm: domain,",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "no implicit authentication realm",
  },
  {
    name: "reenter SASL from duplicate features",
    file: "src/sasl/index.js",
    before: "streamFeatures.authenticating || streamFeatures.authenticated",
    after: "false",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "duplicate features",
  },
  {
    name: "omit generic fallback for unknown SASL conditions",
    file: "src/sasl/lib/SASLError.js",
    before: "CONDITIONS.has(condition?.name)",
    after: "!!condition",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "unknown/malformed failure",
  },
  {
    name: "allow callback downgrade to PLAIN",
    file: "src/client/lib/createOnAuthenticate.js",
    before: "mechanism === PLAIN && mechanisms.indexOf(PLAIN) > 0",
    after: "false",
    suite: "src/client/test/authentication-policy.test.js",
    test: "policy / downgrade",
  },
  {
    name: "retain connection after exhausted authentication",
    file: "src/client/lib/createOnAuthenticate.js",
    before: "if (socket && entity.socket === socket)",
    after: "if (false)",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "exhausted authentication",
  },
  {
    name: "omit authenticated state after SASL2",
    file: "src/sasl2/index.js",
    before: "streamFeatures.authenticated = true;",
    after: "streamFeatures.authenticated = false;",
    suite: "conformance/rfc6120-sasl-negotiation.test.ts",
    test: "SASL2 success permits classic binding",
  },
  {
    name: "accept a bare binding identity",
    file: "src/resource-binding/index.js",
    before: "if (!jid.local || !jid.resource)",
    after: "if (false)",
    suite: "conformance/rfc6120-binding.test.ts",
    test: "invalid binding result",
  },
  {
    name: "bind before authentication",
    file: "src/resource-binding/index.js",
    before: "if (!streamFeatures.authenticated)",
    after: "if (false)",
    suite: "conformance/rfc6120-binding.test.ts",
    test: "premature binding",
  },
  {
    name: "skip SASL success encoding validation without final hook",
    file: "src/sasl/exchange.js",
    before: "const final = mech.binary ? decodeBytes(data) : decode(data);",
    after:
      "const final = namespace === SASL && !mech.final ? null : mech.binary ? decodeBytes(data) : decode(data);",
    suite: "conformance/rfc6120-sasl-base64.test.ts",
    test: "success-without-hook",
  },
  {
    name: "skip SASL2 success encoding validation without final hook",
    file: "src/sasl/exchange.js",
    before: "const final = mech.binary ? decodeBytes(data) : decode(data);",
    after:
      "const final = namespace !== SASL && !mech.final ? null : mech.binary ? decodeBytes(data) : decode(data);",
    suite: "conformance/rfc6120-sasl-base64.test.ts",
    test: "success-without-hook",
  },
  {
    name: "accept noncanonical SASL Base64",
    file: "src/util/base64.js",
    before: "if (encode(bytes) !== data)",
    after: "if (false)",
    suite: "conformance/rfc6120-sasl-base64.test.ts",
    test: "rejects invalid Base64",
  },
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
    file: "src/sasl/exchange.js",
    before: 'response == null ? "" : encode(response)',
    after: 'typeof response === "string" ? encode(response) : ""',
    suite: "conformance/rfc6120-sasl.test.ts",
    test: "binary exchange",
  },
  {
    name: "reject explicit empty SASL success data",
    file: "src/sasl/exchange.js",
    before: 'element.text() === "="',
    after: "false",
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
    file: "src/sasl/exchange.js",
    before: "if (mech.final) {",
    after: "if (mech.final && namespace !== SASL) {",
    suite: "conformance/rfc5802-wire.test.ts",
    test: "missing server proof",
  },
  {
    name: "skip SASL2 verification when proof is absent",
    file: "src/sasl/exchange.js",
    before: "if (mech.final) {",
    after: "if (mech.final && (namespace === SASL || data)) {",
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
      "conformance/rfc6120-iq.test.ts",
      "conformance/rfc6120-streams.test.ts",
      "conformance/rfc6120-binding.test.ts",
      "conformance/rfc6120-sasl.test.ts",
      "conformance/rfc6120-sasl-negotiation.test.ts",
      "conformance/rfc6120-sasl-base64.test.ts",
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
