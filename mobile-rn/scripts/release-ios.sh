#!/usr/bin/env bash
# Archive the RN (Expo) app and hand the build to TestFlight.
#
# Usage:
#   [KIN_BUILD_NUMBER=…] [KIN_MARKETING_VERSION=1.0] [KIN_TEAM_ID=…] \
#   [KIN_ASC_KEY_PATH=… KIN_ASC_KEY_ID=… KIN_ASC_ISSUER_ID=…] \
#     scripts/release-ios.sh [--archive-only]
#
# This is the TestFlight build now (R-rn-testflight): same bundle id, team and
# version defaults as the Capacitor shell in ../mobile, which still exists but
# no longer ships. The generated ios/ project is gitignored and recreated by
# `expo prebuild` on every run, so nothing here needs to be committed.
#
# Signing is automatic against the team in the Capacitor pbxproj — the one
# place the team id is written down. Archiving needs this Mac signed in to that
# Apple ID in Xcode (Settings → Accounts), and so does uploading — unless you
# hand the upload an App Store Connect API key, which needs no signed-in
# account. All three or none:
#
#   KIN_ASC_KEY_PATH=/path/to/AuthKey_ABC123DEFG.p8
#   KIN_ASC_KEY_ID=ABC123DEFG
#   KIN_ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
#
# A partial trio, or a key path that is not a readable file, stops before
# xcodebuild rather than falling back to the signed-in account. The key's
# contents are never printed — the upload line names the mode and the path.
# The first upload for the bundle id also needs the app record to exist in
# App Store Connect, which Xcode cannot create from the command line.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# One implementation of the export auth and argv, shared with the Capacitor
# script. The cutover story deletes the Capacitor mobile/ tree and has to move
# this library then; the release suite resolves this path, so that deletion
# fails loudly instead of shipping an upload that silently falls back to the
# Xcode account.
source "$SCRIPT_DIR/../../mobile/scripts/lib/export-args.sh"

ARCHIVE_ONLY=0
[[ "${1:-}" == "--archive-only" ]] && ARCHIVE_ONLY=1

# A typo'd KIN_ASC_* should cost a second, not the archive below. The upload
# step validates again (the library is also used on its own); --archive-only
# never uploads, so it needs no usable key and ignores the trio.
if [[ "$ARCHIVE_ONLY" != "1" ]]; then
  kin_export_auth || exit 1
fi

# `expo prebuild` rewrites the tracked manifest's "ios"/"android" npm scripts
# (`expo start --ios` → `expo run:ios`), which this flow never runs. Keep the
# branch's package.json exactly as it is, including on a failed prebuild.
PACKAGE_JSON_BACKUP="$(mktemp "${TMPDIR:-/tmp}/kin-package-json.XXXXXX")"
cp package.json "$PACKAGE_JSON_BACKUP"
restore_package_json() {
  if [ -f "$PACKAGE_JSON_BACKUP" ]; then
    cp "$PACKAGE_JSON_BACKUP" package.json
    rm -f "$PACKAGE_JSON_BACKUP"
  fi
}
trap restore_package_json EXIT

# A generated native tree with Pods and an archive is gigabytes of build
# output. If the ignore rule is broken the next `git add -A` commits it, so the
# script refuses to generate it until the rule is back.
if ! git check-ignore -q ios/; then
  echo "error: mobile-rn/ios/ is not gitignored — refusing to create a trackable native tree" >&2
  exit 1
fi

CAPACITOR_PBXPROJ="../mobile/ios/App/App.xcodeproj/project.pbxproj"
TEAM_ID="${KIN_TEAM_ID:-$(sed -n 's/.*DEVELOPMENT_TEAM = \([A-Z0-9]*\);.*/\1/p' "$CAPACITOR_PBXPROJ" | head -1)}"
[[ -n "$TEAM_ID" ]] || {
  echo "error: no DEVELOPMENT_TEAM in $CAPACITOR_PBXPROJ (pass KIN_TEAM_ID)" >&2
  exit 1
}

