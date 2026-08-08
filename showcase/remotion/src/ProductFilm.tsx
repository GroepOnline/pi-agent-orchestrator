import type {ReactNode} from "react";
import {Sequence, interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import {Badge, Eyebrow, GridBackground, Panel, TerminalHeader} from "./PromoShell.js";
import {interFamily, jetBrainsMonoFamily} from "./Fonts.js";
import {type FeatureTourProps, usePromoData} from "./promo-data.js";
import {theme} from "./theme.js";

export const productFilmTiming = {
  intro: 180,
  brief: 240,
  parallel: 300,
  control: 300,
  outcome: 330,
} as const;

export const productFilmDuration = Object.values(productFilmTiming).reduce(
  (total, duration) => total + duration,
  0,
);

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const Scene = ({children, duration}: {children: ReactNode; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, config: {damping: 20, stiffness: 110, mass: 0.9}});
  const exit = interpolate(frame, [duration - 18, duration], [1, 0], clamp);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 26}px)`,
      }}
    >
      {children}
    </div>
  );
};

const FilmFrame = ({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) => (
  <GridBackground>
    <div style={{position: "absolute", inset: "68px 104px 58px"}}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <div
        style={{
          marginTop: 16,
          maxWidth: 1320,
          fontFamily: interFamily,
          fontSize: 66,
          fontWeight: 700,
          letterSpacing: -3.2,
          lineHeight: 1,
        }}
      >
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            marginTop: 18,
            maxWidth: 1120,
            color: theme.muted,
            fontSize: 24,
            lineHeight: 1.45,
          }}
        >
          {subtitle}
        </div>
      ) : null}
      <div style={{position: "absolute", inset: "190px 0 0"}}>{children}</div>
    </div>
  </GridBackground>
);

const TerminalLine = ({
  prefix,
  children,
  tone = "neutral",
}: {
  prefix?: string;
  children: ReactNode;
  tone?: "neutral" | "accent" | "ok" | "warn";
}) => {
  const color =
    tone === "accent"
      ? theme.accent
      : tone === "ok"
        ? theme.ok
        : tone === "warn"
          ? theme.warn
          : theme.text;

  return (
    <div style={{display: "flex", gap: 16, color, lineHeight: 1.75}}>
      {prefix ? <span style={{color: theme.muted, minWidth: 24}}>{prefix}</span> : null}
      <span>{children}</span>
    </div>
  );
};

const IntroScene = ({version, tagline}: {version: string; tagline: string}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const titleIn = spring({frame: frame - 12, fps, config: {damping: 18, stiffness: 105}});
  const terminalIn = spring({frame: frame - 34, fps, config: {damping: 18, stiffness: 95}});

  return (
    <Scene duration={productFilmTiming.intro}>
      <GridBackground>
        <div
          style={{
            position: "absolute",
            inset: "92px 112px",
            display: "grid",
            gridTemplateColumns: "1.02fr 0.98fr",
            alignItems: "center",
            gap: 72,
          }}
        >
          <div style={{opacity: titleIn, transform: `translateX(${(1 - titleIn) * -30}px)`}}>
            <Eyebrow>GroepOnline / Pi extension</Eyebrow>
            <div
              style={{
                marginTop: 26,
                fontSize: 92,
                fontWeight: 700,
                lineHeight: 0.94,
                letterSpacing: -5,
              }}
            >
              One command.
              <br />
              A controlled agent fleet.
            </div>
            <div style={{marginTop: 30, maxWidth: 820, color: theme.muted, fontSize: 25, lineHeight: 1.5}}>
              {tagline}
            </div>
            <div style={{display: "flex", gap: 12, marginTop: 34}}>
              <Badge tone="accent">v{version}</Badge>
              <Badge tone="ok">local-first</Badge>
              <Badge>no hosted control plane</Badge>
            </div>
          </div>

          <Panel
            style={{
              overflow: "hidden",
              opacity: terminalIn,
              transform: `translateY(${(1 - terminalIn) * 34}px) scale(${0.97 + terminalIn * 0.03})`,
            }}
          >
            <TerminalHeader title="pi — project" right={<Badge tone="ok">ready</Badge>} />
            <div style={{padding: "34px 36px 38px", fontFamily: jetBrainsMonoFamily, fontSize: 21}}>
              <TerminalLine prefix="➜" tone="accent">
                /orchestra-implement harden the release path
              </TerminalLine>
              <TerminalLine prefix="·">discovering repository constraints</TerminalLine>
              <TerminalLine prefix="·">planning isolated execution lanes</TerminalLine>
              <TerminalLine prefix="✓" tone="ok">
                operator dashboard available at /agents
              </TerminalLine>
            </div>
          </Panel>
        </div>
      </GridBackground>
    </Scene>
  );
};

const BriefScene = ({capabilities}: {capabilities: Array<{title: string; description: string}>}) => {
  const frame = useCurrentFrame();
  const revealed = Math.min(3, Math.max(0, Math.floor((frame - 46) / 42) + 1));

  return (
    <Scene duration={productFilmTiming.brief}>
      <FilmFrame
        eyebrow="01 / Evidence before execution"
        title="The orchestrator turns one goal into bounded lanes."
        subtitle="Read-only discovery runs first. A single isolated writer receives only the evidence and permissions it needs."
      >
        <div style={{height: "100%", display: "grid", gridTemplateColumns: "0.9fr 1.1fr", gap: 34}}>
          <Panel style={{padding: "34px 38px"}}>
            <div style={{fontFamily: jetBrainsMonoFamily, color: theme.muted, fontSize: 16}}>REQUEST</div>
            <div style={{marginTop: 18, fontSize: 32, fontWeight: 700, lineHeight: 1.25}}>
              Ship a release-ready change without losing control of scope, tools, or evidence.
            </div>
            <div style={{height: 1, background: theme.line, margin: "30px 0"}} />
            <div style={{display: "grid", gap: 14}}>
              {["permission inheritance", "optional worktree isolation", "structured handoff"].map((label) => (
                <div key={label} style={{display: "flex", alignItems: "center", gap: 14, fontSize: 20}}>
                  <span style={{color: theme.ok}}>✓</span>
                  {label}
                </div>
              ))}
            </div>
          </Panel>

          <div style={{display: "grid", gap: 16}}>
            {capabilities.slice(0, 3).map((capability, index) => {
              const visible = index < revealed;
              return (
                <Panel
                  key={capability.title}
                  style={{
                    padding: "24px 28px",
                    opacity: visible ? 1 : 0.2,
                    transform: `translateX(${visible ? 0 : 34}px)`,
                  }}
                >
                  <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
                    <div style={{fontSize: 24, fontWeight: 700}}>{capability.title}</div>
                    <Badge tone={visible ? "ok" : "neutral"}>{visible ? "selected" : "pending"}</Badge>
                  </div>
                  <div style={{marginTop: 12, color: theme.muted, fontSize: 18, lineHeight: 1.45}}>
                    {capability.description}
                  </div>
                </Panel>
              );
            })}
          </div>
        </div>
      </FilmFrame>
    </Scene>
  );
};

const AgentLane = ({
  type,
  mode,
  detail,
  index,
}: {
  type: string;
  mode: string;
  detail: string;
  index: number;
}) => {
  const frame = useCurrentFrame();
  const start = index * 26;
  const progress = interpolate(frame, [start + 18, start + 188], [0, 1], clamp);
  const state = progress > 0.92 ? "done" : progress > 0.08 ? "running" : "queued";

  return (
    <Panel style={{padding: "22px 26px"}}>
      <div style={{display: "grid", gridTemplateColumns: "200px 150px 1fr 120px", alignItems: "center", gap: 18}}>
        <div style={{fontSize: 24, fontWeight: 700}}>{type}</div>
        <div style={{fontFamily: jetBrainsMonoFamily, color: theme.muted, fontSize: 15}}>{mode.replace(/`/g, "")}</div>
        <div style={{color: theme.muted, fontSize: 17}}>{detail}</div>
        <Badge tone={state === "done" ? "ok" : state === "running" ? "accent" : "neutral"}>{state}</Badge>
      </div>
      <div style={{height: 3, marginTop: 18, borderRadius: 999, background: theme.line, overflow: "hidden"}}>
        <div
          style={{
            width: `${progress * 100}%`,
            height: "100%",
            background: state === "done" ? theme.ok : theme.accent,
          }}
        />
      </div>
    </Panel>
  );
};

