// Decide whether a version exists on npm from a `npm view` result.
//
// Split out from verify-release-transaction.mjs so the fail-closed rule is
// unit-testable without spawning npm: a release verifier must never read a
// transient npm failure as "version absent", because that flips the caller into
// its re-release bypass and skips the exact-file-set and baseline gates.

/**
 * @param {{ status?: number|null, stdout?: string|null, stderr?: string|null, error?: Error|null }} result
 * @param {string} version
 * @returns {{ state: "present"|"absent"|"unknown", reason?: string }}
 */
export function classifyNpmViewResult(result, version) {
  if (result?.error) {
    return { state: "unknown", reason: `npm could not run: ${result.error.message}` };
  }
  if (result?.status === 0) {
    const stdout = (result.stdout ?? "").trim();
    return stdout === version
      ? { state: "present" }
      : { state: "absent", reason: `registry returned "${stdout}"` };
  }
  const stderr = `${result?.stderr ?? ""}`;
  if (/\bE404\b|404 Not Found/.test(stderr)) {
    return { state: "absent", reason: "registry answered 404" };
  }
  return {
    state: "unknown",
    reason: `npm exit ${result?.status ?? "null"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
  };
}
