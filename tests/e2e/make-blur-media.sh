#!/bin/sh
# Test video for blurring: 6 s per photo from Wikimedia Commons (US government / NASA portraits,
# landscapes; downloaded, not stored in the repo), light temporal noise so frames differ,
# 640×360 VP9 like YouTube DASH, 25 fps, keyframe every 2 s, limited range (full-range VP9
# fails to decode in Chrome). Ground truth and file names: tests/e2e/blur/timeline.json.
set -e
TL="$(cd "$(dirname "$0")/blur" && pwd)/timeline.json"
mkdir -p /tmp/mr/site /tmp/mr/blur-src && cd /tmp/mr
ARGS=""
FILTER=""
CONCAT=""
i=0
for f in $(node -e "for (const f of require('$TL').files) console.log(f)"); do
  out="blur-src/$i.jpg"
  if [ ! -s "$out" ]; then
    curl -sfL --retry 5 --retry-all-errors --retry-delay 2 -A "music-remover-tests/0.1" -o "$out" "https://commons.wikimedia.org/wiki/Special:FilePath/$f?width=800"
  fi
  ARGS="$ARGS -loop 1 -framerate 25 -t 6 -i $out"
  FILTER="$FILTER[$i:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,noise=alls=3:allf=t[v$i];"
  CONCAT="$CONCAT[v$i]"
  i=$((i+1))
done
ffmpeg -loglevel error -y $ARGS -filter_complex "${FILTER}${CONCAT}concat=n=$i:v=1:a=0,scale=out_range=tv,format=yuv420p[out]" -map "[out]" -t 48 -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -c:v libvpx-vp9 -b:v 600k -deadline realtime -cpu-used 8 -g 50 -keyint_min 50 -f webm -dash 1 -cluster_time_limit 2000 site/video-people.webm
echo "blur fixture ready: /tmp/mr/site/video-people.webm"

# Optional realistic fixture: `sh tests/e2e/make-blur-media.sh nasa` — 1080p VP9 clip of a NASA
# broadcast (public domain): 20 s of Mission Control (men), then 25 s of astronauts Christina Koch
# and Nick Hague on the ISS. Downloads the 600 MB 720p rendition once.
if [ "$1" = "nasa" ]; then
  B="https://images-assets.nasa.gov/video/iss060m261971013_Expedition_60_Apollo11_Network_Interviews_2019_0716/iss060m261971013_Expedition_60_Apollo11_Network_Interviews_2019_0716"
  mkdir -p nasa
  [ -s nasa/medium.mp4 ] || curl -sfL --retry 8 --retry-all-errors -C - -o nasa/medium.mp4 "$B~medium.mp4"
  ffmpeg -loglevel error -y -ss 100 -t 20 -i nasa/medium.mp4 -ss 420 -t 25 -i nasa/medium.mp4 \
    -filter_complex "[0:v]fps=30,scale=1920:1080,setsar=1[a];[1:v]fps=30,scale=1920:1080,setsar=1[b];[a][b]concat=n=2:v=1:a=0,format=yuv420p[out]" \
    -map "[out]" -c:v libvpx-vp9 -b:v 2500k -deadline realtime -cpu-used 8 -row-mt 1 -g 150 -keyint_min 150 -f webm -dash 1 -cluster_time_limit 5000 site/video-nasa1080.webm
  echo "nasa fixture ready: /tmp/mr/site/video-nasa1080.webm"
fi