const ParallelScene = ({agents}: {agents: Array<{Type: string; Mode: string; "Use when": string}>}) => (
  <Scene duration={productFilmTiming.parallel}>
    <FilmFrame
      eyebrow="02 / Parallel orchestration"
      title="Multiple agents work concurrently. Authority does not multiply."
      subtitle="Children inherit the parent boundary. Read-only lanes gather evidence; the implementation lane remains explicit and isolated."
    >
      <div style={{height: "100%", display: "grid", gridTemplateColumns: "1fr 330px", gap: 28}}>
        <div style={{display: "grid", gap: 15, alignContent: "center"}}>
          {agents.slice(0, 4).map((agent, index) => (
            <AgentLane
              key={agent.Type}
              type={agent.Type}
              mode={agent.Mode}
              detail={agent["Use when"]}
              index={index}
            />
          ))}
        </div>
        <Panel style={{padding: "28px 28px 30px", alignSelf: "center"}}>
          <div style={{fontFamily: jetBrainsMonoFamily, color: theme.accent, fontSize: 16}}>BOUNDARY</div>
          <div style={{marginTop: 16, fontSize: 28, fontWeight: 700}}>One isolated writer</div>
          <div style={{marginTop: 24, display: "grid", gap: 16, color: theme.muted, fontSize: 18}}>
            <div><span style={{color: theme.ok}}>✓</span> dedicated worktree</div>
            <div><span style={{color: theme.ok}}>✓</span> inherited tool scope</div>
            <div><span style={{color: theme.ok}}>✓</span> bounded depth and budget</div>
            <div><span style={{color: theme.ok}}>✓</span> evidence-backed handoff</div>
          </div>
        </Panel>
      </div>
    </FilmFrame>
  </Scene>
);

