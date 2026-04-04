import { defineConfig } from "rolldown";

export default defineConfig([
  {
    input: "packages/client/index.js",
    output: {
      file: "packages/client/dist/xmpp.js",
      format: "iife",
      sourcemap: true,
      name: "XMPP",
    },
  },
  {
    input: "packages/client/index.js",
    output: {
      file: "packages/client/dist/xmpp.min.js",
      format: "iife",
      sourcemap: true,
      compact: true,
      minify: true,
      name: "XMPP",
    },
  },
]);
