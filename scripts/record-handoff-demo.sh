#!/usr/bin/env bash
# Record bounded handoff demo (real Pi TUI + MiMo model footer) to ARTIFACT_DIR.
# Prerequisites: asciinema, agg, ffmpeg, tmux, pi, and a Pi-authenticated MiMo route.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR="${ARTIFACT_DIR:-/opt/cursor/artifacts}"
mkdir -p "$ARTIFACT_DIR"

CAST="$ARTIFACT_DIR/handoff-demo.cast"
GIF="$ARTIFACT_DIR/handoff-demo.gif"
MP4="$ARTIFACT_DIR/handoff-demo.mp4"
SESSION="handoff-demo-record"

for tool in asciinema ffmpeg tmux pi; do
  command -v "$tool" >/dev/null || { echo "$tool required" >&2; exit 1; }
done

MIMO_PROVIDER="${MIMO_PROVIDER:-}"
MIMO_MODEL="${MIMO_MODEL:-}"
MIMO_PREFLIGHT_TIMEOUT_SEC="${MIMO_PREFLIGHT_TIMEOUT_SEC:-30}"

if [[ -n "$MIMO_PROVIDER" || -n "$MIMO_MODEL" ]]; then
  if [[ -z "$MIMO_PROVIDER" || -z "$MIMO_MODEL" ]]; then
    echo "ERROR: set both MIMO_PROVIDER and MIMO_MODEL, or neither." >&2
    exit 1
  fi
  MIMO_CANDIDATES=("${MIMO_PROVIDER}|${MIMO_MODEL}")
else
  # Zero-credit defaults. Operators can override both variables for another route.
  MIMO_CANDIDATES=("bai|mimo-v2.5" "opencode-zen|mimo-v2.5-free")
fi

SELECTED_ROUTE=""
for candidate in "${MIMO_CANDIDATES[@]}"; do
  provider="${candidate%%|*}"
  model="${candidate#*|}"
  echo "== preflight MiMo route: ${provider}/${model} =="
  if ! pi auth check --provider "$provider" --model "$model" --json --no-refresh 2>/dev/null \
    | python3 -c 'import json,sys; raise SystemExit(0 if json.load(sys.stdin).get("status") == "ready" else 1)'; then
    echo "SKIP: Pi has no ready credential for ${provider}/${model}." >&2
    continue
  fi

  PREFLIGHT_OUT="$(mktemp)"
  PREFLIGHT_ERR="$(mktemp)"
  if timeout "${MIMO_PREFLIGHT_TIMEOUT_SEC}s" pi \
    --provider "$provider" --model "$model" --thinking off \
    --no-tools --no-session --no-extensions --no-context-files -p \
    'Reply with exactly READY and nothing else.' >"$PREFLIGHT_OUT" 2>"$PREFLIGHT_ERR" \
    && grep -qx 'READY' "$PREFLIGHT_OUT"; then
    SELECTED_ROUTE="$candidate"
    rm -f "$PREFLIGHT_OUT" "$PREFLIGHT_ERR"
    break
  fi
  echo "SKIP: live MiMo preflight failed, timed out, or returned unexpected output for ${provider}/${model}." >&2
  rm -f "$PREFLIGHT_OUT" "$PREFLIGHT_ERR"
done

if [[ -z "$SELECTED_ROUTE" ]]; then
  echo "ERROR: no live MiMo route passed the READY preflight; recording was not started." >&2
  exit 1
fi
MIMO_PROVIDER="${SELECTED_ROUTE%%|*}"
MIMO_MODEL="${SELECTED_ROUTE#*|}"
export MIMO_PROVIDER MIMO_MODEL

AGG_BIN="${AGG_BIN:-$(command -v agg || true)}"
if [[ -z "$AGG_BIN" || ! -x "$AGG_BIN" ]]; then
  echo "ERROR: agg must be installed on PATH, or set AGG_BIN to an executable path." >&2
  exit 1
fi

cleanup() {
  tmux -f /exec-daemon/tmux.portal.conf kill-session -t "$SESSION" 2>/dev/null || true
}
trap cleanup EXIT

cd "$ROOT"
bash "$ROOT/scripts/install-groeponline-extensions.sh"

export TERM=xterm-256color
export COLORTERM=truecolor
export FORCE_COLOR=3
export PI_CLI_THEME="${PI_CLI_THEME:-181818,e0d0c0,15161e,f7768e,9ece6a,e0af68,7aa2f7,bb9af7,7dcfff,a9b1d6,414868,f7768e,9ece6a,e0af68,7aa2f7,bb9af7,7dcfff,c0caf5}"
export HANDOFF_DEMO_SESSION="$SESSION"

tmux -f /exec-daemon/tmux.portal.conf kill-session -t "$SESSION" 2>/dev/null || true
tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESSION" -c "$ROOT" -x 120 -y 40

echo "== recording terminal demo to $CAST =="
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESSION" \
  "asciinema rec --overwrite --cols 120 --rows 40 --idle-time-limit 8 '$CAST'" C-m
sleep 2

bash "$ROOT/scripts/handoff-demo-drive.sh"

if [[ ! -s "$CAST" ]]; then
  echo "ERROR: recording failed — cast file missing or empty" >&2
  exit 1
fi

echo "== rendering GIF with agg =="
export AGG_FONT_SIZE="${AGG_FONT_SIZE:-18}"
"$AGG_BIN" --speed 0.55 \
  --renderer fontdue \
  --font-size "$AGG_FONT_SIZE" \
  --cols 120 --rows 40 \
  --fps-cap 30 \
  --idle-time-limit 6 \
  --theme "$PI_CLI_THEME" \
  --no-loop \
  "$CAST" "$GIF"

echo "== encoding 1080p MP4 =="
ffmpeg -y -i "$GIF" \
  -movflags +faststart -pix_fmt yuv420p \
  -preset slow -crf 18 \
  -vf "scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x181818" \
  "$MP4" 2>/dev/null

echo "== ffprobe =="
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt \
  -show_entries format=duration \
  -of default=nw=1 "$MP4"

echo ""
echo "Artifacts:"
echo "  cast : $CAST"
echo "  gif  : $GIF"
echo "  mp4  : $MP4"
