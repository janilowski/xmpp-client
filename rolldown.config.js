import { defineConfig } from "rolldown";

export default defineConfig([
  {
    input: "src/client/index.js",
    output: {
      file: "dist/xmpp-client",
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
      minify: true,
      name: "XMPP",
    },
  },
]);
