#!/bin/sh
# Generates demuxer test fixtures with ffmpeg into /tmp/mr
set -e
mkdir -p /tmp/mr && cd /tmp/mr
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=12" -ac 2 -c:a libopus -b:a 128k -f webm -dash 1 -cluster_time_limit 2000 a.webm
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=12" -ac 2 -c:a libopus -b:a 128k -f webm -live 1 live.webm
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=12" -ac 2 -ar 44100 -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 a.mp4
# video: 10 s at 25 fps, keyframe every 2 s
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=25:duration=10" -c:v libvpx-vp9 -b:v 200k -deadline realtime -cpu-used 8 -g 50 -f webm -dash 1 -cluster_time_limit 2000 v.webm
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=25:duration=10" -c:v libx264 -profile:v high -bf 2 -g 50 -keyint_min 50 -sc_threshold 0 -pix_fmt yuv420p -movflags frag_keyframe+empty_moov+default_base_moof v.mp4
