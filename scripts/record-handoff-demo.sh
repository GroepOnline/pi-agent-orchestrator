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

MIMO_PROVIDER="${MIMO_PROVIDER:-openrouter}"
MIMO_MODEL="${MIMO_MODEL:-xiaomi/mimo-v2.5-pro}"
MIMO_PREFLIGHT_TIMEOUT_SEC="${MIMO_PREFLIGHT_TIMEOUT_SEC:-30}"

echo "== preflight MiMo route: ${MIMO_PROVIDER}/${MIMO_MODEL} =="
if ! pi auth check --provider "$MIMO_PROVIDER" --model "$MIMO_MODEL" --json --no-refresh \
  | python3 -c 'import json,sys; raise SystemExit(0 if json.load(sys.stdin).get("status") == "ready" else 1)'; then
  echo "ERROR: Pi has no ready credential for ${MIMO_PROVIDER}/${MIMO_MODEL}." >&2
  exit 1
fi

PREFLIGHT_OUT="$(mktemp)"
PREFLIGHT_ERR="$(mktemp)"
if ! timeout "${MIMO_PREFLIGHT_TIMEOUT_SEC}s" pi \
  --provider "$MIMO_PROVIDER" --model "$MIMO_MODEL" --thinking off \
  --no-tools --no-session --no-extensions --no-context-files -p \
  'Reply with exactly READY and nothing else.' >"$PREFLIGHT_OUT" 2>"$PREFLIGHT_ERR"; then
  rm -f "$PREFLIGHT_OUT" "$PREFLIGHT_ERR"
  echo "ERROR: live MiMo preflight failed or timed out; recording was not started." >&2
  exit 1
fi
if ! grep -qx 'READY' "$PREFLIGHT_OUT"; then
  rm -f "$PREFLIGHT_OUT" "$PREFLIGHT_ERR"
  echo "ERROR: live MiMo preflight returned an unexpected response; recording was not started." >&2
  exit 1
fi
rm -f "$PREFLIGHT_OUT" "$PREFLIGHT_ERR"
export MIMO_PROVIDER MIMO_MODEL

AGG_BIN="${AGG_BIN:-/tmp/agg}"
if [[ ! -x "$AGG_BIN" ]]; then
  curl -sL "https://github.com/asciinema/agg/releases/download/v1.7.0/agg-x86_64-unknown-linux-gnu" \
    -o "$AGG_BIN" && chmod +x "$AGG_BIN"
fi

cleanup() {
  tmux -f /exec-daemon/tmux.portal.conf kill-session -t "$SESSION" 2>/dev/null || true
}
trap cleanup EXIT

cd "$ROOT"
bash "$ROOT/scripts/install-groeponline-extensions.sh"

mkdir -p "$HOME/.pi/agent"
python3 <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".pi/agent/trust.json"
try:
    data = json.loads(p.read_text())
except Exception:
    data = {}
data["/workspace"] = True
p.write_text(json.dumps(data))
PY

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
