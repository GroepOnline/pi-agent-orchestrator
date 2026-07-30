#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  REQUIRED_SHOWCASE_SCENES,
  SHOWCASE_FPS,
} from "./lib/showcase-cast.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const [captureArgument, mediaDirectoryArgument] = process.argv.slice(2);
const capturePath = path.resolve(
  captureArgument ?? path.join(root, "showcase/remotion/public/showcase.json"),
);
const mediaDirectory = path.resolve(mediaDirectoryArgument ?? path.join(root, "docs/images"));

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

if (!existsSync(capturePath)) {
  throw new Error(`Showcase capture metadata not found: ${capturePath}`);
}

const capture = readJson(capturePath);
const packageJson = readJson(path.join(root, "package.json"));
if (capture.packageVersion !== packageJson.version) {
  throw new Error(
    `Capture package version ${capture.packageVersion} does not match ${packageJson.version}`,
  );
}
if (capture.fps !== SHOWCASE_FPS || !Array.isArray(capture.frames) || capture.frames.length === 0) {
  throw new Error("Capture must contain terminal frames and 60fps metadata");
}
if (!Array.isArray(capture.scenes)) {
  throw new Error("Capture scene metadata is missing");
}

let previousSceneIndex = -1;
for (const required of REQUIRED_SHOWCASE_SCENES) {
  const sceneIndex = capture.scenes.findIndex((scene) => scene.id === required.id);
  if (sceneIndex <= previousSceneIndex) {
    throw new Error(`Required scene is missing or out of order: ${required.id}`);
  }
  const scene = capture.scenes[sceneIndex];
  if (
    !scene.title?.trim() ||
    !scene.cue?.key?.trim() ||
    !scene.cue?.label?.trim() ||
    !Number.isFinite(scene.startSeconds) ||
    !Number.isFinite(scene.endSeconds) ||
    scene.endSeconds <= scene.startSeconds
  ) {
    throw new Error(`Required scene is empty or has an invalid range: ${required.id}`);
  }
  previousSceneIndex = sceneIndex;
}

const frameRange = (fromScene, toScene) => {
  const startSeconds = fromScene
    ? capture.scenes.find((scene) => scene.id === fromScene)?.startSeconds
    : 0;
  const endSeconds = toScene
    ? capture.scenes.find((scene) => scene.id === toScene)?.endSeconds
    : capture.durationSeconds;
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    throw new Error(`Cannot resolve media range ${fromScene ?? "start"}..${toScene ?? "end"}`);
  }
  return Math.max(
    1,
    Math.ceil(endSeconds * SHOWCASE_FPS) - Math.floor(startSeconds * SHOWCASE_FPS),
  );
};

const media = [
  {file: "dashboard_preview.mp4", expectedFrames: frameRange()},
  {
    file: "showcase_skill_creation.mp4",
    expectedFrames: frameRange("skill-creation", "skill-creation"),
  },
  {
    file: "showcase_subagent_run.mp4",
    expectedFrames: frameRange("subagent-run", "subagent-run"),
  },
  {
    file: "showcase_dashboard_top.mp4",
    expectedFrames: frameRange("dashboard-top", "dashboard-top"),
  },
  {
    file: "showcase_handoff.mp4",
    expectedFrames: frameRange("handoff", "handoff"),
  },
];

const probeMedia = (mediaPath) => {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,duration,nb_frames",
    "-of",
    "json",
    mediaPath,
  ];
  let result = spawnSync("ffprobe", args, {encoding: "utf8", timeout: 60_000});
  if (result.error?.code === "ENOENT") {
    result = spawnSync(
      "npm",
      ["--prefix", "showcase/remotion", "exec", "--", "remotion", "ffprobe", ...args],
      {cwd: root, encoding: "utf8", timeout: 60_000},
    );
  }
  if (result.error) {
    throw new Error(`Unable to run ffprobe: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${mediaPath}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
};

for (const item of media) {
  const mediaPath = path.join(mediaDirectory, item.file);
  if (!existsSync(mediaPath)) {
    throw new Error(`Required showcase media not found: ${mediaPath}`);
  }
  const metadata = probeMedia(mediaPath);
  const videoStreams = metadata.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  if (videoStreams.length !== 1) {
    throw new Error(`${item.file} must contain exactly one video stream`);
  }
  const video = videoStreams[0];
  const expected = {
    codec_name: "h264",
    width: 1920,
    height: 1080,
    pix_fmt: "yuv420p",
    r_frame_rate: "60/1",
    avg_frame_rate: "60/1",
    nb_frames: String(item.expectedFrames),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (video[field] !== value) {
      throw new Error(
        `${item.file} has ${field}=${video[field]}; expected ${value}`,
      );
    }
  }
  const duration = Number(video.duration);
  const expectedDuration = item.expectedFrames / SHOWCASE_FPS;
  if (!Number.isFinite(duration) || Math.abs(duration - expectedDuration) > 0.001) {
    throw new Error(
      `${item.file} has duration ${video.duration}; expected ${expectedDuration.toFixed(6)}`,
    );
  }
  console.log(
    `Verified ${item.file}: h264 1920x1080 yuv420p 60fps, ${item.expectedFrames} frames`,
  );
}

console.log(
  `Verified ${capture.scenes.length} ordered scenes for package ${capture.packageVersion}`,
);
