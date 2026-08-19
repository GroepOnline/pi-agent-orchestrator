import { afterEach, describe, expect, it } from "vitest";

import {
  createPostHogBridge,
  type PostHogBridge,
  type PostHogClient,
  type PostHogClientFactory,
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

  function factoryFor(client: PostHogClient): PostHogClientFactory {
    return async () => client;
  }

  afterEach(async () => {
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

  it("creates a capture/shutdown bridge with the configured client", async () => {
    const client: PostHogClient = { capture() {}, async shutdown() {} };
    bridge = await createPostHogBridge({ key: "phc_test" }, factoryFor(client));
    expect(bridge).not.toBeNull();
    expect(typeof bridge?.capture).toBe("function");
    expect(typeof bridge?.shutdown).toBe("function");
  });

  it("capture preserves attribution and is fail-open when the client throws", async () => {
    const captured: Array<Parameters<PostHogClient["capture"]>[0]> = [];
    const client: PostHogClient = {
      capture(event) {
        captured.push(event);
        throw new Error("offline");
      },
      async shutdown() {},
    };
    bridge = await createPostHogBridge(
      { key: "phc_test", distinctId: "test-node" },
      factoryFor(client),
    );

    expect(() => bridge?.capture("agent_spawned", { $lib: "untrusted", type: "Explore" })).not.toThrow();
    expect(captured).toEqual([
      {
        distinctId: "test-node",
        event: "agent_spawned",
        properties: { $lib: "pi-agent-orchestrator", type: "Explore" },
      },
    ]);
  });

  it("shutdown awaits the client and remains fail-open on flush failures", async () => {
    let shutdownCalls = 0;
    const client: PostHogClient = {
      capture() {},
      async shutdown() {
        shutdownCalls += 1;
        throw new Error("offline");
      },
    };
    bridge = await createPostHogBridge({ key: "phc_test" }, factoryFor(client));

    const result = bridge?.shutdown();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    await expect(bridge?.shutdown()).resolves.toBeUndefined();
    expect(shutdownCalls).toBe(2);
  });

  it("stays inert when the SDK client cannot be created", async () => {
    bridge = await createPostHogBridge(
      { key: "phc_test" },
      async () => Promise.reject(new Error("SDK unavailable")),
    );
    expect(bridge).toBeNull();
  });
});
