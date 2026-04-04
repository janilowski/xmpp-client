import { defineConfig } from "rolldown";

export default defineConfig([
  {
    input: "src/client/index.js",
    output: {
      file: "dist/xmpp.js",
      format: "iife",
      sourcemap: true,
      name: "XMPP",
    },
  },
  {
    input: "src/client/index.js",
    output: {
      file: "dist/xmpp.min.js",
      format: "iife",
      sourcemap: true,
      compact: true,
      minify: true,
      name: "XMPP",
    },
  },
]);
