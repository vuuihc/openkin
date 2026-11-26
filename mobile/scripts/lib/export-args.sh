#!/usr/bin/env bash
# Shared TestFlight export step for scripts/release-ios.sh.
#
# Uploading is the only step that needs an Apple account. By default
# `xcodebuild` borrows the Apple ID the Mac is signed in to in Xcode, and on a
# Mac that is not signed in the export fails with "App Store Connect access for
# team … is required". The alternative is an App Store Connect API key: the
# .p8 from App Store Connect → Users and Access → Integrations → App Store
# Connect API, its key id, and the issuer id from the same page.
#
# The three variables are optional as a set. Setting one or two is a mistake,
# not a fallback: the run stops before `xcodebuild` instead of quietly using
# whatever account happens to be signed in. The key's contents are never
# printed — the upload line shows the mode and, for a key, its path.
#
#   KIN_ASC_KEY_PATH    path to AuthKey_<key-id>.p8
#   KIN_ASC_KEY_ID      the key's 10-character id
#   KIN_ASC_ISSUER_ID   the App Store Connect issuer id
#
# Usage from the sourcing script:
#   source scripts/lib/export-args.sh
#   run_ios_export -archivePath … -exportPath … -exportOptionsPlist … \
#     -allowProvisioningUpdates

# Validate the trio and populate what run_ios_export appends. Kept separate so
# a caller can validate before doing other work, and so refusal is testable
# without an xcodebuild anywhere in sight.
kin_export_auth() {
  local key_path="${KIN_ASC_KEY_PATH:-}"
  local key_id="${KIN_ASC_KEY_ID:-}"
  local issuer_id="${KIN_ASC_ISSUER_ID:-}"

  KIN_EXPORT_AUTH_MODE=xcode
  KIN_EXPORT_AUTH_ARGS=()

  if [ -z "$key_path" ] && [ -z "$key_id" ] && [ -z "$issuer_id" ]; then
    return 0
  fi

  local missing=""
  [ -n "$key_path" ] || missing="$missing KIN_ASC_KEY_PATH"
  [ -n "$key_id" ] || missing="$missing KIN_ASC_KEY_ID"
  [ -n "$issuer_id" ] || missing="$missing KIN_ASC_ISSUER_ID"
  if [ -n "$missing" ]; then
    echo "error: App Store Connect API key is incomplete — set all of KIN_ASC_KEY_PATH, KIN_ASC_KEY_ID and KIN_ASC_ISSUER_ID, or none of them (missing:$missing)" >&2
    return 1
  fi

  # Validate the path at the boundary: xcodebuild's own message for a bad
  # -authenticationKeyPath is a signing error several minutes into the export.
  if [ ! -f "$key_path" ] || [ ! -r "$key_path" ]; then
    echo "error: KIN_ASC_KEY_PATH=$key_path is not a readable file — point it at the AuthKey_<key-id>.p8 downloaded from App Store Connect" >&2
    return 1
  fi

  KIN_EXPORT_AUTH_MODE=key
  KIN_EXPORT_AUTH_ARGS=(
    -authenticationKeyPath "$key_path"
    -authenticationKeyID "$key_id"
    -authenticationKeyIssuerID "$issuer_id"
  )
}

# Export the archive to App Store Connect and upload it. Any arguments are
# passed through to `xcodebuild -exportArchive` unchanged, so the no-key argv
# stays what it always was.
run_ios_export() {
  kin_export_auth || return 1

  if [ "$KIN_EXPORT_AUTH_MODE" = "key" ]; then
    echo "==> uploading to TestFlight (App Store Connect API key: $KIN_ASC_KEY_PATH)"
  else
    echo "==> uploading to TestFlight (Xcode account)"
  fi

  # ${arr[@]+...} keeps an empty array from tripping `set -u` on macOS bash 3.2.
  xcodebuild -exportArchive "$@" "${KIN_EXPORT_AUTH_ARGS[@]+"${KIN_EXPORT_AUTH_ARGS[@]}"}"
}
