import { defineConfig } from "rolldown";

export default defineConfig([
  {
    input: {
      index: "src/index.ts",
      xml: "src/xml/index.js",
      "xml/jsx-runtime": "src/xml/jsx-runtime.js",
      "xml/jsx-dev-runtime": "src/xml/jsx-dev-runtime.js",
    },
    output: {
      dir: "dist",
      cleanDir: true,
      entryFileNames: "[name].js",
      format: "esm",
      sourcemap: true,
    },
  },
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
      minify: true,
      name: "XMPP",
    },
  },
]);
