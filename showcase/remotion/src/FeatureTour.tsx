import {Sequence, interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import type {ReactNode} from "react";
import {
  featureTourTiming,
  getFeatureTourDuration,
  type AgentType,
  type Capability,
  type CompressionLevel,
  type FeatureTourProps,
  usePromoData,
} from "./promo-data.js";
import {Badge, Eyebrow, GridBackground, Panel, TerminalHeader} from "./PromoShell.js";
import {interFamily, jetBrainsMonoFamily} from "./Fonts.js";
import {theme} from "./theme.js";

const Scene = ({children, duration}: {children: ReactNode; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, config: {damping: 18, stiffness: 120, mass: 0.8}});
  const exit = interpolate(frame, [duration - 16, duration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 28}px)`,
      }}
    >
      {children}
    </div>
  );
};

const PageFrame = ({
  eyebrow,
  title,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) => (
  <GridBackground>
    <div style={{position: "absolute", inset: "72px 110px 64px"}}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <div
        style={{
          marginTop: 18,
          fontFamily: interFamily,
          fontSize: 62,
          fontWeight: 700,
          letterSpacing: -2.8,
          lineHeight: 1,
        }}
      >
        {title}
      </div>
      <div style={{position: "absolute", inset: "120px 0 50px"}}>{children}</div>
      {footer ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            color: theme.muted,
            fontFamily: jetBrainsMonoFamily,
            fontSize: 16,
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  </GridBackground>
);

const IntroScene = ({version, capabilityCount}: {version: string; capabilityCount: number}) => (
  <Scene duration={featureTourTiming.intro}>
    <GridBackground>
      <div
        style={{
          position: "absolute",
          inset: "110px 130px",
          display: "grid",
          gridTemplateColumns: "1.15fr 0.85fr",
          alignItems: "center",
          gap: 80,
        }}
      >
        <div>
          <Eyebrow>GroepOnline / Pi extension</Eyebrow>
          <div
            style={{
              marginTop: 28,
              fontSize: 94,
              lineHeight: 0.92,
              letterSpacing: -5,
              fontWeight: 700,
            }}
          >
            Pi Agent
            <br />
            Orchestrator
          </div>
          <div
            style={{
              marginTop: 36,
              maxWidth: 860,
              fontSize: 28,
              lineHeight: 1.45,
              color: theme.muted,
            }}
          >
            Autonomous subagents, isolated worktrees, swarms, schedules, handoffs,
            prompt profiles, and live operator control inside Pi.
          </div>
          <div style={{display: "flex", gap: 12, marginTop: 38}}>
            <Badge tone="accent">v{version}</Badge>
            <Badge tone="ok">{capabilityCount} core capabilities</Badge>
            <Badge>local-first</Badge>
          </div>
        </div>

        <Panel style={{overflow: "hidden"}}>
          <TerminalHeader title="pi — /agents" />
          <div
            style={{
              padding: "32px 34px 36px",
              fontFamily: jetBrainsMonoFamily,
              fontSize: 22,
              lineHeight: 1.9,
            }}
          >
            <div style={{color: theme.accent}}>╭─ PI AGENT ORCHESTRATOR ─────────╮</div>
            <div>│ RUNNING 3 · QUEUED 1 · DONE 8 │</div>
            <div style={{color: theme.line}}>├───────────────────────────────────┤</div>
            <div><span style={{color: theme.ok}}>●</span> Explore <span style={{color: theme.muted}}>architecture map</span></div>
            <div><span style={{color: theme.ok}}>●</span> Plan <span style={{color: theme.muted}}>implementation sequence</span></div>
            <div><span style={{color: theme.warn}}>○</span> general-purpose <span style={{color: theme.muted}}>isolated writer</span></div>
            <div style={{color: theme.accent}}>╰───────────────────────────────────╯</div>
          </div>
        </Panel>
      </div>
    </GridBackground>
  </Scene>
);

const CapabilityScene = ({capability, index, total}: {capability: Capability; index: number; total: number}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, featureTourTiming.capability - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Scene duration={featureTourTiming.capability}>
      <PageFrame
        eyebrow={`Capability ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`}
        title={capability.title}
        footer="Repo-derived from README.md / Core capabilities"
      >
        <div
          style={{
            height: "100%",
            display: "grid",
            gridTemplateColumns: "1.15fr 0.85fr",
            gap: 56,
            alignItems: "center",
          }}
        >
          <Panel style={{padding: "64px 70px"}}>
            <div style={{fontSize: 36, lineHeight: 1.5, color: theme.text}}>
              {capability.description}
            </div>
            <div
              style={{
                marginTop: 48,
                height: 4,
                borderRadius: 999,
                background: theme.line,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${progress * 100}%`,
                  height: "100%",
                  background: `linear-gradient(90deg, ${theme.accent}, ${theme.ok})`,
                }}
              />
            </div>
          </Panel>

          <div style={{display: "grid", gap: 16}}>
            {Array.from({length: total}, (_, itemIndex) => (
              <div
                key={itemIndex}
                style={{
                  height: 58,
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  padding: "0 20px",
                  borderRadius: 12,
                  border: `1px solid ${itemIndex === index ? `${theme.accent}66` : theme.line}`,
                  background: itemIndex === index ? "rgba(112,169,255,0.10)" : "rgba(18,21,26,0.66)",
                  color: itemIndex === index ? theme.text : theme.muted,
                  fontFamily: jetBrainsMonoFamily,
                  fontSize: 18,
                }}
              >
                <span style={{color: itemIndex < index ? theme.ok : itemIndex === index ? theme.accent : theme.muted}}>
                  {itemIndex < index ? "✓" : itemIndex === index ? "●" : "○"}
                </span>
                capability_{String(itemIndex + 1).padStart(2, "0")}
              </div>
            ))}
          </div>
        </div>
      </PageFrame>
    </Scene>
  );
};

