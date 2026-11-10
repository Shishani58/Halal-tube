#!/bin/sh
# Signs the built app with the developer's OWN "Apple Development" certificate, for running it on this
# Mac: the signature gives the app a stable identity, so macOS keeps the "System Audio Recording"
# permission between builds (an unsigned build is asked again every time). It is not for
# distribution: that needs a Developer ID Application certificate and notarisation
# (scripts/sign-notarize.sh). Distribution / Developer ID certificates are never picked here.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../target/release/bundle/macos/Music Remover.app"
[ -d "$APP" ] || { echo "build the app first: npm run build" >&2; exit 1; }
# by SHA-1 hash: names can hold characters the shell mangles
ID="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning | grep '"Apple Development' | head -1 | awk '{print $2}')}"
[ -n "$ID" ] || { echo "no \"Apple Development\" certificate in the keychain (Xcode → Settings → Accounts → Manage Certificates)" >&2; exit 1; }
echo "signing with: $ID"
codesign --force --options runtime --entitlements "$HERE/../app/entitlements.plist" --sign "$ID" "$APP"
codesign --verify --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|Authority|TeamIdentifier|flags"
