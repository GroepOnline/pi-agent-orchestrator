import {usePromoData} from "./promo-data.js";
import {Badge, Eyebrow, GridBackground, Panel, TerminalHeader} from "./PromoShell.js";
import {interFamily, jetBrainsMonoFamily} from "./Fonts.js";
import {theme} from "./theme.js";

interface PromoCardProps {
  compact?: boolean;
}

const CommandLine = ({packageName}: {packageName: string}) => (
  <div
    style={{
      display: "flex",
      gap: 14,
      alignItems: "center",
      fontFamily: jetBrainsMonoFamily,
      fontSize: 18,
      lineHeight: 1.5,
    }}
  >
    <span style={{color: theme.ok}}>➜</span>
    <span style={{color: theme.muted}}>pi</span>
    <span style={{color: theme.text}}>install npm:{packageName}</span>
  </div>
);

const PromoCard = ({compact = false}: PromoCardProps) => {
  const data = usePromoData();
  const capabilities = data.coreCapabilities.slice(0, compact ? 4 : 5);

  return (
    <GridBackground>
      <div
        style={{
          position: "absolute",
          inset: compact ? "62px 66px" : "60px 72px",
          display: "grid",
          gridTemplateColumns: compact ? "1fr" : "1.18fr 0.82fr",
          gap: compact ? 30 : 48,
          alignItems: "stretch",
        }}
      >
        <div style={{display: "flex", flexDirection: "column", minWidth: 0}}>
          <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
            <Eyebrow>GroepOnline / Pi package</Eyebrow>
            <Badge tone="accent">v{data.version}</Badge>
          </div>

          <div
            style={{
              marginTop: compact ? 48 : 66,
              fontFamily: interFamily,
              fontWeight: 700,
              fontSize: compact ? 64 : 68,
              letterSpacing: -3.2,
              lineHeight: 0.96,
              maxWidth: compact ? 900 : 720,
            }}
          >
            Pi Agent
            <br />
            Orchestrator
          </div>

          <div
            style={{
              marginTop: 28,
              maxWidth: compact ? 960 : 720,
              color: theme.muted,
              fontSize: compact ? 22 : 21,
              lineHeight: 1.5,
            }}
          >
            {data.tagline}
          </div>

          <div style={{display: "flex", gap: 10, marginTop: "auto", flexWrap: "wrap"}}>
            <Badge tone="ok">local-first</Badge>
            <Badge>worktrees</Badge>
            <Badge>swarms</Badge>
            <Badge>schedules</Badge>
            <Badge>live TUI</Badge>
          </div>
        </div>

        {!compact ? (
          <Panel style={{overflow: "hidden", minWidth: 0}}>
            <TerminalHeader title="pi — orchestra" right={<span style={{color: theme.muted}}>xterm-256color</span>} />
            <div style={{padding: "26px 28px 22px"}}>
              <CommandLine packageName={data.name} />
              <div
                style={{
                  height: 1,
                  background: theme.line,
                  margin: "24px 0 20px",
                }}
              />
              <div style={{display: "grid", gap: 14}}>
                {capabilities.map((capability, index) => (
                  <div
                    key={capability.title}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "28px 1fr",
                      gap: 12,
                      alignItems: "start",
                    }}
                  >
                    <div
                      style={{
                        color: index === 0 ? theme.accent : theme.ok,
                        fontFamily: jetBrainsMonoFamily,
                        fontSize: 15,
                        paddingTop: 2,
                      }}
                    >
                      {index === 0 ? "●" : "✓"}
                    </div>
                    <div>
                      <div style={{fontSize: 17, fontWeight: 650, marginBottom: 4}}>
                        {capability.title}
                      </div>
                      <div style={{fontSize: 14, lineHeight: 1.45, color: theme.muted}}>
                        {capability.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        ) : (
          <Panel style={{overflow: "hidden"}}>
            <TerminalHeader title="pi — orchestra" />
            <div style={{padding: "22px 26px"}}>
              <CommandLine packageName={data.name} />
              <div style={{display: "flex", gap: 12, marginTop: 22, flexWrap: "wrap"}}>
                {capabilities.map((capability) => (
                  <Badge key={capability.title}>{capability.title}</Badge>
                ))}
              </div>
            </div>
          </Panel>
        )}
      </div>
    </GridBackground>
  );
};

export const PromoBanner = () => <PromoCard />;
export const PromoSocialCard = () => <PromoCard compact />;
