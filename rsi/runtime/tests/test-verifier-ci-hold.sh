#!/bin/bash
# test-verifier-ci-hold.sh — the per-PR verifier must not re-gate a PR whose gate and review are
# already cached for its current head while CI is still running on that head. Step 1 merges
# origin/main into the branch on every verifier start, which moves the head, cancels the in-flight
# CI run and forces a fresh gate; on a busy main the wait never converges (one PR paid four full
# gates and took 90 minutes to merge). A pending CI may hold the sync for at most
# CI_HOLD_MAX_SECS; every other state syncs exactly as before, so a permanently pending CI can
# never freeze a PR away from main.
#
# Hermetic: one temp git repo, RSI_CTRL redirected into the temp dir, the non-waiting CI read
# passed in as a literal. No network, no gh, no npm, no python beyond the stdlib.
#
# Exercises merge.sh --ci-first-check, which runs the same ci_first_decision() step 1 calls.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
R=""; RC=0; OUT=""; V=""; RV=""; MARK=""
ONLY="${RSI_TEST_ONLY:-}"
# A PAUSE flag covers the red run on an unmodified merge.sh: without the seam, the dispatcher body
# runs, and PAUSE is the first thing it honours — so no gh, fetch or dispatch happens either way.
mkdir -p "$T/ctrl/rsi/state"; : > "$T/ctrl/rsi/state/PAUSE"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# new_repo — a base tree, `main` committed with origin/main pointing at it, checked out on `feat`
# with one PR commit and origin/feat naming the same head (nothing local unpushed).
new_repo() {
  R="$T/repo"; rm -rf "$R"; mkdir -p "$R"
  g init -q -b main || fail "git init"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  mkdir -p "$R/rsi/runtime" "$R/docs/product" "$R/state/merge"
  printf 'top\nmiddle\nbottom\n' > "$R/rsi/runtime/release.sh"
  printf 'taste\n' > "$R/docs/product/TASTE.md"
  g add -A >/dev/null && g commit -q -m base || fail "base commit"
  g update-ref refs/remotes/origin/main HEAD
  g checkout -q -b feat
  printf 'pr\nmiddle\nbottom\n' > "$R/rsi/runtime/release.sh"
  g add -A >/dev/null && g commit -q -m "pr" || fail "pr commit"
  g update-ref refs/remotes/origin/feat HEAD
}

# diff_hash — the review key the merge lane computes for the PR's own diff (step 4's DH).
diff_hash() { g diff origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | shasum | cut -c1-16; }

# write_cache — the state a previous verified cycle leaves: a gate PASS for HEAD and a PASS review
# keyed by the PR's diff. Sets V and RV, the files the seam is given.
write_cache() {
  V="$R/state/merge/t.verified"; RV="$R/state/merge/t.reviewed"
  echo "$(g rev-parse HEAD) PASS reviewer" > "$V"
  echo "$(diff_hash) PASS $(g rev-parse HEAD) reviewer" > "$RV"
}

# decide <ci-state> [keep] — call the step-1 seam with a fresh marker path (keep = leave an
# existing marker in place). Sets RC and OUT.
decide() {
  MARK="$R/state/merge/t.ci-hold"; [ "${2:-}" = keep ] || rm -f "$MARK"
  RSI_CTRL="$T/ctrl" bash "$MERGE" --ci-first-check "$R" feat "$V" "$RV" "${1:-}" "$MARK" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
}

expect_hold() { # <case>
  [ "$RC" -eq 0 ] || fail "$1: synced, expected HOLD ($OUT)"
  case "$OUT" in HOLD*) ;; *) fail "$1: output is '$OUT', want a HOLD line" ;; esac
}

expect_sync() { # <case> <reason substring>
  [ "$RC" -eq 1 ] || fail "$1: held (rc=$RC), expected SYNC ($OUT)"
  case "$OUT" in SYNC*) ;; *) fail "$1: output is '$OUT', want a SYNC line" ;; esac
  case "$OUT" in *"$2"*) ;; *) fail "$1: reason '$OUT' does not name '$2'" ;; esac
}

# --- cases -------------------------------------------------------------------------------------

# The motivating case: gate PASS for H, review PASS for DH, HEAD == origin/BR, CI pending, no
# marker. The sync is deferred and the marker records the first hold so the window can age out.
test_hold_when_cached_and_ci_pending() {
  new_repo; write_cache
  BEFORE="$(date +%s)"; decide pending; expect_hold t1
  [ -s "$MARK" ] || fail "t1: no hold marker written"
  AT="$(cat "$MARK")"
  [ "$AT" -ge "$BEFORE" ] && [ "$AT" -le "$(date +%s)" ] \
    || fail "t1: marker '$AT' is not the current epoch"
  # A second cycle inside the window holds again and leaves the first deadline alone.
  decide pending keep; expect_hold t1b
  [ "$(cat "$MARK")" = "$AT" ] \
    || fail "t1b: the marker was rewritten ($AT -> $(cat "$MARK")); the hold clock restarted"
}

