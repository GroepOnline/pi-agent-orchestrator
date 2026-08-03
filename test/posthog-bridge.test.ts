import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPostHogBridge,
  type PostHogBridge,
  postHogConfigToMigrate,
  resolvePostHogKey,
} from "../src/posthog-bridge.js";

describe("resolvePostHogKey", () => {
  it("returns undefined when neither setting nor fallback is set", () => {
    expect(resolvePostHogKey(undefined, undefined)).toBeUndefined();
  });

  it("prefers the explicit setting over the fallback", () => {
    expect(resolvePostHogKey("phc_setting", "phc_env")).toBe("phc_setting");
  });

  it("falls back to the secondary value when the setting is absent", () => {
    expect(resolvePostHogKey(undefined, "phc_env")).toBe("phc_env");
  });

  it("does not read ambient process.env on its own", () => {
    // Runtime bridge creation passes a single arg; no env should leak in.
    expect(resolvePostHogKey(undefined)).toBeUndefined();
    expect(resolvePostHogKey("phc_persisted")).toBe("phc_persisted");
  });
});

describe("postHogConfigToMigrate", () => {
  it("returns undefined when no env key is present", () => {
    expect(postHogConfigToMigrate(undefined, {})).toBeUndefined();
    expect(postHogConfigToMigrate(undefined, { POSTHOG_HOST: "https://x" })).toBeUndefined();
  });

  it("returns undefined when a key is already persisted", () => {
    expect(
      postHogConfigToMigrate({ key: "phc_persisted" }, { POSTHOG_KEY: "phc_env" }),
    ).toBeUndefined();
  });

  it("seeds the env-derived config (key only) on first run", () => {
    expect(postHogConfigToMigrate(undefined, { POSTHOG_KEY: "phc_env" })).toEqual({
      key: "phc_env",
    });
  });

  it("seeds host and distinctId alongside the key when present", () => {
    expect(
      postHogConfigToMigrate(undefined, {
        POSTHOG_KEY: "phc_env",
        POSTHOG_HOST: "https://eu.posthog.com",
        POSTHOG_DISTINCT_ID: "node-7",
      }),
    ).toEqual({ key: "phc_env", host: "https://eu.posthog.com", distinctId: "node-7" });
  });

  it("ignores empty-string env values", () => {
    expect(
      postHogConfigToMigrate(undefined, { POSTHOG_KEY: "", POSTHOG_HOST: "", POSTHOG_DISTINCT_ID: "" }),
    ).toBeUndefined();
  });

  it("preserves partially-persisted host/distinctId when seeding the env key", () => {
    expect(
      postHogConfigToMigrate(
        { host: "https://selfhosted.example.com", distinctId: "fleet-3" },
        { POSTHOG_KEY: "phc_env", POSTHOG_HOST: "https://app.posthog.com", POSTHOG_DISTINCT_ID: "node-7" },
      ),
    ).toEqual({
      key: "phc_env",
      host: "https://selfhosted.example.com",
      distinctId: "fleet-3",
    });
  });

  it("fills only absent fields from env over a partial persisted config", () => {
    expect(
      postHogConfigToMigrate(
        { host: "https://selfhosted.example.com" },
        { POSTHOG_KEY: "phc_env", POSTHOG_DISTINCT_ID: "node-7" },
      ),
    ).toEqual({
      key: "phc_env",
      host: "https://selfhosted.example.com",
      distinctId: "node-7",
    });
  });
});

