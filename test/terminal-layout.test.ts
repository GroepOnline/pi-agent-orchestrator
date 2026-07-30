import {describe, expect, it} from "vitest";
import {
  fitTerminalTypography,
  TERMINAL_CHROME,
} from "../showcase/remotion/src/terminal-layout.js";

describe("terminal showcase layout", () => {
  it("fits a real 36-row Pi CLI capture including the prompt bar", () => {
    const typography = fitTerminalTypography(36);

    expect(typography.fittedRows).toBeGreaterThanOrEqual(35.999);
    expect(typography.fontSize).toBeLessThanOrEqual(TERMINAL_CHROME.maxFontSize);
    expect(TERMINAL_CHROME.top + TERMINAL_CHROME.height).toBeLessThanOrEqual(1080 - 20);
  });

  it("scales below the previous fixed 17.5px that clipped the Pi prompt bar", () => {
    const typography = fitTerminalTypography(36, {
      ...TERMINAL_CHROME,
      height: 760,
      titleBar: 60,
      paddingY: 24,
      progressBar: 3,
      lineHeightRatio: 1.29,
      maxFontSize: 40,
    });

    expect(typography.fontSize).toBeLessThan(17.5);
    expect(typography.fittedRows).toBeGreaterThanOrEqual(35.999);
  });

  it("still fits denser terminals without clipping", () => {
    const typography = fitTerminalTypography(42);
    expect(typography.fittedRows).toBeGreaterThanOrEqual(41.999);
  });
});
