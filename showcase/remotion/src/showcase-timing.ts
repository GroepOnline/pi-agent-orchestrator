export interface TimedShowcaseScene {
  id: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ShowcaseTimingData {
  durationSeconds: number;
  scenes: TimedShowcaseScene[];
}

export interface ShowcaseRangeSelection {
  fromScene?: string;
  toScene?: string;
}

export interface ShowcasePlaybackRange {
  startSeconds: number;
  endSeconds: number;
  startFrame: number;
  durationInFrames: number;
}

export const SHOWCASE_FPS = 60;

export const getShowcasePlaybackRange = (
  data: ShowcaseTimingData,
  props: ShowcaseRangeSelection = {},
): ShowcasePlaybackRange => {
  const fromIndex = props.fromScene
    ? data.scenes.findIndex((scene) => scene.id === props.fromScene)
    : 0;
  const toIndex = props.toScene
    ? data.scenes.findIndex((scene) => scene.id === props.toScene)
    : data.scenes.length - 1;

  if (fromIndex < 0) {
    throw new Error(`Unknown fromScene marker: ${props.fromScene}`);
  }
  if (toIndex < 0) {
    throw new Error(`Unknown toScene marker: ${props.toScene}`);
  }
  if (fromIndex > toIndex) {
    throw new Error(`fromScene ${props.fromScene} occurs after toScene ${props.toScene}`);
  }

  const startSeconds = props.fromScene ? data.scenes[fromIndex].startSeconds : 0;
  const endSeconds = props.toScene ? data.scenes[toIndex].endSeconds : data.durationSeconds;
  const startFrame = Math.floor(startSeconds * SHOWCASE_FPS);
  const endFrame = Math.ceil(endSeconds * SHOWCASE_FPS);

  return {
    startSeconds: startFrame / SHOWCASE_FPS,
    endSeconds: endFrame / SHOWCASE_FPS,
    startFrame,
    durationInFrames: Math.max(1, endFrame - startFrame),
  };
};
