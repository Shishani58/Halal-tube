#!/bin/sh
# Generates demuxer test fixtures with ffmpeg into /tmp/mr
set -e
mkdir -p /tmp/mr && cd /tmp/mr
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=12" -ac 2 -c:a libopus -b:a 128k -f webm -dash 1 -cluster_time_limit 2000 a.webm
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=12" -ac 2 -c:a libopus -b:a 128k -f webm -live 1 live.webm
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=12" -ac 2 -ar 44100 -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 a.mp4
