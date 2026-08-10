import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySettings,
  loadSettings,
  type SettingsAppliers,
  saveSettings,
  VALID_ANIMATION_STYLES,
} from "../src/settings.js";

const noop = () => {};

function appliers(setAnimationStyle: (style: Parameters<SettingsAppliers["setAnimationStyle"]>[0]) => void): SettingsAppliers {
  return {
    setMaxConcurrent: noop,
    setSessionLimits: noop,
    setDefaultMaxTurns: noop,
    setGraceTurns: noop,
    setMaxEndHookRevisions: noop,
    setDefaultJoinMode: noop,
    setSchedulingEnabled: noop,
    setTracingEnabled: noop,
    setAnimationStyle,
    setUiStyle: noop,
    setShowActivityStream: noop,
    setShowTokenUsage: noop,
    setShowTurnProgress: noop,
    setOrchestrationMode: noop,
    setDashboardRefreshInterval: noop,
    setPromptCompressionLevel: noop,
    setDebugCapture: noop,
    setDebugCapturePaths: noop,
    setDashboardKeybindings: noop,
    setFooterStatusConfig: noop,
  };
}

describe("motion profile settings", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-motion-settings-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("round-trips every supported profile", () => {
    for (const profile of VALID_ANIMATION_STYLES) {
      saveSettings({ animationStyle: profile }, projectDir);
      expect(loadSettings(projectDir).animationStyle).toBe(profile);
    }
  });

  it("drops unknown profiles", () => {
    saveSettings({ animationStyle: "hyperdrive" as never }, projectDir);
    expect(loadSettings(projectDir).animationStyle).toBeUndefined();
  });

  it("applies a persisted profile through the existing animationStyle hook", () => {
    const apply = vi.fn();
    applySettings({ animationStyle: "reduced" }, appliers(apply));
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith("reduced");
  });
});
