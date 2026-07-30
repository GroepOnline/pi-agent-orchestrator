#!/usr/bin/env node
/**
 * Build a labeled asciicast for CI Remotion renders from programmatic UI casts.
 * Real session captures stay manual; CI only needs valid scene markers + terminal frames.
 */
import {spawnSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {labelShowcaseMarkers, REQUIRED_SHOWCASE_SCENES} from "./lib/showcase-cast.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "showcase/fixtures/ci-showcase.cast");
const tmpDir = (process.env.TMPDIR ?? os.tmpdir()).replace(/\/$/, "");
const generatedCast = path.join(tmpDir, "showcase.cast");

const run = (command, args) => {
  const result = spawnSync(command, args, {cwd: root, encoding: "utf8", stdio: "inherit"});
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run("npm", ["run", "build"]);
run("node", ["scripts/generate-showcase-media.mjs"]);

const castText = await readFile(generatedCast, "utf8");
const lines = castText.split(/\r?\n/).filter((line) => line.trim());
if (lines.length < 2) {
  throw new Error(`Generated cast is empty: ${generatedCast}`);
}

const header = lines[0];
const events = lines.slice(1).map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid cast event on line ${index + 2}: ${error.message}`);
  }
});

const outputTimes = events.filter((event) => event[1] === "o").map((event) => event[0]);
if (outputTimes.length < REQUIRED_SHOWCASE_SCENES.length) {
  throw new Error(
    `Expected at least ${REQUIRED_SHOWCASE_SCENES.length} output frames, found ${outputTimes.length}`,
  );
}

const markerTimes = REQUIRED_SHOWCASE_SCENES.map((_, index) => {
  const slot = Math.floor(((index + 1) * outputTimes.length) / (REQUIRED_SHOWCASE_SCENES.length + 1));
  return Math.max(0, outputTimes[slot] - 0.05);
});

const labeledEvents = [];
let markerIndex = 0;
for (const event of events) {
  while (markerIndex < markerTimes.length && event[0] >= markerTimes[markerIndex]) {
    labeledEvents.push([markerTimes[markerIndex], "m", ""]);
    markerIndex++;
  }
  labeledEvents.push(event);
}
while (markerIndex < markerTimes.length) {
  labeledEvents.push([markerTimes[markerIndex], "m", ""]);
  markerIndex++;
}

const prepared = `${header}\n${labeledEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
const labeled = labelShowcaseMarkers(prepared);

await mkdir(path.dirname(outputPath), {recursive: true});
await writeFile(outputPath, labeled, "utf8");
console.log(`Prepared CI showcase cast at ${path.relative(root, outputPath)}`);
