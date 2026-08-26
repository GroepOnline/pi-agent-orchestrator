#!/usr/bin/env bash
# Record the Xiaomi MiMo Spark short demo to /opt/cursor/artifacts (or ARTIFACT_DIR).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR="${ARTIFACT_DIR:-/opt/cursor/artifacts}"
mkdir -p "$ARTIFACT_DIR"

CAST="$ARTIFACT_DIR/xiaomi-mimo-demo.cast"
GIF="$ARTIFACT_DIR/xiaomi-mimo-demo.gif"
MP4="$ARTIFACT_DIR/xiaomi-mimo-demo.mp4"

command -v asciinema >/dev/null || { echo "asciinema required" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg required" >&2; exit 1; }

AGG_BIN="${AGG_BIN:-/tmp/agg}"
if [ ! -x "$AGG_BIN" ]; then
  curl -sL "https://github.com/asciinema/agg/releases/download/v1.7.0/agg-x86_64-unknown-linux-gnu" \
    -o "$AGG_BIN" && chmod +x "$AGG_BIN"
fi

cd "$ROOT"
export TERM=xterm-256color
export COLORTERM=truecolor
export FORCE_COLOR=3
export PI_CLI_THEME="${PI_CLI_THEME:-181818,e0d0c0,15161e,f7768e,9ece6a,e0af68,7aa2f7,bb9af7,7dcfff,a9b1d6,414868,f7768e,9ece6a,e0af68,7aa2f7,bb9af7,7dcfff,c0caf5}"

echo "== recording terminal demo to $CAST =="
asciinema rec --overwrite \
  --cols 120 --rows 40 \
  --idle-time-limit 30 \
  --command "node $ROOT/scripts/xiaomi-mimo-demo.mjs" \
  "$CAST" </dev/null

echo "== rendering GIF with agg =="
export AGG_FONT_SIZE="${AGG_FONT_SIZE:-18}"
"$AGG_BIN" --speed 1.0 \
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
