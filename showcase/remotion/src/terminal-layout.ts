/**
 * Layout math for the Remotion terminal chrome.
 *
 * Real Pi asciicasts are typically 120×36. A fixed fontSize that only fits ~28
 * rows clips the Pi CLI prompt bar at the bottom, so typography must scale to
 * `rows` and still leave every captured line visible inside the chrome.
 */

export const TERMINAL_CHROME = {
  top: 148,
  left: 96,
  right: 96,
  height: 860,
  titleBar: 44,
  paddingY: 12,
  paddingX: 20,
  progressBar: 3,
  lineHeightRatio: 1.18,
  /** Cap only when fewer rows would otherwise make glyphs huge; never scale up past a fit. */
  maxFontSize: 18.5,
} as const;

export interface TerminalTypography {
  contentHeight: number;
  fontSize: number;
  lineHeight: number;
  fittedRows: number;
}

export const fitTerminalTypography = (
  rows: number,
  chrome: typeof TERMINAL_CHROME = TERMINAL_CHROME,
): TerminalTypography => {
  const safeRows = Math.max(1, Math.floor(rows));
  const contentHeight =
    chrome.height - chrome.titleBar - chrome.paddingY * 2 - chrome.progressBar;
  if (contentHeight <= 0) {
    throw new Error("Terminal chrome leaves no content height for typography");
  }

  const rawFontSize = contentHeight / (safeRows * chrome.lineHeightRatio);
  const fontSize = Math.min(chrome.maxFontSize, rawFontSize);
  const fittedRows = contentHeight / (fontSize * chrome.lineHeightRatio);

  return {
    contentHeight,
    fontSize,
    lineHeight: chrome.lineHeightRatio,
    fittedRows,
  };
};
