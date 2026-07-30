import {staticFile, type CalculateMetadataFunction} from "remotion";
import {
  getShowcasePlaybackRange,
  SHOWCASE_FPS,
} from "./showcase-timing.js";

export {
  getShowcasePlaybackRange,
  SHOWCASE_FPS,
  type ShowcasePlaybackRange,
} from "./showcase-timing.js";

export interface TerminalFrame {
  t: number;
  screen: string;
}

export interface ShowcaseCue {
  key: string;
  label: string;
}

export interface ShowcaseScene {
  id: string;
  title: string;
  cue: ShowcaseCue;
  startSeconds: number;
  endSeconds: number;
}

export interface ShowcaseData {
  version: number;
  fps: number;
  cols: number;
  rows: number;
  durationSeconds: number;
  generatedAt: string;
  source: string;
  packageVersion: string;
  frames: TerminalFrame[];
  scenes: ShowcaseScene[];
}

export interface TerminalShowcaseProps extends Record<string, unknown> {
  dataFile?: string;
  fromScene?: string;
  toScene?: string;
  poster?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTerminalFrame = (value: unknown): value is TerminalFrame =>
  isRecord(value) && typeof value.t === "number" && typeof value.screen === "string";

const isShowcaseScene = (value: unknown): value is ShowcaseScene =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.title === "string" &&
  typeof value.startSeconds === "number" &&
  typeof value.endSeconds === "number" &&
  isRecord(value.cue) &&
  typeof value.cue.key === "string" &&
  typeof value.cue.label === "string";

const parseShowcaseData = (value: unknown): ShowcaseData => {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    value.fps !== SHOWCASE_FPS ||
    typeof value.cols !== "number" ||
    typeof value.rows !== "number" ||
    typeof value.durationSeconds !== "number" ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    typeof value.generatedAt !== "string" ||
    typeof value.source !== "string" ||
    typeof value.packageVersion !== "string" ||
    !Array.isArray(value.frames) ||
    value.frames.length === 0 ||
    !value.frames.every(isTerminalFrame) ||
    !Array.isArray(value.scenes) ||
    value.scenes.length === 0 ||
    !value.scenes.every(isShowcaseScene)
  ) {
    throw new Error("showcase capture is missing frames, scenes, duration, or 60fps metadata");
  }

  return {
    version: value.version,
    fps: value.fps,
    cols: value.cols,
    rows: value.rows,
    durationSeconds: value.durationSeconds,
    generatedAt: value.generatedAt,
    source: value.source,
    packageVersion: value.packageVersion,
    frames: value.frames,
    scenes: value.scenes,
  };
};

export const loadShowcaseData = async (dataFile = "showcase.json") => {
  const response = await fetch(staticFile(dataFile));
  if (!response.ok) {
    throw new Error(`${dataFile} returned ${response.status}`);
  }
  const value: unknown = await response.json();
  return parseShowcaseData(value);
};

export const calculateTerminalMetadata: CalculateMetadataFunction<
  TerminalShowcaseProps
> = async ({props}) => {
  const data = await loadShowcaseData(props.dataFile);
  return {
    durationInFrames: getShowcasePlaybackRange(data, props).durationInFrames,
    fps: SHOWCASE_FPS,
  };
};
