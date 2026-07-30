import serializeAddon from "@xterm/addon-serialize";
import headlessTerminal from "@xterm/headless";

const {SerializeAddon} = serializeAddon;
const {Terminal} = headlessTerminal;

export const SHOWCASE_FPS = 60;
export const REQUIRED_SHOWCASE_SCENES = [
  {
    id: "skill-creation",
    title: "Skill creation",
    cue: {key: "/skill", label: "create a reusable skill"},
    maxDurationSeconds: 10,
  },
  {
    id: "subagent-run",
    title: "Subagent run",
    cue: {key: "subagent", label: "run a real subagent"},
    maxDurationSeconds: 12,
  },
  {
    id: "dashboard-top",
    title: "Dashboard and top",
    cue: {key: "t", label: "inspect live resource usage"},
    maxDurationSeconds: 10,
  },
  {
    id: "handoff",
    title: "Structured handoff",
    cue: {key: "handoff", label: "return verified work"},
    maxDurationSeconds: 8,
  },
];

export const SHOWCASE_MARKER_PREFIX = "pi-showcase:";

const SCENE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonLine = (line, lineNumber) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid asciicast JSON on line ${lineNumber}: ${error.message}`);
  }
};

const parseHeader = (value) => {
  if (!isRecord(value) || value.version !== 2) {
    throw new Error("Showcase capture requires an asciicast v2 header");
  }

  const cols = value.width ?? value.cols;
  const rows = value.height ?? value.rows;
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
    throw new Error("Asciicast header must include positive width and height");
  }

  const idleTimeLimit =
    typeof value.idle_time_limit === "number" &&
    Number.isFinite(value.idle_time_limit) &&
    value.idle_time_limit > 0
      ? value.idle_time_limit
      : null;

  return {cols, rows, idleTimeLimit};
};

const parseEvent = (value, lineNumber, previousTime) => {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[0] !== "number" ||
    !Number.isFinite(value[0]) ||
    value[0] < 0 ||
    typeof value[1] !== "string"
  ) {
    throw new Error(`Invalid asciicast event on line ${lineNumber}`);
  }
  if (value[0] < previousTime) {
    throw new Error(`Asciicast events are not ordered at line ${lineNumber}`);
  }

  return {time: value[0], code: value[1], data: value[2]};
};

const parseCue = (value) => {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.label !== "string") {
    throw new Error("Showcase scene cue must contain key and label strings");
  }
  if (!value.key.trim() || !value.label.trim()) {
    throw new Error("Showcase scene cue key and label cannot be empty");
  }
  return {key: value.key, label: value.label};
};

export const encodeShowcaseMarker = (scene) => {
  const marker = {
    id: scene.id,
    title: scene.title,
    cue: scene.cue,
  };
  parseShowcaseMarker(`${SHOWCASE_MARKER_PREFIX}${JSON.stringify(marker)}`);
  return `${SHOWCASE_MARKER_PREFIX}${JSON.stringify(marker)}`;
};

export const parseShowcaseMarker = (label) => {
  if (typeof label !== "string" || !label.startsWith(SHOWCASE_MARKER_PREFIX)) {
    return null;
  }

  let value;
  try {
    value = JSON.parse(label.slice(SHOWCASE_MARKER_PREFIX.length));
  } catch (error) {
    throw new Error(`Invalid showcase scene marker JSON: ${error.message}`);
  }

  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !SCENE_ID_PATTERN.test(value.id) ||
    typeof value.title !== "string" ||
    !value.title.trim()
  ) {
    throw new Error("Showcase scene marker must contain a valid id and nonempty title");
  }

  return {id: value.id, title: value.title, cue: parseCue(value.cue)};
};

const writeTerminal = (terminal, data) =>
  new Promise((resolve) => {
    terminal.write(data, resolve);
  });

const parseResize = (data) => {
  if (typeof data !== "string") return null;
  const match = /^(\d+)x(\d+)$/.exec(data);
  if (!match) return null;
  return {cols: Number(match[1]), rows: Number(match[2])};
};

const roundTime = (value) => Number(value.toFixed(6));

const normalizeShowcaseTimeline = (frames, scenes, durationSeconds) => {
  if (scenes.length === 0) {
    return {frames, scenes, durationSeconds};
  }

  const limits = new Map(
    REQUIRED_SHOWCASE_SCENES.map((scene) => [scene.id, scene.maxDurationSeconds]),
  );
  const segments = [];
  const preludeEnd = scenes[0].startSeconds;
  const preludeDuration = Math.min(preludeEnd, 3);
  segments.push({
    rawStart: 0,
    rawEnd: preludeEnd,
    playbackStart: 0,
    playbackEnd: preludeDuration,
  });

  let playbackCursor = preludeDuration;
  for (const scene of scenes) {
    const rawDuration = scene.endSeconds - scene.startSeconds;
    const playbackDuration = Math.min(rawDuration, limits.get(scene.id) ?? rawDuration);
    segments.push({
      rawStart: scene.startSeconds,
      rawEnd: scene.endSeconds,
      playbackStart: playbackCursor,
      playbackEnd: playbackCursor + playbackDuration,
    });
    playbackCursor += playbackDuration;
  }

  const mapTime = (time) => {
    const segment =
      segments.find((candidate) => time <= candidate.rawEnd) ?? segments.at(-1);
    const rawDuration = segment.rawEnd - segment.rawStart;
    if (rawDuration <= 0) return roundTime(segment.playbackStart);
    const progress = Math.max(0, Math.min(1, (time - segment.rawStart) / rawDuration));
    return roundTime(
      segment.playbackStart +
        progress * (segment.playbackEnd - segment.playbackStart),
    );
  };

  return {
    frames: frames.map((frame) => ({...frame, t: mapTime(frame.t)})),
    scenes: scenes.map((scene) => ({
      ...scene,
      startSeconds: mapTime(scene.startSeconds),
      endSeconds: mapTime(scene.endSeconds),
    })),
    durationSeconds: roundTime(playbackCursor),
  };
};

export const parseAsciicast = async (text, options = {}) => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    throw new Error("Asciicast must contain a header and at least one event");
  }

  const initialSize = parseHeader(parseJsonLine(lines[0], 1));
  const terminal = new Terminal({
    cols: initialSize.cols,
    rows: initialSize.rows,
    allowProposedApi: true,
    scrollback: 0,
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);

  const frames = [];
  const sceneStarts = [];
  const sceneIds = new Set();
  let previousRawTime = 0;
  let playbackTime = 0;
  let durationSeconds = 0;
  let cols = initialSize.cols;
  let rows = initialSize.rows;

  for (let index = 1; index < lines.length; index++) {
    const event = parseEvent(
      parseJsonLine(lines[index], index + 1),
      index + 1,
      previousRawTime,
    );
    const rawDelta = event.time - previousRawTime;
    playbackTime = roundTime(
      (
        playbackTime +
        (initialSize.idleTimeLimit
          ? Math.min(rawDelta, initialSize.idleTimeLimit)
          : rawDelta)
      ),
    );
    previousRawTime = event.time;
    durationSeconds = playbackTime;

    if (event.code === "o") {
      if (typeof event.data !== "string") {
        throw new Error(`Asciicast output event on line ${index + 1} must contain a string`);
      }
      await writeTerminal(terminal, event.data);
      const screen = serializer.serialize({scrollback: 0, excludeModes: true});
      if (screen && frames.at(-1)?.screen !== screen) {
        frames.push({t: playbackTime, screen});
      }
      continue;
    }

    if (event.code === "m") {
      const marker = parseShowcaseMarker(event.data);
      if (marker) {
        if (sceneIds.has(marker.id)) {
          throw new Error(`Duplicate showcase scene marker: ${marker.id}`);
        }
        sceneIds.add(marker.id);
        sceneStarts.push({...marker, startSeconds: playbackTime});
      }
      continue;
    }

    if (event.code === "r") {
      const size = parseResize(event.data);
      if (size) {
        terminal.resize(size.cols, size.rows);
        cols = size.cols;
        rows = size.rows;
      }
    }
  }

  terminal.dispose();

  if (frames.length === 0) {
    throw new Error("Asciicast contains no terminal output frames");
  }
  if (durationSeconds <= 0) {
    throw new Error("Asciicast duration must be greater than zero");
  }

  const scenes = sceneStarts.map((scene, index) => ({
    ...scene,
    endSeconds: sceneStarts[index + 1]?.startSeconds ?? durationSeconds,
  }));
  const timeline = normalizeShowcaseTimeline(frames, scenes, durationSeconds);

  return {
    version: 2,
    fps: SHOWCASE_FPS,
    cols,
    rows,
    durationSeconds: timeline.durationSeconds,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: options.source ?? "asciicast",
    packageVersion: options.packageVersion ?? "unknown",
    frames: timeline.frames,
    scenes: timeline.scenes,
  };
};

export const labelShowcaseMarkers = (text, sceneDefinitions = REQUIRED_SHOWCASE_SCENES) => {
  const lines = text.split(/\r?\n/);
  let sceneIndex = 0;

  const labeled = lines.map((line, index) => {
    if (!line.trim() || index === 0) return line;
    const value = parseJsonLine(line, index + 1);
    if (!Array.isArray(value) || value[1] !== "m") return line;
    const existing = parseShowcaseMarker(value[2]);
    if (existing) {
      const expected = sceneDefinitions[sceneIndex];
      if (!expected || existing.id !== expected.id) {
        throw new Error(`Unexpected labeled showcase scene marker: ${existing.id}`);
      }
      sceneIndex++;
      return line;
    }
    if (sceneIndex >= sceneDefinitions.length) return line;

    const scene = sceneDefinitions[sceneIndex];
    sceneIndex++;
    return JSON.stringify([value[0], "m", encodeShowcaseMarker(scene)]);
  });

  if (sceneIndex !== sceneDefinitions.length) {
    throw new Error(
      `Expected ${sceneDefinitions.length} unlabeled asciicast markers, found ${sceneIndex}`,
    );
  }

  return `${labeled.join("\n").replace(/\n+$/, "")}\n`;
};
