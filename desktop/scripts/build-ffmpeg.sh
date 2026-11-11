#!/bin/sh
# Builds a static, LGPL-only ffmpeg + ffprobe (arm64/x86_64, whatever this Mac is) from the official
# source tarball and puts them in desktop/vendor/ffmpeg/, which tauri.conf.json bundles into the app.
#
# Only LGPL parts are enabled (no --enable-gpl, no x264/x265): video is copied as is, or (blur) re-encoded with the
# hardware VideoToolbox encoder; audio is decoded/encoded with native codecs, libmp3lame (LGPL) and libopus (BSD, static).
# Needs: brew install lame opus mpg123 pkg-config
set -e

VERSION=9.0.2
SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e   # same as the Homebrew formula
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/vendor/ffmpeg"
WORK="$ROOT/target/ffmpeg-build"
MIN_MACOS=14.0

if [ -x "$OUT/ffmpeg" ] && [ -x "$OUT/ffprobe" ] && [ "$1" != "--force" ]; then
  echo "already built: $OUT (use --force to rebuild)"; exit 0
fi

LAME=$(brew --prefix lame); OPUS=$(brew --prefix opus); MPG=$(brew --prefix mpg123)
[ -f "$LAME/lib/libmp3lame.a" ] && [ -f "$OPUS/lib/libopus.a" ] || { echo "brew install lame opus pkg-config"; exit 1; }

mkdir -p "$WORK" "$OUT"
# only the static archives in one directory, so the linker can't pick Homebrew's .dylib instead
rm -rf "$WORK/staticlibs" && mkdir -p "$WORK/staticlibs"
ln -s "$LAME/lib/libmp3lame.a" "$OPUS/lib/libopus.a" "$MPG/lib/libmpg123.a" "$WORK/staticlibs/"  # Homebrew's lame decodes through mpg123
TAR="$WORK/ffmpeg-$VERSION.tar.xz"
[ -f "$TAR" ] || curl -fL --proto '=https' -o "$TAR" "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
echo "$SHA256  $TAR" | shasum -a 256 -c - || { rm -f "$TAR"; echo "checksum mismatch"; exit 1; }

rm -rf "$WORK/src" && mkdir -p "$WORK/src" && tar -xf "$TAR" -C "$WORK/src" --strip-components=1
cd "$WORK/src"

PKG_CONFIG_PATH="$OPUS/lib/pkgconfig" ./configure \
  --prefix="$WORK/install" \
  --disable-autodetect --disable-doc --disable-debug --disable-ffplay \
  --enable-ffmpeg --enable-ffprobe --disable-shared --enable-static \
  --enable-libmp3lame --enable-libopus --enable-zlib --enable-iconv --enable-videotoolbox --enable-audiotoolbox \
  --extra-cflags="-mmacosx-version-min=$MIN_MACOS -I$LAME/include -I$OPUS/include" \
  --extra-ldflags="-mmacosx-version-min=$MIN_MACOS -L$WORK/staticlibs" \
  --extra-libs="-liconv -lmpg123"

make -j"$(sysctl -n hw.ncpu)"
cp ffmpeg ffprobe "$OUT/"
strip "$OUT/ffmpeg" "$OUT/ffprobe"
"$OUT/ffmpeg" -hide_banner -version | head -2
otool -L "$OUT/ffmpeg" | tail -n +2 | grep -v -E '/usr/lib|/System/' && { echo "unexpected non-system dylib"; exit 1; }
echo "built: $OUT"