const AgentCard = ({agent, index}: {agent: AgentType; index: number}) => (
  <Panel style={{padding: "26px 28px", minHeight: 180}}>
    <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
      <div style={{fontSize: 25, fontWeight: 700}}>{agent.Type}</div>
      <Badge tone={index === 3 ? "accent" : "ok"}>{agent.Mode.replace(/`/g, "")}</Badge>
    </div>
    <div style={{marginTop: 26, color: theme.muted, fontSize: 19, lineHeight: 1.45}}>
      {agent["Use when"]}
    </div>
  </Panel>
);

const AgentTypesScene = ({agents}: {agents: AgentType[]}) => (
  <Scene duration={featureTourTiming.agents}>
    <PageFrame
      eyebrow="Execution model"
      title="Four built-in agent types"
      footer="Read-only discovery first; bounded writing only where needed."
    >
      <div
        style={{
          height: "100%",
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 24,
          alignContent: "center",
        }}
      >
        {agents.map((agent, index) => (
          <AgentCard key={agent.Type} agent={agent} index={index} />
        ))}
      </div>
    </PageFrame>
  </Scene>
);

const CompressionCard = ({level, index}: {level: CompressionLevel; index: number}) => {
  const accent = index === 0 ? theme.muted : index === 1 ? theme.accent : theme.warn;
  return (
    <Panel style={{padding: "30px 30px 32px", minHeight: 430}}>
      <div style={{fontFamily: jetBrainsMonoFamily, color: accent, fontSize: 22, fontWeight: 700}}>
        {level.Level.replace(/`/g, "")}
      </div>
      <div style={{marginTop: 12, fontSize: 28, fontWeight: 700}}>{level.Meaning}</div>
      <div style={{height: 1, background: theme.line, margin: "28px 0"}} />
      <div style={{color: theme.text, fontSize: 19, lineHeight: 1.55}}>
        {level["Current behavior"]}
      </div>
      <div style={{marginTop: 26, color: theme.muted, fontSize: 17, lineHeight: 1.55}}>
        {level["Recommended use"]}
      </div>
    </Panel>
  );
};

