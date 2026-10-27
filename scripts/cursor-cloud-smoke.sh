#!/usr/bin/env bash
# Pi-host extension smoke test.
#
# Proves that the actual Pi host loads and activates the locally built extension
# (dist/index.js) without requiring any model API key. Uses RPC mode (which boots
# without credentials), asks the host to enumerate registered commands, and
# asserts the extension's commands were registered from dist/index.js.
#
# Bounded by a timeout; the Pi process exits on stdin EOF and is force-killed if
# it overruns. No tmux sessions or background processes are left behind.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/cursor-cloud-lib.sh
. scripts/cursor-cloud-lib.sh

cc_ensure_node
cc_assert_node

# Always rebuild. A stale dist/index.js left over from an earlier run would let
# the smoke test pass against code that no longer compiles or registers.
echo "== building extension =="
npm run build

# Prefer a PATH-installed Pi CLI (Dockerfile / install global), fall back to the
# locally linked host from node_modules so developer laptops still work.
PI_BIN=""
if [ -x "node_modules/.bin/pi" ]; then
    PI_BIN="node_modules/.bin/pi"
  elif command -v pi >/dev/null 2>&1; then
  PI_BIN="$(command -v pi)"
elif [ -x "node_modules/.bin/pi" ]; then
  PI_BIN="node_modules/.bin/pi"
fi
if [ -z "$PI_BIN" ]; then
  echo "ERROR: Pi host CLI not found on PATH or at node_modules/.bin/pi (run the install script first)." >&2
  exit 1
fi
echo "pi binary  : $PI_BIN ($("$PI_BIN" --version 2>/dev/null || echo unknown))"

echo "== loading dist/index.js through the Pi host (RPC mode, no credentials) =="
raw="$(printf '%s\n' '{"id":"smoke","type":"get_commands"}' \
  | timeout 60 "$PI_BIN" --mode rpc --no-session -e ./dist/index.js 2>/dev/null || true)"

echo "---- raw Pi RPC output ----"
printf '%s\n' "$raw"
echo "---------------------------"

printf '%s\n' "$raw" | node scripts/cloud-smoke-assert.mjs
