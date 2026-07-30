#!/usr/bin/env node
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseAsciicast} from "../../../scripts/lib/showcase-cast.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const [castArgument, outputArgument] = process.argv.slice(2);
if (!castArgument) {
  throw new Error(
    "Usage: node showcase/remotion/scripts/capture-terminal.mjs <recording.cast> [showcase.json]",
  );
}

const castPath = path.resolve(castArgument);
const output = outputArgument
  ? path.resolve(outputArgument)
  : path.join(root, "showcase/remotion/public/showcase.json");

let packageVersion = "unknown";
try {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  packageVersion = packageJson.version ?? "unknown";
} catch {
  // Metadata only; the capture remains valid without a package version.
}

const cast = await readFile(castPath, "utf8");
const payload = await parseAsciicast(cast, {
  source: `real asciinema session · ${path.basename(castPath)}`,
  packageVersion,
});

await mkdir(path.dirname(output), {recursive: true});
await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(
  `Parsed ${payload.frames.length} frames and ${payload.scenes.length} scenes from ${path.relative(root, castPath)} to ${path.relative(root, output)}`,
);
