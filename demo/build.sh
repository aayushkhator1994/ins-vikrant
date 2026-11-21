#!/bin/bash
# Reproducible build of demo/ins-vikrant-demo.mp4
# Inputs : demo/slides/NN-*.html (one per slide), demo/narration.txt (line N = narration for slide N)
# Outputs: demo/slides/NN-*.png, demo/ins-vikrant-demo.mp4   (intermediates in $TMP)
# Live screenshots (timeline.png, memo.png) are only re-captured with RECAPTURE=1 (needs the bridge on :8787).
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
DEMO="$(cd "$(dirname "$0")" && pwd)"
SLIDES="$DEMO/slides"
TMP="${TMPDIR_DEMO:-/tmp/ins-vikrant-demo}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
VOICE="${VOICE:-Samantha}"
RATE=172
PAD_BEFORE=0.3     # narration starts this far into each slide
PAD_TOTAL=0.7      # slide duration = narration + this
OUT="$DEMO/ins-vikrant-demo.mp4"
mkdir -p "$TMP"

shot() { # shot <out.png> <url>
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1920,1080 --screenshot="$1" "$2" >/dev/null 2>&1
}

narrate() { # narrate <out.aiff> <text>  -- `say` occasionally hangs; give it 30 s, then retry (up to 3 tries)
  local out="$1" text="$2" try pid n
  for try in 1 2 3; do
    rm -f "$out"
    say -v "$VOICE" -r "$RATE" -o "$out" "$text" &
    pid=$!; n=0
    while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 60 ]; do sleep 0.5; n=$((n+1)); done
    if kill -0 "$pid" 2>/dev/null; then
      echo "say hung (try $try), retrying" >&2
      kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
      continue
    fi
    if wait "$pid" && [ -s "$out" ]; then return 0; fi
  done
  echo "say failed for: $text" >&2; return 1
}

# 0. inputs for slides 2 and 8
[ -f "$SLIDES/user-flow.png" ] || cp "$DEMO/../docs/user-flow.png" "$SLIDES/user-flow.png"
if [ "${RECAPTURE:-0}" = "1" ] || [ ! -f "$SLIDES/timeline.png" ] || [ ! -f "$SLIDES/memo.png" ]; then
  shot "$SLIDES/timeline.png" "http://localhost:8787/missions"
  shot "$SLIDES/memo.png"     "http://localhost:8787/missions/nvda-kill-demo"
fi

# 1. render slides, 2. narrate, 3. one segment per slide
: > "$TMP/concat.txt"
i=0
for html in "$SLIDES"/[0-9][0-9]-*.html; do
  i=$((i+1))
  base="$(basename "$html" .html)"
  png="$SLIDES/$base.png"
  shot "$png" "file://$html"

  text="$(sed -n "${i}p" "$DEMO/narration.txt")"
  [ -n "$text" ] || { echo "no narration line $i for $base" >&2; exit 1; }
  narrate "$TMP/$base.aiff" "$text"
  ffmpeg -y -loglevel error -i "$TMP/$base.aiff" -ar 48000 -ac 2 -c:a pcm_s16le "$TMP/$base.wav"
  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/$base.wav")"
  total="$(python3 -c "print(round(($dur+$PAD_TOTAL)*30)/30)")"   # whole frames
  delay_ms="$(python3 -c "print(int($PAD_BEFORE*1000))")"

  ffmpeg -y -loglevel error -loop 1 -framerate 30 -i "$png" -i "$TMP/$base.wav" \
    -filter_complex "[0:v]scale=1920:1080,format=yuv420p[v];[1:a]adelay=${delay_ms}:all=1,apad[a]" \
    -map "[v]" -map "[a]" -t "$total" -r 30 \
    -c:v libx264 -preset medium -crf 18 -tune stillimage -g 30 -pix_fmt yuv420p \
    -c:a pcm_s16le "$TMP/$base.mkv"
  echo "file '$TMP/$base.mkv'" >> "$TMP/concat.txt"
  printf '%s  narration %.2fs  slide %.2fs\n' "$base" "$dur" "$total"
done

# 4. concatenate (video copied, audio encoded once to AAC)
ffmpeg -y -loglevel error -f concat -safe 0 -i "$TMP/concat.txt" \
  -c:v copy -c:a aac -b:a 160k -movflags +faststart "$OUT"

# 5. report
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,pix_fmt -of default=nw=1 "$OUT"