const ControlScene = () => {
  const frame = useCurrentFrame();
  const selected = Math.min(3, Math.floor(frame / 58) % 4);

  const rows = [
    ["Explore", "running", "architecture + risk map"],
    ["Plan", "done", "mechanically verifiable sequence"],
    ["Analysis", "done", "test and performance evidence"],
    ["general-purpose", "running", "isolated implementation"],
  ] as const;

  return (
    <Scene duration={productFilmTiming.control}>
      <FilmFrame
        eyebrow="03 / Operator control"
        title="Observe, steer, stop, and inspect from the live TUI."
        subtitle="The agent fleet stays visible while work is in motion — including schedules, resource use, and performance views."
      >
        <Panel style={{height: "100%", overflow: "hidden"}}>
          <TerminalHeader title="pi — /agents" right={<Badge tone="accent">RUNNING 2 · DONE 2</Badge>} />
          <div style={{padding: "24px 28px", fontFamily: jetBrainsMonoFamily}}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "56px 230px 140px 1fr 130px",
                gap: 14,
                padding: "0 18px 14px",
                color: theme.muted,
                fontSize: 14,
              }}
            >
              <div>ID</div><div>TYPE</div><div>STATE</div><div>TASK</div><div>CONTROL</div>
            </div>
            <div style={{display: "grid", gap: 10}}>
              {rows.map(([type, state, task], index) => {
                const active = index === selected;
                return (
                  <div
                    key={type}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "56px 230px 140px 1fr 130px",
                      gap: 14,
                      alignItems: "center",
                      minHeight: 70,
                      padding: "0 18px",
                      borderRadius: 12,
                      border: `1px solid ${active ? `${theme.accent}77` : theme.line}`,
                      background: active ? "rgba(112,169,255,0.10)" : "rgba(18,21,26,0.56)",
                      fontSize: 17,
                    }}
                  >
                    <div style={{color: theme.muted}}>{String(index + 1).padStart(2, "0")}</div>
                    <div style={{color: active ? theme.text : theme.muted}}>{type}</div>
                    <div style={{color: state === "done" ? theme.ok : theme.accent}}>{state}</div>
                    <div>{task}</div>
                    <div style={{color: active ? theme.warn : theme.muted}}>{active ? "selected" : "—"}</div>
                  </div>
                );
              })}
            </div>
            <div style={{display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap"}}>
              {["j/k navigate", "Space select", "t resources", "z schedules", "Shift+K terminate", "/perf metrics"].map(
                (control) => <Badge key={control}>{control}</Badge>,
              )}
            </div>
          </div>
        </Panel>
      </FilmFrame>
    </Scene>
  );
};

