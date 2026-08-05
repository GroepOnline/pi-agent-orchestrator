import {useEffect, useRef, useState} from "react";
import {
  staticFile,
  useDelayRender,
  type CalculateMetadataFunction,
} from "remotion";

export interface Capability {
  title: string;
  description: string;
}

export interface AgentType {
  Type: string;
  Mode: string;
  "Use when": string;
}

export interface CompressionLevel {
  Level: string;
  Meaning: string;
  "Current behavior": string;
  "Recommended use": string;
}

export interface PromoData {
  version: string;
  name: string;
  displayName: string;
  tagline: string;
  repository: string;
  generatedAt: string;
  coreCapabilities: Capability[];
  agentTypes: AgentType[];
  compressionLevels: CompressionLevel[];
  architectureAscii: string;
}

export interface FeatureTourProps extends Record<string, unknown> {
  dataFile?: string;
}

export const featureTourTiming = {
  intro: 90,
  capability: 84,
  agents: 150,
  compression: 150,
  outro: 105,
} as const;

export const fallbackPromoData: PromoData = {
  version: "0.17.5",
  name: "@groeponline/pi-agent-orchestrator",
  displayName: "PI AGENT ORCHESTRATOR",
  tagline:
    "Multi-agent orchestration for Pi: autonomous subagents, worktrees, swarms, schedules, handoffs, prompt compression, and live TUI observability.",
  repository: "https://github.com/GroepOnline/pi-agent-orchestrator",
  generatedAt: "fallback",
  coreCapabilities: [
    {
      title: "Interactive TUI dashboard",
      description:
        "Agent list, resource top, daemon schedules, performance metrics, help, and settings.",
    },
    {
      title: "Subagent lifecycle",
      description:
        "Spawn, queue, steer, stop, inspect, and collect structured results.",
    },
    {
      title: "Permission inheritance",
      description:
        "Children cannot silently regain tools or scopes removed by a parent.",
    },
  ],
  agentTypes: [
    {
      Type: "Explore",
      Mode: "read-only",
      "Use when": "Parallel codebase discovery and evidence collection",
    },
    {
      Type: "Plan",
      Mode: "read-only",
      "Use when": "Architecture and implementation planning before edits",
    },
  ],
  compressionLevels: [
    {
      Level: "`balanced`",
      Meaning: "Default",
      "Current behavior":
        "Concise guidance while retaining examples and field descriptions",
      "Recommended use": "General use",
    },
  ],
  architectureAscii:
    "pi-coding-agent host\n  └─ extension entry\n      └─ agent registry\n          └─ agent runner\n              ├─ hooks\n              ├─ context\n              └─ handoff",
};

export const getFeatureTourDuration = (data: PromoData) =>
  featureTourTiming.intro +
  data.coreCapabilities.length * featureTourTiming.capability +
  featureTourTiming.agents +
  featureTourTiming.compression +
  featureTourTiming.outro;

export const loadPromoData = async (dataFile = "promo-data.json") => {
  const response = await fetch(staticFile(dataFile));
  if (!response.ok) {
    throw new Error(`${dataFile} returned ${response.status}`);
  }

  const data = (await response.json()) as PromoData;
  if (!data.coreCapabilities?.length || !data.architectureAscii) {
    throw new Error(`${dataFile} is missing required promo fields`);
  }

  return data;
};

export const usePromoData = (dataFile = "promo-data.json") => {
  const [data, setData] = useState<PromoData>(fallbackPromoData);
  const {delayRender, continueRender} = useDelayRender();
  const continueRenderRef = useRef(continueRender);
  const [handle] = useState(() => delayRender(`Loading ${dataFile}`));

  useEffect(() => {
    let active = true;

    loadPromoData(dataFile)
      .then((value) => {
        if (active) {
          setData(value);
        }
        continueRenderRef.current(handle);
      })
      .catch((error: unknown) => {
        console.warn(`Using fallback promo data for ${dataFile}`, error);
        continueRenderRef.current(handle);
      });

    return () => {
      active = false;
    };
  }, [dataFile, handle]);

  return data;
};

export const calculateFeatureTourMetadata: CalculateMetadataFunction<FeatureTourProps> = async ({
  props,
}) => {
  const data = await loadPromoData(props.dataFile);
  return {durationInFrames: getFeatureTourDuration(data)};
};