const CompressionScene = ({levels}: {levels: CompressionLevel[]}) => (
  <Scene duration={featureTourTiming.compression}>
    <PageFrame
      eyebrow="Prompt profiles"
      title="Explicit trade-offs, not fake token claims"
      footer="Prompt compression changes selected system-prompt fragments; it does not compact conversation history."
    >
      <div
        style={{
          height: "100%",
          display: "grid",
          gridTemplateColumns: `repeat(${Math.max(levels.length, 1)}, minmax(0, 1fr))`,
          gap: 22,
          alignItems: "center",
        }}
      >
        {levels.map((level, index) => (
          <CompressionCard key={level.Level} level={level} index={index} />
        ))}
      </div>
    </PageFrame>
  </Scene>
);

const OutroScene = ({repository}: {repository: string}) => (
  <Scene duration={featureTourTiming.outro}>
    <GridBackground>
      <div
        style={{
          position: "absolute",
          inset: "120px 150px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <Eyebrow>Install in one command</Eyebrow>
        <div style={{marginTop: 28, fontSize: 78, fontWeight: 700, letterSpacing: -4}}>
          Orchestrate Pi without a hosted control plane.
        </div>
        <Panel style={{marginTop: 52, padding: "28px 36px"}}>
          <div style={{fontFamily: jetBrainsMonoFamily, fontSize: 25}}>
            <span style={{color: theme.ok}}>➜ </span>
            pi install npm:@groeponline/pi-agent-orchestrator
          </div>
        </Panel>
        <div style={{marginTop: 34, color: theme.muted, fontFamily: jetBrainsMonoFamily, fontSize: 18}}>
          {repository.replace("https://", "")}
        </div>
      </div>
    </GridBackground>
  </Scene>
);

export const FeatureTour = ({dataFile}: FeatureTourProps) => {
  const frame = useCurrentFrame();
  const data = usePromoData(dataFile);
  let cursor = 0;
  const totalDuration = getFeatureTourDuration(data);

  const introFrom = cursor;
  cursor += featureTourTiming.intro;
  const capabilityFrom = cursor;
  cursor += data.coreCapabilities.length * featureTourTiming.capability;
  const agentsFrom = cursor;
  cursor += featureTourTiming.agents;
  const compressionFrom = cursor;
  cursor += featureTourTiming.compression;
  const outroFrom = cursor;

  return (
    <div style={{width: "100%", height: "100%", background: theme.bg}}>
      <Sequence from={introFrom} durationInFrames={featureTourTiming.intro} premountFor={30}>
        <IntroScene version={data.version} capabilityCount={data.coreCapabilities.length} />
      </Sequence>

      {data.coreCapabilities.map((capability, index) => (
        <Sequence
          key={capability.title}
          from={capabilityFrom + index * featureTourTiming.capability}
          durationInFrames={featureTourTiming.capability}
          premountFor={20}
        >
          <CapabilityScene capability={capability} index={index} total={data.coreCapabilities.length} />
        </Sequence>
      ))}

      <Sequence from={agentsFrom} durationInFrames={featureTourTiming.agents} premountFor={24}>
        <AgentTypesScene agents={data.agentTypes} />
      </Sequence>

      <Sequence from={compressionFrom} durationInFrames={featureTourTiming.compression} premountFor={24}>
        <CompressionScene levels={data.compressionLevels} />
      </Sequence>

      <Sequence from={outroFrom} durationInFrames={featureTourTiming.outro} premountFor={24}>
        <OutroScene repository={data.repository} />
      </Sequence>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 4,
          background: theme.line,
        }}
      >
        <div
          style={{
            width: `${Math.min(100, (frame / Math.max(1, totalDuration - 1)) * 100)}%`,
            height: "100%",
            background: `linear-gradient(90deg, ${theme.accent}, ${theme.ok})`,
          }}
        />
      </div>
    </div>
  );
};
