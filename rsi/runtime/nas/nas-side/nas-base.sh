#!/bin/bash
# nas-base.sh <bare-repo> <job-dir> — apply the Mac-shipped origin/main bundle, print the base ref.
#
# pulse-nas.sh creates the bundle with `git bundle create <file> origin/main`, so its head ref is
# refs/remotes/origin/main; a bundle from an older producer names refs/heads/main. The NAS bare repo
# lives across jobs and keeps a refs/remotes/origin/main of its own that nothing in the shipped flow
# refreshes, so picking that ref without applying the bundle builds the worker's tree on an
# arbitrarily old main — and the PR it becomes is then measured against a main it never saw.
# The shipped bundle is the only source: it is force-applied by every main-ish head ref it carries,
# and the ref the bundle named is what we print. The pick is verified against the bundle head, so a
# refspec that silently applied nothing fails instead of falling back to the stale ref. With no
# usable bundle the base is the repo's refs/heads/main — never an origin/main it happened to keep.
set -u
REPO="${1:?bare repo}"; J="${2:?job dir}"
BUNDLE="$J/origin-main.bundle"
gb() { git --git-dir="$REPO" "$@"; }

if [ -f "$BUNDLE" ] && gb bundle verify "$BUNDLE" >/dev/null 2>&1; then
  HEADS="$(gb bundle list-heads "$BUNDLE" 2>/dev/null | awk '{print $2}')"
  BASE=""
  case $'\n'"$HEADS"$'\n' in
    *$'\n'refs/remotes/origin/main$'\n'*) BASE=refs/remotes/origin/main;;
    *$'\n'refs/heads/main$'\n'*) BASE=refs/heads/main;;
  esac
  if [ -n "$BASE" ]; then
    WANT="$(gb bundle list-heads "$BUNDLE" | awk -v r="$BASE" '$2==r{print $1; exit}')"
    SPECS=()
    case "$HEADS" in *refs/remotes/origin/main*) SPECS+=('+refs/remotes/origin/main:refs/remotes/origin/main');; esac
    case "$HEADS" in *refs/heads/main*) SPECS+=('+refs/heads/main:refs/heads/main');; esac
    SPECS+=('+refs/heads/*:refs/heads/*')
    if ! gb fetch -q --no-tags "$BUNDLE" "${SPECS[@]}" >/dev/null 2>&1 \
       || [ "$(gb rev-parse -q --verify "$BASE^{commit}" 2>/dev/null)" != "$WANT" ]; then
      echo "nas-base: could not apply $BUNDLE as $BASE" >&2
      exit 1
    fi
    echo "$BASE"
    exit 0
  fi
fi

gb rev-parse -q --verify refs/heads/main^{commit} >/dev/null 2>&1 \
  || { echo "nas-base: no main in $REPO" >&2; exit 1; }
echo refs/heads/main
