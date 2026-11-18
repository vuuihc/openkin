# shellcheck shell=bash
# lane-pr.sh — create a lane's PR, surviving a transient GitHub API failure.
#
# 2026-11-18 21:01: one un-retried `gh pr create` answered
# `Post "https://api.github.com/graphql": EOF`; lane.sh recorded failed and threw
# away a finished round (#329 was re-opened by hand the next morning).
#
# The trap in that incident: the PR may exist even though create reported failure.
# A retry that blindly creates again duplicates the PR or dies on "already exists"
# and loses the round again, so every retry looks before it creates.
#
# Sourced by lane.sh and the suite; no top-level side effects.

# gh_pr_create <repo> <base> <head> <title> <body-file>
# Prints only the PR URL on stdout (the caller parses it for the number); every
# diagnostic goes to stderr. Returns 1 after RSI_GH_PR_RETRY_ATTEMPTS total
# attempts (default 3), sleeping RSI_GH_PR_RETRY_SLEEP seconds (default 5) between
# them. Honour 0 as "no sleep".
gh_pr_create() {
  local repo="$1" base="$2" head="$3" title="$4" body="$5"
  local gh="${GH:-}" attempts="${RSI_GH_PR_RETRY_ATTEMPTS:-3}" sleep_s="${RSI_GH_PR_RETRY_SLEEP:-5}"
  local i out n last=""
  [ -n "$gh" ] || gh="$(command -v gh 2>/dev/null || true)"
  if [ -z "$gh" ]; then echo "gh_pr_create: gh not found" >&2; return 1; fi
  case "$attempts" in ''|*[!0-9]*) attempts=3 ;; esac
  [ "$attempts" -ge 1 ] 2>/dev/null || attempts=1
  case "$sleep_s" in ''|*[!0-9]*) sleep_s=5 ;; esac

  for ((i = 1; i <= attempts; i++)); do
    out="$("$gh" pr create --repo "$repo" --base "$base" --head "$head" --title "$title" --body-file "$body" 2>&1 | tail -1)"
    # A success (or "already exists: <url>") carries the number; print the canonical URL.
    n="$(printf '%s\n' "$out" | sed -n 's#.*/pull/\([0-9][0-9]*\).*#\1#p' | head -1)"
    if [ -n "$n" ]; then printf 'https://github.com/%s/pull/%s\n' "$repo" "$n"; return 0; fi
    last="$out"
    # create can fail after GitHub actually created the PR (EOF on the response).
    # Look before creating again, so a retry cannot duplicate or collide.
    n="$("$gh" pr list --repo "$repo" --head "$head" --state open --json number --jq '.[0].number' 2>/dev/null | head -1)"
    case "$n" in ''|*[!0-9]*) n="" ;; esac
    if [ -n "$n" ]; then printf 'https://github.com/%s/pull/%s\n' "$repo" "$n"; return 0; fi
    if [ "$i" -lt "$attempts" ]; then
      printf 'gh_pr_create: attempt %s/%s failed: %s\n' "$i" "$attempts" "$last" >&2
      [ "$sleep_s" -gt 0 ] && sleep "$sleep_s"
    fi
  done
  printf 'gh_pr_create: failed after %s attempt(s): %s\n' "$attempts" "${last:-no output}" >&2
  return 1
}