const OutcomeScene = ({version, repository}: {version: string; repository: string}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const verified = frame > 94;
  const cta = spring({frame: frame - 170, fps, config: {damping: 18, stiffness: 100}});

  return (
    <Scene duration={productFilmTiming.outcome}>
      <GridBackground>
        <div style={{position: "absolute", inset: "76px 106px", display: "grid", gridTemplateColumns: "1.02fr 0.98fr", gap: 44}}>
          <div style={{display: "flex", flexDirection: "column", justifyContent: "center"}}>
            <Eyebrow>04 / Structured result</Eyebrow>
            <div style={{marginTop: 22, fontSize: 76, fontWeight: 700, letterSpacing: -4, lineHeight: 1}}>
              The work finishes with evidence, not a vague success message.
            </div>
            <div style={{marginTop: 26, color: theme.muted, fontSize: 24, lineHeight: 1.5}}>
              Inspect the result, remaining risks, tests, and next action before anything is merged or published.
            </div>
            <div style={{display: "flex", gap: 12, marginTop: 30}}>
              <Badge tone="ok">verified</Badge>
              <Badge tone="accent">v{version}</Badge>
              <Badge>MIT</Badge>
            </div>
          </div>

          <div style={{display: "flex", flexDirection: "column", justifyContent: "center", gap: 22}}>
            <Panel style={{overflow: "hidden"}}>
              <TerminalHeader title="handoff.json" right={<Badge tone={verified ? "ok" : "neutral"}>{verified ? "complete" : "validating"}</Badge>} />
              <pre
                style={{
                  margin: 0,
                  padding: "28px 32px 30px",
                  fontFamily: jetBrainsMonoFamily,
                  fontSize: 18,
                  lineHeight: 1.7,
                  color: theme.text,
                }}
              >
{`{
  "status": "${verified ? "verified" : "running"}",
  "evidence": ["tests", "diff", "risk-map"],
  "decisions": ["bounded writer", "no auto-merge"],
  "remainingWork": []
}`}
              </pre>
            </Panel>
            <Panel
              style={{
                padding: "24px 30px",
                opacity: cta,
                transform: `translateY(${(1 - cta) * 22}px)`,
              }}
            >
              <div style={{fontFamily: jetBrainsMonoFamily, fontSize: 22}}>
                <span style={{color: theme.ok}}>➜ </span>
                pi install npm:@groeponline/pi-agent-orchestrator
              </div>
              <div style={{marginTop: 12, color: theme.muted, fontFamily: jetBrainsMonoFamily, fontSize: 15}}>
                {repository.replace("https://", "")}
              </div>
            </Panel>
          </div>
        </div>
      </GridBackground>
    </Scene>
  );
};

export const ProductFilm = ({dataFile}: FeatureTourProps) => {
  const frame = useCurrentFrame();
  const data = usePromoData(dataFile);
  let cursor = 0;

  const introFrom = cursor;
  cursor += productFilmTiming.intro;
  const briefFrom = cursor;
  cursor += productFilmTiming.brief;
  const parallelFrom = cursor;
  cursor += productFilmTiming.parallel;
  const controlFrom = cursor;
  cursor += productFilmTiming.control;
  const outcomeFrom = cursor;

  return (
    <div style={{width: "100%", height: "100%", background: theme.bg}}>
      <Sequence from={introFrom} durationInFrames={productFilmTiming.intro} premountFor={30}>
        <IntroScene version={data.version} tagline={data.tagline} />
      </Sequence>
      <Sequence from={briefFrom} durationInFrames={productFilmTiming.brief} premountFor={24}>
        <BriefScene capabilities={data.coreCapabilities} />
      </Sequence>
      <Sequence from={parallelFrom} durationInFrames={productFilmTiming.parallel} premountFor={24}>
        <ParallelScene agents={data.agentTypes} />
      </Sequence>
      <Sequence from={controlFrom} durationInFrames={productFilmTiming.control} premountFor={24}>
        <ControlScene />
      </Sequence>
      <Sequence from={outcomeFrom} durationInFrames={productFilmTiming.outcome} premountFor={24}>
        <OutcomeScene version={data.version} repository={data.repository} />
      </Sequence>

      <div style={{position: "absolute", left: 0, right: 0, bottom: 0, height: 4, background: theme.line}}>
        <div
          style={{
            width: `${Math.min(100, (frame / Math.max(1, productFilmDuration - 1)) * 100)}%`,
            height: "100%",
            background: `linear-gradient(90deg, ${theme.accent}, ${theme.ok})`,
          }}
        />
      </div>
    </div>
  );
};
