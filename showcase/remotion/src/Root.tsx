import {Composition, Still} from "remotion";
import {ArchitectureDiagram} from "./ArchitectureDiagram.js";
import {FeatureTour} from "./FeatureTour.js";
import {PiTerminalShowcase} from "./PiTerminalShowcase.js";
import {ProductFilm, productFilmDuration} from "./ProductFilm.js";
import {PromoBanner, PromoSocialCard} from "./PromoBanner.js";
import {
  calculateFeatureTourMetadata,
  fallbackPromoData,
  getFeatureTourDuration,
} from "./promo-data.js";
import {
  calculateTerminalMetadata,
  SHOWCASE_FPS,
  type TerminalShowcaseProps,
} from "./showcase-data.js";
import {layout} from "./theme.js";

const terminalDefaultProps = {
  dataFile: "showcase.json",
  poster: false,
} satisfies TerminalShowcaseProps;

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="PiAgentTerminal"
        component={PiTerminalShowcase}
        durationInFrames={SHOWCASE_FPS}
        fps={SHOWCASE_FPS}
        width={layout.videoWidth}
        height={layout.videoHeight}
        defaultProps={terminalDefaultProps}
        calculateMetadata={calculateTerminalMetadata}
      />
      <Composition
        id="PiAgentSkillCreation"
        component={PiTerminalShowcase}
        durationInFrames={SHOWCASE_FPS}
        fps={SHOWCASE_FPS}
        width={layout.videoWidth}
        height={layout.videoHeight}
        defaultProps={{
          ...terminalDefaultProps,
          fromScene: "skill-creation",
          toScene: "skill-creation",
        }}
        calculateMetadata={calculateTerminalMetadata}
      />
      <Composition
        id="PiAgentSubagentRun"
        component={PiTerminalShowcase}
        durationInFrames={SHOWCASE_FPS}
        fps={SHOWCASE_FPS}
        width={layout.videoWidth}
        height={layout.videoHeight}
        defaultProps={{
          ...terminalDefaultProps,
          fromScene: "subagent-run",
          toScene: "subagent-run",
        }}
        calculateMetadata={calculateTerminalMetadata}
      />
      <Composition
        id="PiAgentDashboardTop"
        component={PiTerminalShowcase}
        durationInFrames={SHOWCASE_FPS}
        fps={SHOWCASE_FPS}
        width={layout.videoWidth}
        height={layout.videoHeight}
        defaultProps={{
          ...terminalDefaultProps,
          fromScene: "dashboard-top",
          toScene: "dashboard-top",
        }}
        calculateMetadata={calculateTerminalMetadata}
      />
      <Composition
        id="PiAgentHandoff"
        component={PiTerminalShowcase}
        durationInFrames={SHOWCASE_FPS}
        fps={SHOWCASE_FPS}
        width={layout.videoWidth}
        height={layout.videoHeight}
        defaultProps={{
          ...terminalDefaultProps,
          fromScene: "handoff",
          toScene: "handoff",
        }}
        calculateMetadata={calculateTerminalMetadata}
      />
      <Still
        id="PiAgentTerminalPoster"
        component={PiTerminalShowcase}
        width={layout.videoWidth}
        height={layout.videoHeight}
        defaultProps={{
          ...terminalDefaultProps,
          fromScene: "dashboard-top",
          toScene: "dashboard-top",
          poster: true,
        }}
      />
      <Still
        id="PromoBanner"
        component={PromoBanner}
        width={layout.bannerWidth}
        height={layout.bannerHeight}
      />
      <Still
        id="PromoSocialCard"
        component={PromoSocialCard}
        width={layout.socialCardWidth}
        height={layout.socialCardHeight}
      />
      <Still
        id="ArchitectureDiagram"
        component={ArchitectureDiagram}
        width={layout.videoWidth}
        height={layout.videoHeight}
      />
      <Composition
        id="ProductFilm"
        component={ProductFilm}
        durationInFrames={productFilmDuration}
        fps={layout.fps}
        width={layout.videoWidth}
        height={layout.videoHeight}
        defaultProps={{dataFile: "promo-data.json"}}
      />
      <Composition
        id="FeatureTour"
        component={FeatureTour}
        durationInFrames={getFeatureTourDuration(fallbackPromoData)}
        fps={layout.fps}
        width={layout.videoWidth}
        height={layout.videoHeight}
        defaultProps={{dataFile: "promo-data.json"}}
        calculateMetadata={calculateFeatureTourMetadata}
      />
    </>
  );
};
