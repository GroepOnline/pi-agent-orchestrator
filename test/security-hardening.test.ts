/**
 * security-hardening.test.ts — Regression guards for thermos/security findings:
 *   - token-bound RPC auth (no trust-on-claim extensionId)
 *   - RPC spawn option allowlist (no bypassQueue / callbacks)
 *   - ctx_* injection respects useContextMode + parent allowlist
 *   - schedule in-flight overlap guard
 *   - output-file path segment sanitization
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EffectiveConfig, registerAgents } from "../src/agent-types.js";
import { resolveCtxInjectionForAgent } from "../src/context-mode-bridge.js";
import {
  createTokenAuthProvider,
  type EventBus,
  registerRpcHandlers,
  resetRpcRateLimitsForTests,
  type SpawnCapable,
  sanitizeRpcSpawnOptions,
} from "../src/cross-extension-rpc.js";
import { CTX_TOOL_NAMES } from "../src/ctx-tool-names.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { createOutputFilePath, sanitizeOutputPathSegment } from "../src/output-file.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => {
        listeners.get(event)?.delete(handler);
      };
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

describe("createTokenAuthProvider", () => {
  const provider = createTokenAuthProvider("secret-token");

  it("rejects missing authToken even when extensionId is present", () => {
    expect(
      provider("r1", { authContext: { extensionId: "peer-ext" } }),
    ).toBeUndefined();
  });

  it("rejects wrong authToken (spoofed extensionId alone is insufficient)", () => {
    expect(
      provider("r1", {
        authContext: { extensionId: "spoofed", authToken: "wrong" },
      }),
    ).toBeUndefined();
  });

  it("accepts matching authToken and returns sanitized extensionId", () => {
    expect(
      provider("r1", {
        authContext: {
          extensionId: "peer-ext",
          extensionName: "Peer",
          authToken: "secret-token",
        },
      }),
    ).toEqual({ extensionId: "peer-ext", extensionName: "Peer" });
  });

  it("rejects unsafe extensionId shapes", () => {
    expect(
      provider("r1", {
        authContext: {
          extensionId: "../evil",
          authToken: "secret-token",
        },
      }),
    ).toBeUndefined();
  });
});

describe("sanitizeRpcSpawnOptions", () => {
  it("strips bypassQueue and callback/signal fields", () => {
    const sanitized = sanitizeRpcSpawnOptions({
      description: "ok",
      isBackground: true,
      bypassQueue: true,
      signal: {},
      onToolActivity: () => {},
      cwd: "/etc",
    });
    expect(sanitized).toEqual({ description: "ok", isBackground: true });
    expect(sanitized).not.toHaveProperty("bypassQueue");
    expect(sanitized).not.toHaveProperty("cwd");
  });
});

describe("RPC spawn with token auth + option allowlist", () => {
  let events: EventBus;
  let manager: SpawnCapable;

  beforeEach(() => {
    resetRpcRateLimitsForTests();
    events = createEventBus();
    manager = {
      spawn: vi.fn().mockReturnValue("agent-42"),
      abort: vi.fn().mockReturnValue(true),
    };
    registerRpcHandlers({
      events,
      pi: { events },
      getCtx: () => ({ session: true }),
      manager,
      authProvider: createTokenAuthProvider("host-token"),
    });
  });

  it("authorizes spawn when authContext with token is forwarded", async () => {
    const reply = vi.fn();
    events.on("subagents:rpc:spawn:reply:req-ok", reply);
    events.emit("subagents:rpc:spawn", {
      requestId: "req-ok",
      type: "general-purpose",
      prompt: "x",
      authContext: { extensionId: "peer", authToken: "host-token" },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
    expect(manager.spawn).toHaveBeenCalled();
  });

  it("rejects spawn that spoofs extensionId without the host token", async () => {
    const reply = vi.fn();
    events.on("subagents:rpc:spawn:reply:req-spoof", reply);
    events.emit("subagents:rpc:spawn", {
      requestId: "req-spoof",
      type: "general-purpose",
      prompt: "x",
      authContext: { extensionId: "spoofed-ext" },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({
      success: false,
      error: "Unauthorized RPC request",
    });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("rejects stop that spoofs extensionId without the host token", async () => {
    const reply = vi.fn();
    events.on("subagents:rpc:stop:reply:req-stop-spoof", reply);
    events.emit("subagents:rpc:stop", {
      requestId: "req-stop-spoof",
      agentId: "agent-42",
      authContext: { extensionId: "spoofed-ext" },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({
      success: false,
      error: "Unauthorized RPC request",
    });
    expect(manager.abort).not.toHaveBeenCalled();
  });

  it("does not forward bypassQueue from RPC options to manager.spawn", async () => {
    const reply = vi.fn();
    events.on("subagents:rpc:spawn:reply:req-bq", reply);
    events.emit("subagents:rpc:spawn", {
      requestId: "req-bq",
      type: "Explore",
      prompt: "x",
      authContext: { extensionId: "peer", authToken: "host-token" },
      options: {
        description: "search",
        isBackground: true,
        bypassQueue: true,
        onTextDelta: () => {},
      },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(manager.spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Explore",
      "x",
      { description: "search", isBackground: true },
    );
  });
});

describe("ctx_* permission boundaries", () => {
  // Cleanup runs even when an assertion throws, so a failed test can't leak the
  // isContextModeAvailable mock or a reset module registry into later tests.
  afterEach(() => {
    vi.doUnmock("../src/context-mode-bridge.js");
    vi.resetModules();
    registerAgents(new Map(DEFAULT_AGENTS));
  });

  it("resolveCtxInjectionForAgent returns null when useContextMode is false", () => {
    expect(resolveCtxInjectionForAgent(false)).toBeNull();
    expect(resolveCtxInjectionForAgent(undefined)).toBeNull();
  });

  it("RO parent denies ctx_* on Analysis; full parent still allows them", async () => {
    vi.resetModules();
    vi.doMock("../src/context-mode-bridge.js", async () => {
      const actual = await vi.importActual<typeof import("../src/context-mode-bridge.js")>(
        "../src/context-mode-bridge.js",
      );
      return {
        ...actual,
        isContextModeAvailable: () => true,
      };
    });
    const {
      getConfig: getConfigFresh,
      registerAgents: registerAgentsFresh,
      BUILTIN_TOOL_NAMES,
    } = await import("../src/agent-types.js");
    registerAgentsFresh(new Map(DEFAULT_AGENTS));

    const roParent: EffectiveConfig = {
      builtinToolNames: ["read", "bash", "grep"],
      extensions: false,
      skills: false,
    };
    const underRo = getConfigFresh("Analysis", roParent);
    for (const name of CTX_TOOL_NAMES) {
      expect(underRo.builtinToolNames).not.toContain(name);
    }

    const fullParent: EffectiveConfig = {
      builtinToolNames: [...BUILTIN_TOOL_NAMES],
      extensions: true,
      skills: true,
    };
    const underFull = getConfigFresh("Analysis", fullParent);
    for (const name of CTX_TOOL_NAMES) {
      expect(underFull.builtinToolNames).toContain(name);
    }
  });

  it("appends only the parent-approved subset when the parent lists some ctx_* tools", async () => {
    vi.resetModules();
    vi.doMock("../src/context-mode-bridge.js", async () => {
      const actual = await vi.importActual<typeof import("../src/context-mode-bridge.js")>(
        "../src/context-mode-bridge.js",
      );
      return {
        ...actual,
        isContextModeAvailable: () => true,
      };
    });
    const { getConfig: getConfigFresh, registerAgents: registerAgentsFresh } = await import(
      "../src/agent-types.js"
    );
    registerAgentsFresh(new Map(DEFAULT_AGENTS));

    const [allowedCtx, ...deniedCtx] = CTX_TOOL_NAMES;
    // Parent that allows exactly one context tool alongside read-only base tools.
    const partialParent: EffectiveConfig = {
      builtinToolNames: ["read", "grep", allowedCtx],
      extensions: false,
      skills: false,
    };
    const child = getConfigFresh("Analysis", partialParent);
    expect(child.builtinToolNames).toContain(allowedCtx);
    for (const name of deniedCtx) {
      expect(child.builtinToolNames).not.toContain(name);
    }
  });
});

describe("read-only built-ins deny host extension tools", () => {
  it("Explore and Plan set extensions: false", () => {
    expect(DEFAULT_AGENTS.get("Explore")?.extensions).toBe(false);
    expect(DEFAULT_AGENTS.get("Plan")?.extensions).toBe(false);
  });
});

describe("output-file path sanitization", () => {
  it("sanitizeOutputPathSegment strips path separators and bare dot segments", () => {
    // Lossy inputs keep their safe, human-readable base as a prefix but gain a
    // stable hash suffix for collision resistance.
    expect(sanitizeOutputPathSegment("../../etc/passwd")).toMatch(/^etc-passwd-[0-9a-f]{8}$/);
    expect(sanitizeOutputPathSegment("a/b\\c")).toMatch(/^a-b-c-[0-9a-f]{8}$/);
    expect(sanitizeOutputPathSegment("..")).toMatch(/^_-[0-9a-f]{8}$/);
    expect(sanitizeOutputPathSegment(".")).toMatch(/^_-[0-9a-f]{8}$/);
  });

  it("keeps already-safe segments verbatim (no suffix)", () => {
    expect(sanitizeOutputPathSegment("session-123")).toBe("session-123");
    expect(sanitizeOutputPathSegment("V1StGXR8Z")).toBe("V1StGXR8Z");
  });

  it("keeps colliding separator variants on distinct paths", () => {
    // "a/b" and "a-b" both normalize to base "a-b"; the suffix must keep them apart.
    const slash = sanitizeOutputPathSegment("a/b");
    const dash = sanitizeOutputPathSegment("a-b");
    expect(dash).toBe("a-b"); // already safe → verbatim
    expect(slash).toMatch(/^a-b-[0-9a-f]{8}$/);
    expect(slash).not.toBe(dash);
  });

  it("distinguishes inputs that differ only past the truncation boundary", () => {
    const long = "x".repeat(300);
    const a = sanitizeOutputPathSegment(`${long}a`);
    const b = sanitizeOutputPathSegment(`${long}b`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(200);
    expect(b.length).toBeLessThanOrEqual(200);
  });

  it("is stable for the same input", () => {
    expect(sanitizeOutputPathSegment("a/b")).toBe(sanitizeOutputPathSegment("a/b"));
  });

  it("createOutputFilePath keeps resolved path under the encoded cwd directory", () => {
    const path = createOutputFilePath("/home/user/proj", "..", "..");
    const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
    const cwdDir = join(root, "home-user-proj");
    const resolved = resolve(path);
    expect(resolved.startsWith(`${resolve(cwdDir)}${sep}`)).toBe(true);
  });
});

describe("schedule in-flight overlap guard", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: {
    spawn: ReturnType<typeof vi.fn>;
    getRecord: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "sched-sec-"));
    store = await ScheduleStore.create(join(tmp, "s.json"));
    manager = {
      spawn: vi.fn(),
      getRecord: vi.fn(),
    };
    manager.spawn.mockImplementation(() => {
      const id = `agent-${Math.random().toString(36).slice(2, 8)}`;
      let resolve!: (value: string) => void;
      const promise = new Promise<string>((r) => {
        resolve = r;
      });
      (manager as { _resolve?: (v: string) => void })._resolve = resolve;
      manager.getRecord.mockReturnValue({ status: "running", promise });
      return id;
    });
    scheduler = new SubagentScheduler();
    await scheduler.start(
      { events: { emit: vi.fn() } } as never,
      {
        cwd: tmp,
        modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
        sessionManager: { getSessionId: () => "sess-sec" },
      } as never,
      manager as never,
      store,
    );
  });

  afterEach(() => {
    scheduler?.stop();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("skips a second fire while the previous run is still in flight", async () => {
    const job = await scheduler.addJob({
      name: "overlap",
      description: "x",
      schedule: "10s",
      subagent_type: "general-purpose",
      prompt: "x",
    });
    await scheduler.updateJob(job.id, { intervalMs: 10, schedule: "10ms" });

    await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 80));
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    const resolve = (manager as { _resolve?: (v: string) => void })._resolve;
    manager.getRecord.mockReturnValue({ status: "completed", promise: Promise.resolve("") });
    resolve?.("");
    await new Promise((r) => setTimeout(r, 50));
  });
});
