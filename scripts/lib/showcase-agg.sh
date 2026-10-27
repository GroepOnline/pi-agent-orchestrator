#!/usr/bin/env bash
# Shared agg → GIF/MP4 conversion (fidelity profiles from pi-agent-control-extension).
set -euo pipefail

# Pi CLI palette
export PI_CLI_THEME="${PI_CLI_THEME:-181818,e0d0c0,15161e,f7768e,9ece6a,e0af68,7aa2f7,bb9af7,7dcfff,a9b1d6,414868,f7768e,9ece6a,e0af68,7aa2f7,bb9af7,7dcfff,c0caf5}"

agg_render_cast() {
	local cast="$1"
	local gif="$2"
	local fidelity="${3:-inspect}"
	local speed="${4:-1.1}"

	local cols rows agg_fps_cap agg_idle_limit
	# Pass the cast path as an env var (not interpolated into the Python
	# source) so filenames with quotes, backslashes, or other shell-active
	# characters can't break the parser or smuggle code in.
	cols=$(CAST="$cast" python3 -c "
import json, os
h=json.loads(open(os.environ['CAST']).readline())
t=h.get('term') or {}
print(h.get('width') or t.get('cols', 120))
")
	rows=$(CAST="$cast" python3 -c "
import json, os
h=json.loads(open(os.environ['CAST']).readline())
t=h.get('term') or {}
print(h.get('height') or t.get('rows', 36))
")

	case "$fidelity" in
	compact)
		agg_fps_cap=24
		agg_idle_limit=3
		;;
	standard)
		agg_fps_cap=30
		agg_idle_limit=5
		;;
	inspect | *)
		agg_fps_cap=30
		agg_idle_limit=8
		;;
	esac

	agg --speed "$speed" \
		--renderer fontdue \
		--font-size "${AGG_FONT_SIZE:-17}" \
		--cols "$cols" \
		--rows "$rows" \
		--fps-cap "$agg_fps_cap" \
		--idle-time-limit "$agg_idle_limit" \
		--theme "$PI_CLI_THEME" \
		--no-loop \
		"$cast" \
		"$gif"
}

agg_cast_to_mp4() {
	local gif="$1"
	local mp4="$2"
	local crf="${3:-16}"
	ffmpeg -y -i "$gif" \
		-movflags +faststart -pix_fmt yuv420p \
		-preset slow -crf "$crf" \
		-vf "scale=1280:720:flags=lanczos:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x181818" \
		"$mp4" 2>/dev/null
}
