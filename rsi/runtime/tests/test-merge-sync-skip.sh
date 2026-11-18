#!/bin/bash
# test-merge-sync-skip.sh — a verifier start must not merge origin/main into a verified PR branch
# when main's new commits touch no path that PR's gate and CI verify. Step 1 merges main on EVERY
# verifier start; with a green CI and both caches valid that merge moves the head, cancels the
# green run and buys a fresh CI on a head whose only new commit is a main merge (measured:
# 166 verifier starts for 65 merges). The skip reuses carry_forward's one disjoint predicate
# through main_move_verdict; every unknown path, missing cache or non-green CI still syncs, and
# the hold expires after CI_HOLD_MAX_SECS so no PR is ever held away from main for longer.
#
# Hermetic: one temp git repo, RSI_CTRL redirected into the temp dir, CI state and both path lists
# passed in as literals. No network, no gh, no npm, no python beyond the stdlib.
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
# A PAUSE flag covers the red run on an unmodified merge.sh: without the new lists the seam still
# exists there, but if a future edit made it fall through, PAUSE is the first thing the dispatcher
# honours — so no gh, fetch or dispatch happens either way.
mkdir -p "$T/ctrl/rsi/state"; : > "$T/ctrl/rsi/state/PAUSE"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# new_repo — a base tree, `main` committed with origin/main pointing at it, checked out on `feat`
# with one PR commit (the PR's own Go file) and origin/feat naming the same head.
new_repo() {
  R="$T/repo"; rm -rf "$R"; mkdir -p "$R"
  g init -q -b main || fail "git init"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  mkdir -p "$R/internal/thing" "$R/docs" "$R/scripts" "$R/state/merge"
  printf 'top\nmiddle\nbottom\n' > "$R/internal/thing/thing.go"
  printf 'top\nmiddle\nbottom\n' > "$R/internal/thing/helper.go"
  printf 'top\nmiddle\nbottom\n' > "$R/docs/note.md"
  printf 'top\nmiddle\nbottom\n' > "$R/scripts/check.sh"
  g add -A >/dev/null && g commit -q -m base || fail "base commit"
  g update-ref refs/remotes/origin/main HEAD
  g checkout -q -b feat
  printf 'pr\nmiddle\nbottom\n' > "$R/internal/thing/thing.go"
  g add -A >/dev/null && g commit -q -m "pr" || fail "pr commit"
  g update-ref refs/remotes/origin/feat HEAD
}

PR_CHANGED='internal/thing/thing.go'
DOCS_MOVE='docs/note.md'
OWN_FILE_MOVE='internal/thing/thing.go'
SAME_PKG_MOVE='internal/thing/helper.go'
SHARED_MOVE='scripts/check.sh'

# diff_hash — the review key the merge lane computes for the PR's own diff (step 4's DH).
diff_hash() { g diff origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | shasum | cut -c1-16; }

# write_cache — the state a previous verified cycle leaves: a gate PASS for HEAD and a PASS review
# keyed by the PR's diff. Sets V and RV, the files the seam is given.
write_cache() {
  V="$R/state/merge/t.verified"; RV="$R/state/merge/t.reviewed"
  echo "$(g rev-parse HEAD) PASS reviewer" > "$V"
  echo "$(diff_hash) PASS $(g rev-parse HEAD) reviewer" > "$RV"
}

# decide <ci-state> <incoming-paths> <pr-changed-paths> [keep] — call the step-1 seam with a fresh
# marker path (keep = leave an existing marker in place). An empty list is written as a blank line,
# which the seam reads back as an empty list. Sets RC and OUT.
decide() {
  MARK="$R/state/merge/t.ci-hold"; [ "${4:-}" = keep ] || rm -f "$MARK"
  printf '%s\n' "$2" > "$T/incoming"
  printf '%s\n' "$3" > "$T/changed"
  RSI_CTRL="$T/ctrl" bash "$MERGE" --ci-first-check "$R" feat "$V" "$RV" "${1:-}" "$MARK" \
    "$T/incoming" "$T/changed" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
}

expect_hold() { # <case> <reason substring>
  [ "$RC" -eq 0 ] || fail "$1: synced, expected HOLD ($OUT)"
  case "$OUT" in HOLD*) ;; *) fail "$1: output is '$OUT', want a HOLD line" ;; esac
  case "$OUT" in *"$2"*) ;; *) fail "$1: reason '$OUT' does not name '$2'" ;; esac
}

