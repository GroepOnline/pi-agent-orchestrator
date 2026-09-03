#!/usr/bin/env bash
# Install GroepOnline Pi extensions globally (user scope).
# Safe to re-run. Does not touch API keys or write secrets to the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v pi >/dev/null 2>&1; then
  echo "ERROR: pi CLI not found on PATH" >&2
  exit 1
fi

echo "== building local orchestrator =="
(cd "$ROOT" && npm run build)

echo "== installing @groeponline extensions (global) =="
pi install npm:@groeponline/pi-wishcraft
pi install npm:@groeponline/pi-missions
pi install npm:@groeponline/pi-zai
pi install "$ROOT"

echo "== installed packages =="
pi list
