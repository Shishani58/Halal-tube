#!/bin/sh
# Builds the local e2e fixtures in /tmp/mr: a known voice track, a synthetic music track,
# their mix as DASH WebM/Opus (audio.webm) and a VP9 test video (video.webm).
set -e
mkdir -p /tmp/mr/site && cd /tmp/mr
say -o speech_long.aiff "Welcome to this short documentary about the ocean. The ocean covers more than seventy percent of our planet. It is home to millions of species, from tiny plankton to the enormous blue whale. Scientists believe that most of the ocean is still unexplored. Every year, researchers discover new creatures living in the deep sea, where sunlight never reaches. These animals have adapted to extreme pressure and cold. Some of them produce their own light. In the next part, we will talk about coral reefs, which are among the most diverse ecosystems on Earth. Thank you for watching."
ffmpeg -loglevel error -y -i speech_long.aiff -ar 44100 -ac 2 -af "adelay=2000|2000,apad=whole_dur=45" -t 45 -f f32le speech45.f32
R='pow(2,mod(floor(t/2)*5,12)/12)'
ffmpeg -loglevel error -y -f lavfi -i "aevalsrc='0.12*(sin(2*PI*220*$R*t)+0.6*sin(2*PI*277.18*$R*t)+0.6*sin(2*PI*329.63*$R*t)+0.3*sin(4*PI*220*$R*t))*(0.7+0.3*sin(2*PI*4*t)) + 0.25*sin(2*PI*55*$R*t)*exp(-3*mod(t,0.5)) + (random(0)*2-1)*0.25*exp(-35*mod(t,0.25)) + 0.35*sin(2*PI*60*t)*exp(-12*mod(t,1))':s=44100:d=45" -ac 2 -f f32le music45.f32
ffmpeg -loglevel error -y -f f32le -ar 44100 -ac 2 -i speech45.f32 -f f32le -ar 44100 -ac 2 -i music45.f32 -filter_complex "amix=inputs=2:normalize=0" -c:a libopus -b:a 128k -ar 48000 -f webm -dash 1 -cluster_time_limit 2000 site/audio.webm
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=25:duration=45" -c:v libvpx-vp9 -b:v 300k -deadline realtime -cpu-used 8 -g 50 -f webm -dash 1 -cluster_time_limit 2000 site/video.webm
echo "fixtures ready in /tmp/mr"
