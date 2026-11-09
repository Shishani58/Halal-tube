#!/bin/sh
# Packs the built .app into a drag-to-Applications DMG.
# (Tauri's own DMG script breaks on recent macOS, so we do it with hdiutil directly.)
set -e
cd "$(dirname "$0")/../target/release/bundle"
VERSION=$(node -p "require('../../../app/tauri.conf.json').version")
ARCH=$(uname -m)
OUT="dmg/Music Remover_${VERSION}_${ARCH}.dmg"
rm -rf dmg-src && mkdir -p dmg-src dmg
cp -R "macos/Music Remover.app" dmg-src/
ln -s /Applications dmg-src/Applications
rm -f "$OUT"
hdiutil create -volname "Music Remover" -srcfolder dmg-src -ov -format UDZO "$OUT" >/dev/null 2>&1
rm -rf dmg-src
echo "$PWD/$OUT"
