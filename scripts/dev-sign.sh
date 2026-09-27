#!/usr/bin/env bash
# Give the locally built daemon a stable code-signing identity.
#
# `go build` emits an ad-hoc, linker-signed binary, so its cdhash changes on
# every rebuild. macOS Keychain ACLs bind "Always Allow" grants to the signing
# identity, so each rebuild invalidates them and the daemon re-prompts for the
# login password when it reads provider secrets or Claude Code credentials.
# Signing with a real identity makes the designated requirement depend on the
# certificate and identifier instead of the cdhash, which survives rebuilds.
#
# The identity is read from KIN_CODESIGN_IDENTITY, else from the gitignored
# .kin-codesign-identity at the repo root:
#
#   security find-identity -v -p codesigning      # list candidates
#   echo 'Apple Development: Your Name (TEAMID)' > .kin-codesign-identity
#
# Auto-detecting an identity is deliberately avoided: one whose private key has
# not been granted to codesign blocks on a Keychain prompt and hangs the build.
#
# Signing is a dev convenience — with no identity configured the binary is left
# ad-hoc signed rather than failing the build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${1:?usage: dev-sign.sh <path-to-kin>}"
IDENTITY_FILE="$ROOT/.kin-codesign-identity"
TIMEOUT_SECS="${KIN_CODESIGN_TIMEOUT:-30}"

[[ "$(uname -s)" == "Darwin" ]] || exit 0
[[ -f "$BIN" ]] || exit 0

IDENTITY="${KIN_CODESIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" && -f "$IDENTITY_FILE" ]]; then
  IDENTITY="$(sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' \
    "$IDENTITY_FILE" | head -1)" || true
fi

if [[ -z "$IDENTITY" ]]; then
  echo "==> codesign skipped: no signing identity configured"
  echo "    Keychain access will be re-prompted after every rebuild."
  echo "    Pick one with: security find-identity -v -p codesigning"
  echo "    Then: echo 'Apple Development: Name (TEAMID)' > .kin-codesign-identity"
  exit 0
fi

# A codesign call against a key without codesign access blocks on a Keychain
# prompt, so cap it rather than hanging the build forever.
codesign_with_timeout() {
  codesign --force --sign "$IDENTITY" --identifier dev.openkin.kin "$BIN" &
  local pid=$!
  local ticks=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( ticks >= TIMEOUT_SECS * 10 )); then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$pid"
}

rc=0
codesign_with_timeout || rc=$?

case "$rc" in
  0)
    echo "==> codesign → $BIN"
    echo "    identity: $IDENTITY"
    ;;
  124)
    echo "==> codesign timed out after ${TIMEOUT_SECS}s; $BIN stays ad-hoc signed" >&2
    echo "    '${IDENTITY}' likely needs a Keychain prompt." >&2
    echo "    Dismiss any dialog for it and choose another identity." >&2
    ;;
  *)
    echo "==> codesign failed (rc=$rc); $BIN stays ad-hoc signed" >&2
    echo "    Check '$IDENTITY' against: security find-identity -v -p codesigning" >&2
    ;;
esac