expect_sync() { # <case> <reason substring>
  [ "$RC" -eq 1 ] || fail "$1: held (rc=$RC), expected SYNC ($OUT)"
  case "$OUT" in SYNC*) ;; *) fail "$1: output is '$OUT', want a SYNC line" ;; esac
  case "$OUT" in *"$2"*) ;; *) fail "$1: reason '$OUT' does not name '$2'" ;; esac
}

# --- cases -------------------------------------------------------------------------------------

# The motivating case: gate PASS for HEAD, review PASS for DH, HEAD == origin/feat, CI green, and
# main advanced only docs/. The sync is skipped, the worktree head does not move and nothing is
# pushed. The same 45-minute marker the pending-CI hold uses records the first hold.
test_pass_disjoint_move_holds() {
  new_repo; write_cache
  BEFORE_HEAD="$(g rev-parse HEAD)"; BEFORE_REMOTE="$(g rev-parse origin/feat)"
  BEFORE="$(date +%s)"
  decide green "$DOCS_MOVE" "$PR_CHANGED"
  expect_hold pass_disjoint_move_holds "touch no path this PR verifies"
  case "$OUT" in *CARRY*) ;; *) fail "pass_disjoint_move_holds: reason '$OUT' does not name the classifier verdict" ;; esac
  [ "$(g rev-parse HEAD)" = "$BEFORE_HEAD" ] || fail "pass_disjoint_move_holds: the held decision moved HEAD"
  [ "$(g rev-parse origin/feat)" = "$BEFORE_REMOTE" ] || fail "pass_disjoint_move_holds: the held decision pushed"
  [ -s "$MARK" ] || fail "pass_disjoint_move_holds: no hold marker written"
  AT="$(cat "$MARK")"
  [ "$AT" -ge "$BEFORE" ] && [ "$AT" -le "$(date +%s)" ] \
    || fail "pass_disjoint_move_holds: marker '$AT' is not the current epoch"
  # A second cycle inside the window holds again and leaves the first deadline alone.
  decide green "$DOCS_MOVE" "$PR_CHANGED" keep
  expect_hold pass_disjoint_move_holds "touch no path this PR verifies"
  [ "$(cat "$MARK")" = "$AT" ] \
    || fail "pass_disjoint_move_holds: the marker was rewritten ($AT -> $(cat "$MARK")); the hold clock restarted"
}

# Main moving the PR's own file changes what the gate checked: sync and re-gate.
test_pass_own_file_move_syncs() {
  new_repo; write_cache
  decide green "$OWN_FILE_MOVE" "$PR_CHANGED"
  expect_sync pass_own_file_move_syncs "CI is green"
}

# A sibling file in the PR's Go package can change the package's behaviour: sync and re-gate.
test_pass_same_package_move_syncs() {
  new_repo; write_cache
  decide green "$SAME_PKG_MOVE" "$PR_CHANGED"
  expect_sync pass_same_package_move_syncs "CI is green"
}

# The gate and the loop run scripts/; a move there can change what verification means.
test_pass_shared_surface_move_syncs() {
  new_repo; write_cache
  decide green "$SHARED_MOVE" "$PR_CHANGED"
  expect_sync pass_shared_surface_move_syncs "CI is green"
}

# A gate that names another head proves nothing about this one, however disjoint main is.
test_pass_no_gate_cache_syncs() {
  new_repo; write_cache
  echo "$(g rev-parse HEAD~1) PASS reviewer" > "$V"
  decide green "$DOCS_MOVE" "$PR_CHANGED"
  expect_sync pass_no_gate_cache_syncs gate
}

# Fail open: missing or empty path lists, an unreadable HEAD and a missing list file all sync.
test_pass_unknown_inputs_fail_open() {
  new_repo; write_cache
  decide green "" "$PR_CHANGED"
  expect_sync pass_unknown_inputs_fail_open "CI is green"
  decide green "$DOCS_MOVE" ""
  expect_sync pass_unknown_inputs_fail_open "CI is green"
  MARK="$R/state/merge/t.ci-hold"; rm -f "$MARK"
  RSI_CTRL="$T/ctrl" bash "$MERGE" --ci-first-check "$R" feat "$V" "$RV" green "$MARK" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
  expect_sync pass_unknown_inputs_fail_open "CI is green"
  RSI_CTRL="$T/ctrl" bash "$MERGE" --ci-first-check "$T/no-such-repo" feat "$V" "$RV" green "$MARK" \
    "$T/incoming" "$T/changed" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
  expect_sync pass_unknown_inputs_fail_open "cannot read HEAD"
  RSI_CTRL="$T/ctrl" bash "$MERGE" --ci-first-check "$R" feat "$V" "$RV" green "$MARK" \
    "$T/no-such-list" "$T/changed" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
  expect_sync pass_unknown_inputs_fail_open "CI is green"
}

