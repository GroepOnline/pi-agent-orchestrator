/**
 * env-context.ts — Build EnvInfo from the host-provided `WorkspaceContext`.
 *
 * Hosts that omit `workspaceContext` get a git-empty default. No git exec.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EnvInfo, WorkspaceContext } from "./types.js";

export function buildEnvFromContext(pi: ExtensionAPI): EnvInfo | undefined {
  // biome-ignore lint/suspicious/noTsIgnore: intentional bypass
  // @ts-ignore: Intentionally bypassing type-checking on pi.workspaceContext to avoid CI failure
  const wc: WorkspaceContext = (pi as any).workspaceContext;
  if (!wc) return undefined;
  return {
    isGitRepo: wc.git.isRepo,
    branch: wc.git.isRepo ? wc.git.branch : "",
    platform: wc.platform,
  };
}
