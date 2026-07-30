import Convert from "ansi-to-html";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useDelayRender,
  useVideoConfig,
} from "remotion";
import {useEffect, useState} from "react";
import {interFamily, jetBrainsMonoFamily} from "./Fonts.js";
import {
  getShowcasePlaybackRange,
  loadShowcaseData,
  type ShowcaseData,
  type TerminalFrame,
  type TerminalShowcaseProps,
} from "./showcase-data.js";
import {TERMINAL_CHROME, fitTerminalTypography} from "./terminal-layout.js";

const converter = new Convert({
  fg: "#d5d8df",
  bg: "transparent",
  newline: true,
  escapeXML: true,
  stream: false,
});

const useShowcaseData = (dataFile: string) => {
  const [data, setData] = useState<ShowcaseData | null>(null);
  const {delayRender, continueRender, cancelRender} = useDelayRender();
  const [handle] = useState(() => delayRender("Loading terminal capture"));

  useEffect(() => {
    let active = true;
    loadShowcaseData(dataFile)
      .then((value) => {
        if (active) {
          setData(value);
        }
        continueRender(handle);
      })
      .catch((error: unknown) => {
        if (active) {
          cancelRender(error instanceof Error ? error : new Error(String(error)));
        }
      });

    return () => {
      active = false;
    };
  }, [cancelRender, continueRender, dataFile, handle]);

  return data;
};

const selectFrame = (frames: TerminalFrame[], seconds: number) => {
  let selected = frames[0];
  for (const candidate of frames) {
    if (candidate.t > seconds) break;
    selected = candidate;
  }
  return selected;
};

