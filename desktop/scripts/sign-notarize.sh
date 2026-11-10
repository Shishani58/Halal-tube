#!/bin/sh
# Signs the built .app with a Developer ID, packs it into the DMG, signs and notarises the DMG.
# Needs an Apple Developer account ($99/year). NOT run yet: no certificate on this machine.
#
#   export SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"   # security find-identity -v -p codesigning
#   export NOTARY_PROFILE="music-remover"   # once: xcrun notarytool store-credentials music-remover --apple-id … --team-id … --password <app-specific>
#   sh scripts/sign-notarize.sh
set -e
: "${SIGN_IDENTITY:?set SIGN_IDENTITY (see the header of this script)}"
: "${NOTARY_PROFILE:?set NOTARY_PROFILE (see the header of this script)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../target/release/bundle/macos/Music Remover.app"
[ -d "$APP" ] || { echo "build the app first: npm run build" >&2; exit 1; }

# inside-out: nested dylibs / helpers first, the bundle last (--deep is deprecated for this)
find "$APP/Contents" -type f \( -name '*.dylib' -o -perm -111 \) ! -path "$APP/Contents/MacOS/*" -print0 |
  xargs -0 -n1 codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY"
codesign --force --options runtime --timestamp --entitlements "$HERE/../app/entitlements.plist" --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

DMG="$(sh "$HERE/make-dmg.sh" | tail -1)"
codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"
spctl --assess --type open --context context:primary-signature --verbose "$DMG"
echo "signed and notarised: $DMG"
