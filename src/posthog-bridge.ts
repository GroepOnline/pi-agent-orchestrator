/**
 * posthog-bridge.ts — Optional PostHog product-analytics bridge for agent
 * lifecycle telemetry.
 *
 * Mirrors the opt-in pattern used elsewhere in this extension: the bridge is
 * **inert unless a project key is configured** via the persisted `posthog.key`
 * setting in `.pi/subagents.json`. No telemetry ever leaves the host unless the
 * user opts in with their own project. There is no hardcoded or shared project
 * key, so a default install ships zero outbound analytics.
 *
 * Per the coding guidelines, runtime behavior resolves **only** the persisted
 * `PostHogConfig`. Ambient environment variables (`POSTHOG_KEY`,
 * `POSTHOG_HOST`, `POSTHOG_DISTINCT_ID`) are read once by
 * `postHogConfigToMigrate()` on first run to seed the persisted config. The one
 * runtime exception is `POSTHOG_HOST`, consulted as a fallback between a
 * configured `host` and the default proxy, so an operator's host choice wins
 * even when the persisted config was seeded without one. Telemetry egress
 * itself still requires an explicit, stored opt-in: the project key is never
 * read from the environment at runtime.
 *
 * The SDK is imported dynamically so a missing or broken `posthog-node`
 * install degrades to "no bridge" instead of crashing extension activation.
 */
import { createHash, randomUUID } from "node:crypto";
import { env } from "node:process";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { logger } from "./logger.js";

export interface PostHogConfig {
  /** PostHog project key (e.g. `phc_...`). When absent, the bridge stays inert. */
  key?: string;
  /** PostHog ingestion host. Defaults to the cloud app, or a self-hosted URL. */
  host?: string;
  /** Distinct id recorded on every captured event. */
  distinctId?: string;
}

export interface PostHogBridge {
  /** Fire-and-forget event capture. Swallows SDK errors (fail-open). */
  capture(event: string, properties?: Record<string, unknown>): void;
  /**
   * Flush pending events and shut the SDK client down. Returns a Promise that
   * resolves once the SDK has flushed, so callers can await it during session
   * shutdown to avoid dropping the final telemetry batch.
   */
  shutdown(): Promise<void>;
}

/** Ambient environment variables consumed only by the first-run migration. */
export interface PostHogEnvSource {
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  POSTHOG_DISTINCT_ID?: string;
}

const DEFAULT_POSTHOG_HOST = "https://k.chefgroep.online";

/**
 * Stable, opaque per-installation identity used when no `distinctId` is
 * configured. Derived from the Pi agent data directory so each install reports
 * as its own PostHog person (stable across restarts) instead of every install
 * collapsing into one shared identity. Falls back to a random id if the install
 * dir cannot be resolved.
 */
function anonymousInstallId(): string {
  try {
    const digest = createHash("sha256").update(getAgentDir()).digest("hex");
    return `install:${digest.slice(0, 16)}`;
  } catch {
    return randomUUID();
  }
}

/**
 * Resolve the effective project key, honoring an explicit value over a
 * fallback (such as the first-run env seed). Exported for testability without
 * touching process.env. Runtime bridge creation passes only the persisted key,
 * so this no longer reads ambient environment variables by default.
 */
export function resolvePostHogKey(
  configKey: string | undefined,
  fallbackKey?: string,
): string | undefined {
  return configKey ?? fallbackKey;
}

/**
 * First-run migration helper: when ambient PostHog env vars are set and no
 * project key is persisted yet, return the env-derived config so the caller can
 * persist it once. Returns `undefined` when there is nothing to seed (no env key
 * present, or a key is already persisted). Runtime bridge creation then resolves
 * only the persisted `PostHogConfig`, never the ambient env.
 */
export function postHogConfigToMigrate(
  persisted: PostHogConfig | undefined,
  envSource: PostHogEnvSource = env,
): PostHogConfig | undefined {
  if (!envSource.POSTHOG_KEY || persisted?.key) return undefined;
  // Preserve any partially-persisted config (e.g. a self-hosted `host` or a
  // chosen `distinctId` stored without a key) and only fill fields the env can
  // supply that are still absent, so seeding the env key never clobbers an
  // operator's existing endpoint/identity choices.
  const config: PostHogConfig = { ...persisted, key: envSource.POSTHOG_KEY };
  if (envSource.POSTHOG_HOST && !config.host) config.host = envSource.POSTHOG_HOST;
  if (envSource.POSTHOG_DISTINCT_ID && !config.distinctId) {
    config.distinctId = envSource.POSTHOG_DISTINCT_ID;
  }
  return config;
}

/**
 * Create a PostHog bridge, or `null` when no key is configured (the default,
 * inert state). The SDK is loaded lazily so the extension never hard-depends
 * on `posthog-node` being importable at activation time. Only the persisted
 * `PostHogConfig` is consulted; ambient env vars are handled by the first-run
 * migration, not here.
 */
export async function createPostHogBridge(config: PostHogConfig): Promise<PostHogBridge | null> {
  const key = resolvePostHogKey(config.key);
  if (!key) return null;

  const host = config.host ?? process.env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
  const distinctId = config.distinctId ?? anonymousInstallId();

  try {
    const { PostHog } = await import("posthog-node");
    const client = new PostHog(key, { host });
    logger.debug("PostHog telemetry bridge enabled", { host, distinctId });
    return {
      capture(event, properties) {
        try {
          client.capture({
            distinctId,
            event,
            // `$lib` placed after the spread so a caller-supplied property can
            // never override the library attribution.
            properties: { ...properties, $lib: "pi-agent-orchestrator" },
          });
        } catch (err) {
          logger.debug(
            `PostHog capture failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      async shutdown() {
        try {
          // posthog-node `shutdown()` returns Promise<void>; awaiting it lets
          // queued events flush before the host finishes unloading.
          await client.shutdown();
        } catch {
          /* best-effort flush; ignore */
        }
      },
    };
  } catch (err) {
    logger.warn("PostHog bridge could not start; staying inert", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
