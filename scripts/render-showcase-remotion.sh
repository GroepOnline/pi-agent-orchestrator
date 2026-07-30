#!/usr/bin/env bash
# Render the real terminal capture plus the source-derived Remotion promo suite.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTION_DIR="$ROOT/showcase/remotion"
OUT_DIR="$ROOT/docs/images"
CAST_PATH="${SHOWCASE_CAST:-${1:-}}"

if [[ -z "$CAST_PATH" ]]; then
	echo "Usage: npm run showcase:remotion -- /path/to/real-session.cast" >&2
	echo "Set SHOWCASE_CAST instead to supply the asciicast path." >&2
	exit 2
fi
if [[ ! -f "$CAST_PATH" ]]; then
	echo "Asciicast not found: $CAST_PATH" >&2
	exit 2
fi
CAST_PATH="$(cd "$(dirname "$CAST_PATH")" && pwd)/$(basename "$CAST_PATH")"

mkdir -p "$OUT_DIR"
cd "$ROOT"

npm run build
npm --prefix "$REMOTION_DIR" install --no-audit --no-fund --ignore-scripts
node "$REMOTION_DIR/scripts/capture-terminal.mjs" "$CAST_PATH"
node "$REMOTION_DIR/scripts/extract-promo-data.mjs"
npm --prefix "$REMOTION_DIR" run verify

EXTRA_ARGS=()
if [[ -n "${REMOTION_BROWSER_EXECUTABLE:-}" ]]; then
  EXTRA_ARGS+=("--browser-executable=${REMOTION_BROWSER_EXECUTABLE}")
fi

render() {
  npm --prefix "$REMOTION_DIR" run "$1" -- "${EXTRA_ARGS[@]}"
}

normalize_terminal_video() {
  local video="$1"
  local normalized="${video%.mp4}.normalized.mp4"
  local -a ffmpeg_command=(ffmpeg)
  if ! command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg_command=(npm --prefix "$REMOTION_DIR" exec -- remotion ffmpeg)
  fi
  "${ffmpeg_command[@]}" -loglevel error -y -i "$video" \
    -vf "scale=in_range=pc:out_range=tv" \
    -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -color_range tv \
    -an -movflags +faststart "$normalized"
  mv "$normalized" "$video"
}

render render:master
render render:skill-creation
render render:subagent-run
render render:dashboard-top
render render:handoff
normalize_terminal_video "$OUT_DIR/dashboard_preview.mp4"
normalize_terminal_video "$OUT_DIR/showcase_skill_creation.mp4"
normalize_terminal_video "$OUT_DIR/showcase_subagent_run.mp4"
normalize_terminal_video "$OUT_DIR/showcase_dashboard_top.mp4"
normalize_terminal_video "$OUT_DIR/showcase_handoff.mp4"
render poster
render promo:banner
render promo:social
render promo:architecture
render promo:film
render promo:tour
node "$ROOT/scripts/verify-showcase-media.mjs"

cat <<SUMMARY
Remotion assets rendered:
  - $OUT_DIR/dashboard_preview.mp4
  - $OUT_DIR/showcase_skill_creation.mp4
  - $OUT_DIR/showcase_subagent_run.mp4
  - $OUT_DIR/showcase_dashboard_top.mp4
  - $OUT_DIR/showcase_handoff.mp4
  - $OUT_DIR/dashboard_preview.png
  - $OUT_DIR/promo_banner.png
  - $OUT_DIR/social_preview.png
  - $OUT_DIR/architecture_overview.png
  - $OUT_DIR/product_film.mp4
  - $OUT_DIR/feature_tour.mp4
SUMMARY
