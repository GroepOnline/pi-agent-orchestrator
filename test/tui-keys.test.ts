import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DASHBOARD_KEYBINDINGS,
  matchDashboardKey,
} from "../src/ui/dashboard-keybindings.js";
import {
  decodePrintableKey,
  matchesKey,
  parseKey,
  setKittyProtocolActive,
} from "../src/ui/keys.js";

/**
 * These cases mirror what the Pi host actually delivers to handleInput:
 * raw terminal bytes, not canonical names like "up" / "space".
 */
describe("matchesKey raw terminal sequences", () => {
  afterEach(() => {
    setKittyProtocolActive(false);
  });

  it("matches arrow keys from legacy ANSI and SS3 sequences", () => {
    expect(matchesKey("\x1b[A", "up")).toBe(true);
    expect(matchesKey("\x1bOA", "up")).toBe(true);
    expect(matchesKey("\x1b[B", "down")).toBe(true);
    expect(matchesKey("\x1bOB", "down")).toBe(true);
    expect(matchesKey("\x1b[C", "right")).toBe(true);
    expect(matchesKey("\x1b[D", "left")).toBe(true);
  });

  it("matches space as the literal space byte, not the word space", () => {
    expect(matchesKey(" ", "space")).toBe(true);
    expect(matchesKey("space", "space")).toBe(true); // canonical pass-through
    expect(matchesKey("x", "space")).toBe(false);
  });

  it("matches enter/return as CR/LF and numpad SS3 M", () => {
    expect(matchesKey("\r", "enter")).toBe(true);
    expect(matchesKey("\r", "return")).toBe(true);
    expect(matchesKey("\n", "enter")).toBe(true);
    expect(matchesKey("\x1bOM", "enter")).toBe(true);
  });

  it("matches escape as the raw ESC byte", () => {
    expect(matchesKey("\x1b", "escape")).toBe(true);
    expect(matchesKey("\x1b", "esc")).toBe(true);
  });

  it("matches ctrl+c as the raw control character", () => {
    expect(matchesKey("\u0003", "ctrl+c")).toBe(true);
  });

  it("matches shift+letter via uppercase legacy form", () => {
    expect(matchesKey("K", "shift+k")).toBe(true);
    expect(matchesKey("S", "shift+s")).toBe(true);
  });

  it("matches plain letters and Kitty CSI-u printable sequences", () => {
    expect(matchesKey("s", "s")).toBe(true);
    expect(matchesKey("j", "j")).toBe(true);
    // Kitty CSI-u for 's' (codepoint 115) and 'j' (106)
    expect(matchesKey("\x1b[115u", "s")).toBe(true);
    expect(matchesKey("\x1b[106u", "j")).toBe(true);
    expect(matchesKey("\x1b[107u", "k")).toBe(true);
  });

  it("matches page/home/end legacy sequences", () => {
    expect(matchesKey("\x1b[5~", "pageUp")).toBe(true);
    expect(matchesKey("\x1b[6~", "pageDown")).toBe(true);
    expect(matchesKey("\x1b[H", "home")).toBe(true);
    expect(matchesKey("\x1b[F", "end")).toBe(true);
  });

  it("matches Kitty CSI-u for space and enter", () => {
    expect(matchesKey("\x1b[32u", "space")).toBe(true);
    expect(matchesKey("\x1b[13u", "enter")).toBe(true);
  });
});

describe("dashboard bindings against raw host input", () => {
  const bindings = DEFAULT_DASHBOARD_KEYBINDINGS;

  it("navigates with arrows and vim keys", () => {
    expect(matchDashboardKey("\x1b[A", "moveUp", bindings)).toBe(true);
    expect(matchDashboardKey("k", "moveUp", bindings)).toBe(true);
    expect(matchDashboardKey("\x1b[B", "moveDown", bindings)).toBe(true);
    expect(matchDashboardKey("j", "moveDown", bindings)).toBe(true);
  });

  it("toggles select on literal space", () => {
    expect(matchDashboardKey(" ", "toggleSelect", bindings)).toBe(true);
  });

  it("opens conversation on CR enter", () => {
    expect(matchDashboardKey("\r", "openConversation", bindings)).toBe(true);
  });

  it("steers on s and Kitty CSI-u s", () => {
    expect(matchDashboardKey("s", "steer", bindings)).toBe(true);
    expect(matchDashboardKey("\x1b[115u", "steer", bindings)).toBe(true);
  });

  it("kills on uppercase K", () => {
    expect(matchDashboardKey("K", "kill", bindings)).toBe(true);
  });
});

describe("decodePrintableKey", () => {
  it("decodes Kitty CSI-u printable characters for command mode", () => {
    expect(decodePrintableKey("\x1b[97u")).toBe("a");
    expect(decodePrintableKey("\x1b[115u")).toBe("s");
    expect(decodePrintableKey("\x1b[A")).toBeUndefined();
  });

  it("ignores Kitty CSI-u release and repeat events (flag 2)", () => {
    // Press with explicit event type still decodes.
    expect(decodePrintableKey("\x1b[115;1:1u")).toBe("s");
    // Release and repeat must not produce printable input.
    expect(decodePrintableKey("\x1b[115;1:3u")).toBeUndefined();
    expect(decodePrintableKey("\x1b[115;1:2u")).toBeUndefined();
  });
});

describe("Kitty protocol active mode", () => {
  afterEach(() => {
    setKittyProtocolActive(false);
  });

  it("maps Ghostty shift+enter and Kitty shift+enter when protocol is active", () => {
    setKittyProtocolActive(true);
    expect(matchesKey("\n", "shift+enter")).toBe(true);
    expect(matchesKey("\x1b\r", "shift+enter")).toBe(true);
    expect(parseKey("\n")).toBe("shift+enter");
    expect(parseKey("\x1b\r")).toBe("shift+enter");
  });

  it("does not treat newline as enter when Kitty protocol is active", () => {
    setKittyProtocolActive(true);
    expect(matchesKey("\n", "enter")).toBe(false);
    expect(parseKey("\n")).toBe("shift+enter");
  });

  it("treats newline as enter when Kitty protocol is inactive", () => {
    setKittyProtocolActive(false);
    expect(matchesKey("\n", "enter")).toBe(true);
    expect(parseKey("\n")).toBe("enter");
    expect(matchesKey("\n", "shift+enter")).toBe(false);
  });

  it("maps alt+enter only in legacy mode without Kitty protocol", () => {
    setKittyProtocolActive(false);
    expect(matchesKey("\x1b\r", "alt+enter")).toBe(true);
    expect(parseKey("\x1b\r")).toBe("alt+enter");

    setKittyProtocolActive(true);
    expect(matchesKey("\x1b\r", "alt+enter")).toBe(false);
    expect(matchesKey("\x1b\r", "shift+enter")).toBe(true);
  });
});

describe("parseKey", () => {
  it("parses common raw sequences to canonical ids", () => {
    expect(parseKey("\x1b[A")).toBe("up");
    expect(parseKey(" ")).toBe("space");
    expect(parseKey("\r")).toBe("enter");
    expect(parseKey("s")).toBe("s");
  });
});
