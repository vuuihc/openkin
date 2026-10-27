#!/usr/bin/env bash
# Build the iOS app against a Hub.
#
# Usage: KIN_HUB_URL=https://kin.example.com scripts/build-ios.sh [device|simulator]
#
# The console is a build artifact of ../ui, so it is built first; the app loads
# the Hub's own copy of it at runtime, but the shell still ships one so that a
# Hub that cannot be reached shows the console's connection screen.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${KIN_HUB_URL:?set KIN_HUB_URL to the origin your Hub is served at, e.g. https://kin.example.com}"

DESTINATION="${1:-simulator}"
DERIVED="$PWD/ios/DerivedData"
PACKAGES="$DERIVED/SourcePackages"
CACHE="$DERIVED/PackageCache"

(cd ../ui && npm run build)
npm run --silent sync

# Xcode resolves the Capacitor Swift package over git. On a machine where git
# cannot reach github.com directly (a proxy, a wrapper, no credentials for the
# first fetch) that clone fails and the error mentions a cache directory that
# does not exist. Seeding the mirror by hand is what gets past it.
MIRROR="$CACHE/repositories/capacitor-swift-pm-c864e9bc"
if [ ! -d "$MIRROR" ]; then
  echo "seeding the Swift package cache with capacitor-swift-pm"
  mkdir -p "$CACHE/repositories"
  git clone --quiet --mirror https://github.com/ionic-team/capacitor-swift-pm.git "$MIRROR"
fi

# Two flags, both about resolving Capacitor's Swift package without a human:
#
#   -scmProvider system
#     Xcode 26's own SCM provider can stop at "Resolve Package Graph" /
#     "Checking out 8.5.3" and never return — no error, no timeout, no child
#     process — when git is wrapped by a credential helper or a proxy.
#
#   -packageAuthorizationProvider netrc (Xcode 16 and later)
#     Without a named credential store, resolution goes through the keychain,
#     and a non-interactive shell can never answer the authorization prompt:
#     the same silent wait. `netrc` only changes where credentials come from —
#     it never prompts. The mirror seeding above is what serves a machine that
#     cannot reach GitHub at all. With no ~/.netrc the public
#     capacitor-swift-pm still resolves anonymously; a private dependency
#     would need an entry there.
#
# Both belong to the same class as the mirror seeding above: package
# resolution that assumes someone is sitting at the machine.
if [ "$DESTINATION" = "device" ]; then
  xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -allowProvisioningUpdates \
    -derivedDataPath "$DERIVED" \
    -clonedSourcePackagesDirPath "$PACKAGES" -packageCachePath "$CACHE" \
    -scmProvider system \
    -packageAuthorizationProvider netrc build
else
  xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
    -sdk iphonesimulator \
    -derivedDataPath "$DERIVED" \
    -clonedSourcePackagesDirPath "$PACKAGES" -packageCachePath "$CACHE" \
    -scmProvider system \
    -packageAuthorizationProvider netrc build
fi
