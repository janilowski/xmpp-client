/* eslint-disable n/no-process-exit */

import zlib from "node:zlib";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import bytes from "bytes";

const brotliCompress = promisify(zlib.brotliCompress);

const path = "dist/xmpp.min.js";
const buffer = await readFile(path);
const compressed = await brotliCompress(buffer);

// Shared saxes engine for document and stream parsing; measured at 19.00 KB Brotli.
const max_size = "20 KB";

console.log(`${path}:`);
if (compressed.length > bytes(max_size)) {
  console.log(
    "\u001B[31m%s\u001B[0m",
    `${bytes(compressed.length)} > ${max_size} ❌`,
  );
  process.exit(1);
} else {
  console.log(
    "\u001B[32m%s\u001B[0m",
    `${bytes(compressed.length)} < ${max_size} ✅`,
  );
  process.exit(0);
}