# Regression: pending CI keeps today's hold, with today's reason, lists or no lists.
test_pass_ci_pending_still_holds() {
  new_repo; write_cache
  decide pending "$DOCS_MOVE" "$PR_CHANGED"
  expect_hold pass_ci_pending_still_holds "CI pending on"
  decide pending "$OWN_FILE_MOVE" "$PR_CHANGED"
  expect_hold pass_ci_pending_still_holds "CI pending on"
}

# Anti-starvation: the disjoint hold shares CI_HOLD_MAX_SECS, so an old marker syncs.
test_pass_disjoint_hold_expires() {
  new_repo; write_cache
  MARK="$R/state/merge/t.ci-hold"; echo $(( $(date +%s) - 2701 )) > "$MARK"
  decide green "$DOCS_MOVE" "$PR_CHANGED" keep
  expect_sync pass_disjoint_hold_expires expired
}

# Fail open: a failing CI belongs to the sendback path, never to a hold.
test_pass_ci_fail_syncs() {
  new_repo; write_cache
  decide fail "$DOCS_MOVE" "$PR_CHANGED"
  expect_sync pass_ci_fail_syncs "CI is fail"
}

# The seam must be the same function the verifier calls, with the same classifier: one
# main_move_verdict definition, carry_forward and the step-1 decision both call it, the step-1
# call passes both lists, and the decision makes the additive measurement line.
test_wiring_shares_classifier_and_logs_decision() {
  local defs region line qin_at ch_at decision_at log_at
  defs="$(grep -cE '^main_move_verdict\(\)' "$MERGE")"
  [ "$defs" -eq 1 ] || fail "wiring: $defs main_move_verdict definitions in merge.sh, want 1"
  sed -n '/^carry_forward()/,/^}/p' "$MERGE" | grep -q 'main_move_verdict' \
    || fail "wiring: carry_forward does not use the shared classifier"
  region="$(sed -n '/^# 1\. sync main/,/^# 2\. hold rules/p' "$MERGE")"
  line="$(grep -F 'ci_first_decision "$WT"' <<<"$region" | head -1)"
  [ -n "$line" ] || fail "wiring: step 1 does not call ci_first_decision"
  case "$line" in *'"$QUEUE_INCOMING"'*) ;; *) fail "wiring: the step-1 call does not pass the incoming paths ($line)" ;; esac
  case "$line" in *'"$CH"'*) ;; *) fail "wiring: the step-1 call does not pass the PR's changed paths ($line)" ;; esac
  qin_at="$(grep -nF 'QUEUE_INCOMING="$(' <<<"$region" | head -1 | cut -d: -f1)"
  ch_at="$(grep -nF 'CH="$(' <<<"$region" | head -1 | cut -d: -f1)"
  decision_at="$(grep -nF 'ci_first_decision "$WT"' <<<"$region" | head -1 | cut -d: -f1)"
  [ -n "$qin_at" ] && [ -n "$ch_at" ] && [ -n "$decision_at" ] || fail "wiring: cannot locate the lists or the decision in step 1"
  [ "$qin_at" -lt "$decision_at" ] && [ "$ch_at" -lt "$decision_at" ] \
    || fail "wiring: the path lists ($qin_at/$ch_at) are not computed before the decision ($decision_at)"
  log_at="$(grep -nF 'sync_decision=$CI_FIRST_KIND' <<<"$region" | head -1 | cut -d: -f1)"
  [ -n "$log_at" ] && [ "$log_at" -gt "$decision_at" ] \
    || fail "wiring: no sync_decision log line after the decision"
  grep -qF 'CI_FIRST_KIND="hold-disjoint"' "$MERGE" \
    || fail "wiring: the disjoint hold sets no hold-disjoint kind for the log line"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$1" || exit 1
  pass "$1"
}

run test_pass_disjoint_move_holds
run test_pass_own_file_move_syncs
run test_pass_same_package_move_syncs
run test_pass_shared_surface_move_syncs
run test_pass_no_gate_cache_syncs
run test_pass_unknown_inputs_fail_open
run test_pass_ci_pending_still_holds
run test_pass_disjoint_hold_expires
run test_pass_ci_fail_syncs
run test_wiring_shares_classifier_and_logs_decision
echo ALL-PASS
