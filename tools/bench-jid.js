import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { default: jid } = await import(
  pathToFileURL(resolve(process.argv[2] ?? "src/jid/index.js"))
);
const ITERATIONS = 100_000;
const SAMPLES = 7;
for (const value of [
  "juliet@example.com/laptop",
  "É@bücher.example/Rés",
  "אברהם@example.com/טלפון",
]) {
  for (let i = 0; i < ITERATIONS; i++) {
    jid(value);
  }
  const times = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      jid(value);
    }
    times.push(((performance.now() - start) * 1000) / ITERATIONS);
  }
  times.sort((a, b) => a - b);
  console.log(
    `${value}: ${times[Math.floor(SAMPLES / 2)].toFixed(3)} µs/JID (median of ${SAMPLES} × ${ITERATIONS})`,
  );
}
