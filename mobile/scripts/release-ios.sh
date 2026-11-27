#!/usr/bin/env bash
# Archive the iOS app and hand the build to TestFlight.
#
# Usage:
#   [KIN_HUB_URL=https://kin.example.com] scripts/release-ios.sh [--archive-only]
#
# The Hub origin is runtime state on the phone (G8), so KIN_HUB_URL is
# optional: one universal build serves every deployment. When given, it is the
# origin the app opens first, and it has to stay reachable for as long as that
# matters — a quick-tunnel URL is still the wrong thing to open a build with.
# Without it the app boots on its bundled console and asks for the Hub.
#
# Signing is automatic against the team in the Xcode project. Archiving needs
# the Mac to be signed in to that Apple ID in Xcode (Settings → Accounts), and
# so does uploading — unless you hand the upload an App Store Connect API key,
# which needs no signed-in account. All three or none:
#
#   KIN_ASC_KEY_PATH=/path/to/AuthKey_ABC123DEFG.p8
#   KIN_ASC_KEY_ID=ABC123DEFG
#   KIN_ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
#
# A partial trio, or a key path that is not a readable file, stops before
# xcodebuild rather than falling back to the signed-in account. The first
# upload for a bundle id also needs the app record to exist in App Store
# Connect, which Xcode cannot create for you on the command line.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
source "$SCRIPT_DIR/lib/export-args.sh"

KIN_HUB_URL="${KIN_HUB_URL:-}"
if [ -n "$KIN_HUB_URL" ]; then
  [[ "$KIN_HUB_URL" != *127.0.0.1* && "$KIN_HUB_URL" != *localhost* ]] || {
    echo "error: KIN_HUB_URL is $KIN_HUB_URL — a TestFlight build has to point at a Hub the phone can reach" >&2
    exit 1
  }
fi

ARCHIVE_ONLY=0
[[ "${1:-}" == "--archive-only" ]] && ARCHIVE_ONLY=1

# A typo'd KIN_ASC_* should cost a second, not the archive below. The upload
# step validates again (the library is also used on its own); --archive-only
# never uploads, so it needs no usable key and ignores the trio.
if [[ "$ARCHIVE_ONLY" != "1" ]]; then
  kin_export_auth || exit 1
fi

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

echo "==> hub origin:      ${KIN_HUB_URL:-(none; the phone asks on first run)}"
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
# `-scmProvider system` and `-packageAuthorizationProvider netrc`: see the note
# in build-ios.sh. Without the second one the archive waits on a keychain
# prompt a headless shell cannot answer, and the wait looks identical.
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$DERIVED" \
  -clonedSourcePackagesDirPath "$PACKAGES" -packageCachePath "$CACHE" \
  -scmProvider system \
  -packageAuthorizationProvider netrc \
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

run_ios_export \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates

echo "==> done — the build shows up in App Store Connect → TestFlight once Apple finishes processing"
