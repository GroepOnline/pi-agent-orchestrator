#!/usr/bin/env bash
# Cursor Cloud install/update command (referenced by .cursor/environment.json).
#
# Idempotent and safe to run repeatedly on every VM boot. Resolves a compliant
# Node, prints versions, performs a deterministic install, and fails if npm
# reports an engine mismatch. Does not modify package-lock.json.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/cursor-cloud-lib.sh
. scripts/cursor-cloud-lib.sh

echo "== Cursor Cloud install =="
cc_ensure_node
cc_assert_node
cc_print_versions

echo "== apt refresh =="
cc_refresh_system_packages

echo "== npm ci =="
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
# Deterministic install from the lockfile; do not let npm rewrite it.
set +e
npm ci 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
set -e
if [ "$status" -ne 0 ]; then
  echo "ERROR: npm ci failed (exit $status)." >&2
  exit "$status"
fi
if grep -q "EBADENGINE" "$log"; then
  echo "ERROR: npm reported EBADENGINE; the active Node does not satisfy engines." >&2
  exit 1
fi

echo "== pi CLI =="
cc_ensure_pi_cli

echo "== pi host smoke =="
# Prove the built extension loads in the real Pi host (no API key required).
bash "$CC_ROOT/scripts/cursor-cloud-smoke.sh"

echo "== install complete =="