test_sync_when_gate_missing() {
  new_repo; write_cache; rm -f "$V"
  decide pending; expect_sync t2 gate
}

test_sync_when_gate_for_other_head() {
  new_repo; write_cache
  echo "$(g rev-parse HEAD~1) PASS reviewer" > "$V"
  decide pending; expect_sync t3 gate
}

test_sync_when_review_diff_changed() {
  new_repo; write_cache
  echo "0000000000000000 PASS $(g rev-parse HEAD) reviewer" > "$RV"
  decide pending; expect_sync t4 review
}

test_sync_when_local_head_unpushed() {
  new_repo; write_cache
  g update-ref refs/remotes/origin/feat HEAD~1
  decide pending; expect_sync t5 "not origin/feat"
}

# A green CI needs the sync: the land loop merges main under the land lock and lets
# carry_forward decide carry vs fresh gate.
test_sync_when_ci_green() {
  new_repo; write_cache
  decide green; expect_sync t6 "CI is green"
}

# Fail open: an unreadable or empty CI probe never holds.
test_sync_when_ci_state_unknown() {
  new_repo; write_cache
  decide ""; expect_sync t7 unknown
}

# Anti-starvation: after CI_HOLD_MAX_SECS the next cycle syncs and re-gates as before.
test_hold_expires() {
  new_repo; write_cache
  MARK="$R/state/merge/t.ci-hold"; echo $(( $(date +%s) - 2701 )) > "$MARK"
  decide pending keep; expect_sync t8 expired
}

# The seam must be the same function the verifier calls: one definition, called from step 1
# BEFORE sync_main, and called again by the --ci-first-check seam.
test_wiring_one_call_site() {
  local defs calls hold_at sync_at region
  defs="$(grep -cE '^ci_first_decision\(\)' "$MERGE")"
  [ "$defs" -eq 1 ] || fail "wiring: $defs ci_first_decision definitions in merge.sh, want 1"
  calls="$(grep -cE 'ci_first_decision "' "$MERGE")"
  [ "$calls" -eq 2 ] || fail "wiring: $calls ci_first_decision call sites, want 2 (step 1 + the seam)"
  region="$(sed -n '/^# 1\. sync main/,/^# 2\. hold rules/p' "$MERGE")"
  grep -q 'ci_first_decision' <<<"$region" || fail "wiring: step 1 does not call ci_first_decision"
  hold_at="$(grep -nF 'ci_first_decision "$WT"' "$MERGE" | head -1 | cut -d: -f1)"
  sync_at="$(grep -nF 'sync_main; rc=$?' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$hold_at" ] && [ -n "$sync_at" ] && [ "$hold_at" -lt "$sync_at" ] \
    || fail "wiring: the step-1 decision ($hold_at) does not precede sync_main ($sync_at)"
  sed -n '/--ci-first-check/,/^  fi$/p' "$MERGE" | grep -q 'ci_first_decision' \
    || fail "wiring: the --ci-first-check seam does not run ci_first_decision"
}

# A missing or partial argument list is a usage error, never a fall-through into the dispatcher.
test_seam_usage() {
  RSI_CTRL="$T/ctrl" bash "$MERGE" --ci-first-check > "$T/usage" 2>&1
  RC=$?
  [ "$RC" -ne 0 ] || fail "usage: the seam without arguments exited 0"
  grep -q 'usage: merge.sh --ci-first-check' "$T/usage" \
    || fail "usage: no usage line ($(tr '\n' ' ' < "$T/usage"))"
  RSI_CTRL="$T/ctrl" bash "$MERGE" --ci-first-check "$T/repo" feat > "$T/usage" 2>&1
  [ $? -ne 0 ] || fail "usage: a short argument list exited 0"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$1" || exit 1
  pass "$1"
}

run test_hold_when_cached_and_ci_pending
run test_sync_when_gate_missing
run test_sync_when_gate_for_other_head
run test_sync_when_review_diff_changed
run test_sync_when_local_head_unpushed
run test_sync_when_ci_green
run test_sync_when_ci_state_unknown
run test_hold_expires
run test_wiring_one_call_site
run test_seam_usage
echo ALL-PASS
