#!/usr/bin/env node
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {
  labelShowcaseMarkers,
  REQUIRED_SHOWCASE_SCENES,
} from "./lib/showcase-cast.mjs";

const [castArgument] = process.argv.slice(2);
if (!castArgument) {
  throw new Error("Usage: node scripts/label-showcase-scenes.mjs <recording.cast>");
}

const castPath = path.resolve(castArgument);
const cast = await readFile(castPath, "utf8");
const labeled = labelShowcaseMarkers(cast);
await writeFile(castPath, labeled, "utf8");

console.log(
  `Labeled ${REQUIRED_SHOWCASE_SCENES.length} scene markers in ${path.relative(process.cwd(), castPath)}`,
);
