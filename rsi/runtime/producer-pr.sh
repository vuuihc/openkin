#!/bin/bash
# shellcheck shell=bash
# producer-pr.sh — open a PR from outside a worker lane, through the merge gate's own claim rule.
#
# Measured 2026-11-27: the nightly DREAM consolidation (#828) and a CEO docs PR (#819) reached
# `gh pr create` with no lane record, so a prose body with no column-0 `Claim check:` line was
# caught only after the merge lane had paid for a full gate and an independent review (rework
# 20:35 → 20:51). The lane has run this rule before its push since #833; this is the producer's
# half. A body the merge gate would reject is refused here, before the PR exists, so the producer
# fixes the body instead of burning a rework round.
#
# Sourceable; no top-level side effects. As a CLI:
#   bash rsi/runtime/producer-pr.sh <worktree> <body-file> <repo> <base> <head> <title>
# On a passing verdict it prints exactly one line on stdout, `PRODUCER_PR_OK: <url>`; on a refusal
# it prints `PRODUCER_PR_REFUSED: <verdict>` and returns 1 before any gh call. Diagnostics (the
# seam's verdict on a pass, gh's retry notes) go to stderr, like lane-pr.sh.

# producer_body_snapshot <body-file> <snapshot-file> — 0 on success, including an empty body.
# Ported from lane.sh's claim_body_snapshot(), without editing lane.sh (another lane owns that
# file this round): one atomic copy under umask 077, so the seam and the upload read the same
# private bytes and a write to the source during the seam has nowhere to land.
producer_body_snapshot() {
  local tmp="$2.tmp.$$"
  (umask 077 && { [ ! -s "$1" ] || cat "$1"; } > "$tmp") 2>/dev/null \
    || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$2" 2>/dev/null || { rm -f "$tmp"; return 1; }
}

producer_pr() { # <worktree> <body-file> <repo> <base> <head> <title>
  local wt="$1" body="$2" repo="$3" base="$4" head="$5" title="$6"
  local dir tmpdir snap out rc verdict url line
  # Honour the loop's RSI_GH test override the way common.sh does; lane-pr.sh reads GH.
  local GH="${GH:-${RSI_GH:-}}"
  # The seam and the retry helper live beside this file, so a copied producer in a test carries
  # the stubs it was copied with. Missing either one is a refusal, never a silent pass.
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || dir=""
  if [ -z "$dir" ] || [ ! -f "$dir/lane.sh" ]; then
    printf 'PRODUCER_PR_REFUSED: the claim seam is missing (%s/lane.sh)\n' "${dir:-unknown}"
    return 1
  fi

  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/producer-pr.XXXXXX")" 2>/dev/null \
    || { echo 'PRODUCER_PR_REFUSED: cannot create a private temp directory'; return 1; }
  snap="$tmpdir/body.md"
  if ! producer_body_snapshot "$body" "$snap"; then
    rm -rf "$tmpdir"
    echo 'PRODUCER_PR_REFUSED: cannot snapshot the PR body'
    return 1
  fi

  # The merge gate's rule, before the PR exists. Never reimplement it here: lane.sh's
  # --claim-check-check wraps claim_check.py and the changed-file list merge.sh computes. Capture
  # stdout and stderr because the verdict is on stdout and a broken invocation may explain itself
  # on stderr. A seam that cannot run, prints no verdict, exits non-zero or answers anything but a
  # passing verdict is a refusal: a missing checker is never a pass.
  out="$(bash "$dir/lane.sh" --claim-check-check "$wt" "$snap" 2>&1)" && rc=0 || rc=$?
  verdict=""
  while IFS= read -r line; do
    case "$line" in
      CLAIM_LANE_*) verdict="$line"; break ;;
    esac
  done <<< "$out"
  if [ "$rc" -ne 0 ] || [ -z "$verdict" ]; then
    rm -rf "$tmpdir"
    printf 'PRODUCER_PR_REFUSED: %s\n' "${verdict:-${out:-the claim seam gave no verdict (exit $rc)}}"
    return 1
  fi
  case "$verdict" in
    CLAIM_LANE_OK:*|CLAIM_LANE_NA:*|CLAIM_LANE_WAIVED:*) ;;
    *)
      rm -rf "$tmpdir"
      printf 'PRODUCER_PR_REFUSED: %s\n' "$verdict"
      return 1
      ;;
  esac
  printf 'PRODUCER_PR_SEAM: %s\n' "$verdict" >&2

  # lane-pr.sh's gh_pr_create, never a copy: it looks before it creates, so a transient GitHub
  # failure cannot duplicate the PR. The upload is the private snapshot, never the producer's
  # mutable source: bytes written during the seam must not reach GitHub.
  if ! . "$dir/lane-pr.sh" 2>/dev/null || ! command -v gh_pr_create >/dev/null 2>&1; then
    rm -rf "$tmpdir"
    echo 'PRODUCER_PR_FAILED: lane-pr.sh (gh_pr_create) is not available'
    return 1
  fi
  url="$(gh_pr_create "$repo" "$base" "$head" "$title" "$snap")" && rc=0 || rc=$?
  rm -rf "$tmpdir"
  if [ "$rc" -ne 0 ] || [ -z "$url" ]; then
    printf 'PRODUCER_PR_FAILED: gh pr create returned no URL (exit %s)\n' "$rc"
    return 1
  fi
  printf 'PRODUCER_PR_OK: %s\n' "$url"
}

# The CLI entry point, guarded so sourcing this file defines producer_pr() and nothing else.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -ne 6 ]; then
    echo 'usage: producer-pr.sh <worktree> <body-file> <repo> <base> <head> <title>' >&2
    exit 2
  fi
  producer_pr "$@"
  exit $?
fi