# Every upload needs a CFBundleVersion nothing has used before, and App Store
# Connect rejects a repeat. A minute-resolution timestamp is monotonic and keeps
# no state on disk; KIN_BUILD_NUMBER overrides it for a hand-made build or a
# re-upload after a rejection. KIN_MARKETING_VERSION matches the Capacitor
# default unless you are shipping a new short version.
BUILD_NUMBER="${KIN_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
MARKETING_VERSION="${KIN_MARKETING_VERSION:-1.0}"

# Keep Xcode's build cache inside the generated tree: the default
# ~/Library/Developer/Xcode/DerivedData is shared by every lane on this Mac,
# and a second run after prebuild regenerated the Pods project can otherwise
# fail on a stale Swift PCM / SDK stat cache. `--clean` deletes it with ios/.
DERIVED="$PWD/ios/DerivedData"
ARCHIVE="$PWD/ios/build/Kin.xcarchive"
EXPORT_DIR="$PWD/ios/build/export"
EXPORT_PLIST="$PWD/ios/build/ExportOptions.plist"

echo "==> version: $MARKETING_VERSION ($BUILD_NUMBER)"
echo "==> team:    $TEAM_ID"

echo "==> generating ios/ from app.json"
rm -rf ios
npx expo prebuild --platform ios --clean --no-install
restore_package_json

# Expo writes CFBundleVersion/CFBundleShortVersionString as literals into the
# generated Info.plist, so the CURRENT_PROJECT_VERSION / MARKETING_VERSION
# build settings below would never reach the bundle and every upload would
# claim build 1. Write this run's values into the plist that is about to be
# archived.
PLIST="$(ls ios/*/Info.plist 2>/dev/null | head -1 || true)"
[[ -n "$PLIST" ]] || {
  echo "error: expo prebuild produced no ios/*/Info.plist" >&2
  exit 1
}
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MARKETING_VERSION" "$PLIST"

(cd ios && pod install)

WORKSPACE="$(ls -d ios/*.xcworkspace 2>/dev/null | head -1 || true)"
[[ -n "$WORKSPACE" ]] || {
  echo "error: expo prebuild produced no ios/*.xcworkspace" >&2
  exit 1
}
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"

rm -rf "$ARCHIVE"
echo "==> archiving $SCHEME"
xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  MARKETING_VERSION="$MARKETING_VERSION" \
  -allowProvisioningUpdates \
  archive

APP="$(find "$ARCHIVE/Products/Applications" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
[[ -n "$APP" ]] || {
  echo "error: no .app inside $ARCHIVE" >&2
  exit 1
}

# A Release build embeds the JS bundle; it does not talk to Metro. A build
# without it launches to a red screen on a phone, which TestFlight would only
# reveal after Apple finished processing.
JSBUNDLE="$APP/main.jsbundle"
[[ -f "$JSBUNDLE" ]] || {
  echo "error: $APP has no main.jsbundle — a Release build must embed its JS" >&2
  exit 1
}

ARCHIVED_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
ARCHIVED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist")"
ARCHIVED_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Info.plist")"
[[ "$ARCHIVED_BUILD" == "$BUILD_NUMBER" && "$ARCHIVED_VERSION" == "$MARKETING_VERSION" ]] || {
  echo "error: archive is $ARCHIVED_VERSION ($ARCHIVED_BUILD), expected $MARKETING_VERSION ($BUILD_NUMBER)" >&2
  exit 1
}

echo "==> archived: $ARCHIVE"
echo "==> bundle:   $ARCHIVED_BUNDLE_ID $ARCHIVED_VERSION ($ARCHIVED_BUILD)"
echo "==> js:       $JSBUNDLE"

if [[ "$ARCHIVE_ONLY" == "1" ]]; then
  echo "==> skipping export and upload (--archive-only)"
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

# The runner validates the KIN_ASC_* trio, prints the auth mode, and issues
# the only `xcodebuild -exportArchive` in this flow.
run_ios_export \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates

echo "==> done — the build shows up in App Store Connect → TestFlight once Apple finishes processing"