describe("createPostHogBridge", () => {
  let bridge: PostHogBridge | null = null;

  afterEach(async () => {
    // Stop the SDK client so no background flush handles keep the test runner alive.
    try {
      await bridge?.shutdown();
    } catch {
      /* best-effort */
    }
    bridge = null;
  });

  it("stays inert (null) when no key is configured", async () => {
    expect(await createPostHogBridge({})).toBeNull();
    expect(await createPostHogBridge({ host: "https://example.com" })).toBeNull();
    expect(await createPostHogBridge({ distinctId: "x" })).toBeNull();
  });

  it("creates a capture/shutdown bridge when a key is set", async () => {
    // Point at a closed local port so no real telemetry leaves the test runner.
    bridge = await createPostHogBridge({ key: "phc_test", host: "http://127.0.0.1:1" });
    expect(bridge).not.toBeNull();
    expect(typeof bridge?.capture).toBe("function");
    expect(typeof bridge?.shutdown).toBe("function");
  });

  it("capture is fail-open (never throws) against a dead endpoint", async () => {
    bridge = await createPostHogBridge({ key: "phc_test", host: "http://127.0.0.1:1" });
    expect(() => bridge?.capture("agent_spawned", { type: "Explore" })).not.toThrow();
    expect(() => bridge?.capture("agent_completed", { type: "general-purpose", duration: 12 })).not.toThrow();
  });

  it("shutdown returns a Promise that resolves (flush is awaited, not dropped)", async () => {
    bridge = await createPostHogBridge({ key: "phc_test", host: "http://127.0.0.1:1" });
    const result = bridge?.shutdown();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    // Calling again must remain best-effort safe.
    await expect(bridge?.shutdown()).resolves.toBeUndefined();
  });

  it("defaults to the k.chefgroep.online reverse proxy when no host is configured", async () => {
    const ctor = vi.fn(function PostHogMock() {
      return { capture() {}, shutdown() {} };
    });
    vi.doMock("posthog-node", () => ({ PostHog: ctor }));
    try {
      bridge = await createPostHogBridge({ key: "phc_test" });
      expect(bridge).not.toBeNull();
      expect(ctor).toHaveBeenCalledOnce();
      // posthog-node@5 is constructed as new PostHog(key, { host }).
      expect(ctor).toHaveBeenCalledWith("phc_test", { host: "https://k.chefgroep.online" });
    } finally {
      vi.doUnmock("posthog-node");
    }
  });
});

describe("createPostHogBridge default host", () => {
  afterEach(() => {
    vi.doUnmock("posthog-node");
    vi.resetModules();
  });

  it("passes the managed reverse proxy host to the PostHog constructor when no host is configured", async () => {
    const constructorCalls: Array<{ key: string; options: { host?: string } }> = [];
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        constructor(key: string, options: { host?: string }) {
          constructorCalls.push({ key, options });
        }
        capture(): void {}
        async shutdown(): Promise<void> {}
      },
    }));
    vi.resetModules();
    // Fresh import so the module's dynamic `import("posthog-node")` resolves the mock.
    const { createPostHogBridge: createFresh } = await import("../src/posthog-bridge.js");

    const mockedBridge = await createFresh({ key: "phc_test" });
    expect(mockedBridge).not.toBeNull();
    expect(constructorCalls).toEqual([
      { key: "phc_test", options: { host: "https://k.chefgroep.online" } },
    ]);
    await mockedBridge?.shutdown();
  });

  it("prefers a configured host over the default", async () => {
    const constructorCalls: Array<{ key: string; options: { host?: string } }> = [];
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        constructor(key: string, options: { host?: string }) {
          constructorCalls.push({ key, options });
        }
        capture(): void {}
        async shutdown(): Promise<void> {}
      },
    }));
    vi.resetModules();
    const { createPostHogBridge: createFresh } = await import("../src/posthog-bridge.js");

    const mockedBridge = await createFresh({
      key: "phc_test",
      host: "https://selfhosted.example.com",
    });
    expect(mockedBridge).not.toBeNull();
    expect(constructorCalls).toEqual([
      { key: "phc_test", options: { host: "https://selfhosted.example.com" } },
    ]);
    await mockedBridge?.shutdown();
  });

  it("falls back to the ambient POSTHOG_HOST when no host is configured", async () => {
    const constructorCalls: Array<{ key: string; options: { host?: string } }> = [];
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        constructor(key: string, options: { host?: string }) {
          constructorCalls.push({ key, options });
        }
        capture(): void {}
        async shutdown(): Promise<void> {}
      },
    }));
    vi.resetModules();
    const previous = process.env.POSTHOG_HOST;
    process.env.POSTHOG_HOST = "https://ingest.example.com";
    try {
      const { createPostHogBridge: createFresh } = await import("../src/posthog-bridge.js");

      const mockedBridge = await createFresh({ key: "phc_test" });
      expect(mockedBridge).not.toBeNull();
      expect(constructorCalls).toEqual([
        { key: "phc_test", options: { host: "https://ingest.example.com" } },
      ]);
      await mockedBridge?.shutdown();
    } finally {
      if (previous === undefined) delete process.env.POSTHOG_HOST;
      else process.env.POSTHOG_HOST = previous;
    }
  });
});