export const PiTerminalShowcase = ({
  dataFile = "showcase.json",
  fromScene,
  toScene,
  poster = false,
}: TerminalShowcaseProps) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const data = useShowcaseData(dataFile);
  if (!data) return null;

  const range = getShowcasePlaybackRange(data, {fromScene, toScene});
  const seconds = poster
    ? range.startSeconds + (range.endSeconds - range.startSeconds) / 2
    : range.startSeconds + frame / fps;
  const terminalFrame = selectFrame(data.frames, seconds);
  const scene = data.scenes.find(
    (candidate) => seconds >= candidate.startSeconds && seconds < candidate.endSeconds,
  );
  const cueFadeSeconds = scene
    ? Math.min(0.18, (scene.endSeconds - scene.startSeconds) / 3)
    : 0;

  const terminalHtml = converter.toHtml(terminalFrame.screen);
  const typography = fitTerminalTypography(data.rows);

  const intro = poster
    ? 1
    : interpolate(frame, [0, 24], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      });
  const exit = poster
    ? 1
    : interpolate(frame, [durationInFrames - 24, durationInFrames - 1], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
  const terminalY = interpolate(intro, [0, 1], [34, 0]);
  const progress = poster ? 0.48 : Math.min(1, frame / Math.max(1, durationInFrames - 1));
  const cueOpacity = scene
    ? poster
      ? 1
      : interpolate(
          seconds,
          [
            scene.startSeconds,
            scene.startSeconds + cueFadeSeconds,
            scene.endSeconds - cueFadeSeconds,
            scene.endSeconds,
          ],
          [0, 1, 1, 0],
          {extrapolateLeft: "clamp", extrapolateRight: "clamp"},
        )
    : 0;

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at 50% 15%, rgba(83,91,107,0.28), transparent 40%), linear-gradient(145deg, #08090b 0%, #111318 52%, #090a0d 100%)",
        color: "#f4f4f5",
        fontFamily: interFamily,
        opacity: intro * exit,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.13,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: TERMINAL_CHROME.left,
          right: TERMINAL_CHROME.right,
          top: 42,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 16,
              letterSpacing: 3.8,
              textTransform: "uppercase",
              color: "#a8adb7",
              fontWeight: 650,
              marginBottom: 8,
            }}
          >
            OnlineChefGroep / Pi CLI
          </div>
          <div style={{fontSize: 42, fontWeight: 720, letterSpacing: -1.8, lineHeight: 1}}>
            Pi Agent Orchestrator
          </div>
        </div>
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.16)",
            background: "rgba(13,15,19,0.76)",
            borderRadius: 999,
            padding: "10px 16px",
            fontSize: 15,
            letterSpacing: 1.1,
            color: "#c8cbd2",
            fontFamily: jetBrainsMonoFamily,
          }}
        >
          LIVE PI SESSION · {data.cols}×{data.rows}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: TERMINAL_CHROME.left,
          right: TERMINAL_CHROME.right,
          top: TERMINAL_CHROME.top,
          height: TERMINAL_CHROME.height,
          transform: `translateY(${terminalY}px)`,
          border: "1px solid rgba(255,255,255,0.16)",
          borderRadius: 18,
          background: "rgba(8,10,13,0.97)",
          boxShadow:
            "0 42px 110px rgba(0,0,0,0.62), 0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: TERMINAL_CHROME.titleBar,
            borderBottom: "1px solid rgba(255,255,255,0.09)",
            display: "flex",
            alignItems: "center",
            padding: "0 20px",
            background: "linear-gradient(180deg, #17191f 0%, #101216 100%)",
          }}
        >
          <div style={{display: "flex", gap: 10}}>
            {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
              <div
                key={color}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: color,
                  boxShadow: `0 0 0 1px ${color}55`,
                }}
              />
            ))}
          </div>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              textAlign: "center",
              fontSize: 16,
              fontWeight: 600,
              color: "#aeb2bc",
              letterSpacing: 0.2,
            }}
          >
            pi — coding agent
          </div>
          <div
            style={{
              marginLeft: "auto",
              fontFamily: jetBrainsMonoFamily,
              fontSize: 13,
              color: "#747985",
            }}
          >
            {data.cols}×{data.rows}
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            inset: `${TERMINAL_CHROME.titleBar}px 0 ${TERMINAL_CHROME.progressBar}px 0`,
            padding: `${TERMINAL_CHROME.paddingY}px ${TERMINAL_CHROME.paddingX}px`,
            background:
              "radial-gradient(circle at 25% 0%, rgba(59,80,99,0.10), transparent 36%), #080a0d",
            overflow: "hidden",
          }}
        >
          <pre
            style={{
              margin: 0,
              color: "#d5d8df",
              fontFamily: jetBrainsMonoFamily,
              fontSize: typography.fontSize,
              lineHeight: typography.lineHeight,
              letterSpacing: 0,
              whiteSpace: "pre",
              fontVariantLigatures: "none",
              textRendering: "geometricPrecision",
            }}
            dangerouslySetInnerHTML={{__html: terminalHtml}}
          />
        </div>

        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: TERMINAL_CHROME.progressBar,
            background: "rgba(255,255,255,0.06)",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${progress * 100}%`,
              background: "linear-gradient(90deg, #8ca7b7, #d7e2e8)",
            }}
          />
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: TERMINAL_CHROME.left,
          bottom: 22,
          color: "#8e939e",
          fontSize: 15,
          letterSpacing: 0.3,
        }}
      >
        Captured from <span style={{color: "#c9ccd3"}}>{data.source}</span> · Pi CLI · v
        {data.packageVersion}
      </div>

      <div
        style={{
          position: "absolute",
          right: TERMINAL_CHROME.right,
          bottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
          opacity: cueOpacity,
          transform: `translateY(${(1 - cueOpacity) * 12}px)`,
        }}
      >
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.18)",
            background: "rgba(26,29,35,0.9)",
            boxShadow: "inset 0 -2px 0 rgba(0,0,0,0.5)",
            fontFamily: jetBrainsMonoFamily,
            fontWeight: 700,
            fontSize: 16,
            color: "#f5f5f5",
          }}
        >
          {scene?.cue.key ?? ""}
        </div>
        <div style={{fontSize: 17, color: "#b8bcc5"}}>{scene?.cue.label ?? ""}</div>
      </div>
    </AbsoluteFill>
  );
};
