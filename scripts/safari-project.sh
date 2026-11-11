#!/bin/sh
# Builds the Safari bundle (dist-safari/), turns it into an Xcode project in safari-app/ and, with a
# simulator id, builds the app and installs it there. See docs/safari.md.
#   scripts/safari-project.sh                 project only
#   scripts/safari-project.sh <simulator-id>  project + build + install
#   TEST=1 scripts/safari-project.sh ...      also let the extension run on http://localhost:* (test pages)
set -e
cd "$(dirname "$0")/.."
BUNDLE_ID=${BUNDLE_ID:-dev.ayub.MusicRemover} # the extension gets <this>.Extension; for a real device use an id of your team (see docs/safari.md)
node scripts/build.mjs --safari ${TEST:+--test}
rm -rf safari-app
mkdir -p safari-app
xcrun safari-web-extension-converter dist-safari --project-location safari-app --app-name MusicRemover \
  --bundle-identifier "$BUNDLE_ID" --ios-only --no-open --no-prompt >/dev/null
# names shown on the home screen and in Safari's extension list
sed -i '' -e 's/INFOPLIST_KEY_CFBundleDisplayName = MusicRemover;/INFOPLIST_KEY_CFBundleDisplayName = "Халал Туб";/' \
  -e 's/INFOPLIST_KEY_CFBundleDisplayName = "MusicRemover Extension";/INFOPLIST_KEY_CFBundleDisplayName = "Халал Туб";/' \
  safari-app/MusicRemover/MusicRemover.xcodeproj/project.pbxproj
echo "Xcode project: safari-app/MusicRemover/MusicRemover.xcodeproj"
if [ -n "$TEAM" ] && [ -n "$1" ]; then
  # real device: automatic signing with TEAM (creates the App IDs / profiles in that Apple Developer account)
  xcodebuild -project safari-app/MusicRemover/MusicRemover.xcodeproj -scheme MusicRemover \
    -destination "id=$1" -derivedDataPath safari-app/build -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic build | grep -E "error:|BUILD"
  xcrun devicectl device install app --device "$1" safari-app/build/Build/Products/Debug-iphoneos/MusicRemover.app
elif [ -n "$1" ]; then
  xcodebuild -project safari-app/MusicRemover/MusicRemover.xcodeproj -scheme MusicRemover \
    -destination "id=$1" -derivedDataPath safari-app/build build | grep -E "error:|BUILD"
  xcrun simctl install "$1" safari-app/build/Build/Products/Debug-iphonesimulator/MusicRemover.app
  echo "installed on $1"
fi
