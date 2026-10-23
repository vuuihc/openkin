#!/usr/bin/env bash
# Archive the iOS app and hand the build to TestFlight.
#
# Usage:
#   KIN_HUB_URL=https://kin.example.com scripts/release-ios.sh [--archive-only]
#
# The Hub origin is compiled in at sync time (see capacitor.config.ts): a
# TestFlight build points at whatever `KIN_HUB_URL` said when it was made, and
# that origin has to stay reachable for as long as the build is installed. A
# quick tunnel URL is the wrong thing to bake into a build that lives 90 days;
# use the Hub's real domain.
#
# Signing is automatic against the team in the Xcode project. Archiving and
# uploading both need the Mac to be signed in to that Apple ID in Xcode
# (Settings → Accounts) — the first upload for a bundle id also needs the app
# record to exist in App Store Connect, which Xcode cannot create for you on
# the command line.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${KIN_HUB_URL:?set KIN_HUB_URL to the origin your Hub is served at, e.g. https://kin.example.com}"
[[ "$KIN_HUB_URL" != *127.0.0.1* && "$KIN_HUB_URL" != *localhost* ]] || {
  echo "error: KIN_HUB_URL is $KIN_HUB_URL — a TestFlight build has to point at a Hub the phone can reach" >&2
  exit 1
}

ARCHIVE_ONLY=0
[[ "${1:-}" == "--archive-only" ]] && ARCHIVE_ONLY=1

DERIVED="$PWD/ios/DerivedData"
PACKAGES="$DERIVED/SourcePackages"
CACHE="$DERIVED/PackageCache"
ARCHIVE="$PWD/ios/build/Kin.xcarchive"
EXPORT_DIR="$PWD/ios/build/export"
EXPORT_PLIST="$PWD/ios/build/ExportOptions.plist"
TEAM_ID="$(sed -n 's/.*DEVELOPMENT_TEAM = \([A-Z0-9]*\);.*/\1/p' ios/App/App.xcodeproj/project.pbxproj | head -1)"
[[ -n "$TEAM_ID" ]] || { echo "error: no DEVELOPMENT_TEAM in project.pbxproj" >&2; exit 1; }

# Every upload needs a CFBundleVersion nothing has used before, and App Store
# Connect rejects a repeat. A minute-resolution timestamp is monotonic and needs
# no state kept on disk; KIN_BUILD_NUMBER overrides it when you want a specific
# one (a hand-made build, or re-uploading after a rejection).
BUILD_NUMBER="${KIN_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
MARKETING_VERSION="${KIN_MARKETING_VERSION:-1.0}"

echo "==> hub origin:      $KIN_HUB_URL"
echo "==> version:         $MARKETING_VERSION ($BUILD_NUMBER)"
echo "==> team:            $TEAM_ID"

(cd ../ui && npm run build)
npm run --silent sync

# Same git-over-HTTPS problem as build-ios.sh: Xcode resolves Capacitor's Swift
# package with a bare clone, which fails on a machine that needs a proxy.
MIRROR="$CACHE/repositories/capacitor-swift-pm-c864e9bc"
if [ ! -d "$MIRROR" ]; then
  echo "==> seeding the Swift package cache with capacitor-swift-pm"
  mkdir -p "$CACHE/repositories"
  git clone --quiet --mirror https://github.com/ionic-team/capacitor-swift-pm.git "$MIRROR"
fi

rm -rf "$ARCHIVE"
echo "==> archiving"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$DERIVED" \
  -clonedSourcePackagesDirPath "$PACKAGES" -packageCachePath "$CACHE" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" MARKETING_VERSION="$MARKETING_VERSION" \
  -allowProvisioningUpdates \
  archive

if [[ "$ARCHIVE_ONLY" == "1" ]]; then
  echo "==> archived: $ARCHIVE (skipping export)"
  exit 0
fi

mkdir -p "$EXPORT_DIR"
cat > "$EXPORT_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>upload</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
PLIST_EOF

echo "==> uploading to TestFlight"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates

echo "==> done — the build shows up in App Store Connect → TestFlight once Apple finishes processing"
