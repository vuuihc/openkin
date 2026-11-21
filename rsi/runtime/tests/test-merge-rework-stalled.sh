#!/bin/bash
# test-merge-rework-stalled.sh — a sendback no lane picks up must not be waited on forever.
#
# 2026-11-21: #506's rework lane died with `push failed` at 07:59. The sendback stayed in
# state/sendback/, and the dispatcher's only reaction was to print "waiting for rework" once per
# 600 s cycle, for a PR whose gate, review and CI were all green. It sat OPEN for ~50 minutes
# (cycles.log: open_to_merge=59m) until a person reconciled it by hand. Nothing in the loop
# would have noticed, and nothing escalates today.
#
# The branch runs after the active-lane check, so "no lane holds this slug" is already proven;
# the missing bound was age. merge.sh now prints the age, and once the sendback is older than
# REWORK_STALL_MIN (default 20) writes one `rework_stalled` line to cycles.log plus one
# needs-ceo line per (slug, sendback file): a fresh sendback on the same slug escalates again,
# the same one never repeats. An unreadable age keeps the old wording and never escalates.
#
# Hermetic: temp control tree, fixture `pr list` JSON through the dispatcher's own seam, no gh,
# fetch, gate, model or network; the PR list is the only input and nothing is ever started.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"
MERGE="$RSI/runtime/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
export RSI_CTRL="$T/ctrl"
LSTATE="$T/ctrl/rsi/state"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

reset_ctrl() { # fresh runtime copy + empty state: no case can leak into the next
  rm -rf "$T/ctrl"; mkdir -p "$T/ctrl/rsi"
  cp -R "$RSI/runtime" "$T/ctrl/rsi/runtime"
  mkdir -p "$LSTATE/merge" "$LSTATE/sendback"
  : > "$T/start.log"
}

# One open PR, small-safe and CI green, so the only thing that can hold it is the sendback branch.
pr_json() {
  cat > "$T/pr.json" <<'JSON'
[
 {"number":101,"headRefName":"rsi/p1","isDraft":false,"labels":[],"title":"feat: one","body":"RSI item: R-p1",
  "headRefOid":"aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
  "statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}],
  "files":[{"path":"internal/one/a.go","additions":10,"deletions":0}]}
]
JSON
}

run_dispatch() { # -> $out, $rc
  out="$(RSI_PR_LIST_CMD="cat $T/pr.json" RSI_START_LOG="$T/start.log" RSI_PR_STATE_CMD='echo OPEN' \
    bash "$MERGE" 2>&1)"; rc=$?
}

# sendback <minutes-ago> [slug] — write the rework note and backdate it, first or second epoch.
sendback() {
  local ago="$1" slug="${2:-p1}" n="${3:-1}"
  mkdir -p "$LSTATE/sendback"
  printf '# Sent back by the merge lane: fix X\n' > "$LSTATE/sendback/$slug.md"
  python3 -c 'import os,sys,time; t=time.time()-float(sys.argv[2])*60-int(sys.argv[3]); os.utime(sys.argv[1],(t,t))' \
    "$LSTATE/sendback/$slug.md" "$ago" "$n"
}

active_lane() { # a live pid, so lanes.py reports the slug as active (not reaped as crashed)
  mkdir -p "$LSTATE/lanes"
  printf '{"lane":1,"slug":"p1","status":"running","pid":%s,"started_at":%s}' "$$" "$(date +%s)" > "$LSTATE/lanes/1.json"
}

count_in() { # <pattern> <file> — 0 when the file is missing or nothing matches
  local n
  [ -f "$2" ] || { echo 0; return; }
  n="$(grep -c -- "$1" "$2" 2>/dev/null)" || n=0
  echo "${n:-0}"
}
stalled_lines() { count_in 'rework_stalled' "$LSTATE/merge/cycles.log"; }
ceo_lines() { count_in 'rework note' "$LSTATE/needs-ceo.md"; }

# --- 1. a young sendback waits quietly, with its age in the line -------------------------------
case_young_sendback_waits_quietly() {
  want young-sendback-waits-quietly || return 0
  reset_ctrl; pr_json; sendback 2
  run_dispatch
  [ "$rc" -eq 0 ] || fail "young: dispatcher rc=$rc ($out)"
  printf '%s\n' "$out" | grep -q 'waiting for rework (2m, no lane)' \
    || fail "young: the age is not in the line ($out)"
  [ "$(stalled_lines)" = 0 ] || fail "young: escalated a sendback younger than 20m ($(cat "$LSTATE/merge/cycles.log" 2>/dev/null))"
  [ "$(ceo_lines)" = 0 ] || fail "young: wrote a needs-ceo line for a young sendback"
  [ ! -s "$T/start.log" ] || fail "young: a verifier was started for a sent-back PR ($(cat "$T/start.log"))"
  pass young-sendback-waits-quietly
}

# --- 2. an old sendback escalates exactly once ------------------------------------------------
case_stalled_sendback_escalates_once() {
  want stalled-sendback-escalates-once || return 0
  reset_ctrl; pr_json; sendback 30
  run_dispatch
  [ "$rc" -eq 0 ] || fail "stalled: dispatcher rc=$rc ($out)"
  printf '%s\n' "$out" | grep -q 'waiting for rework (30m, no lane)' || fail "stalled: no age in the line ($out)"
  [ "$(stalled_lines)" = 1 ] || fail "stalled: want 1 rework_stalled line, got $(stalled_lines) ($(cat "$LSTATE/merge/cycles.log" 2>/dev/null))"
  grep -q '^[0-9-]* [0-9:]* #101 p1 rework_stalled age=30m sendback=' "$LSTATE/merge/cycles.log" \
    || fail "stalled: the cycles.log line does not name the PR, slug and age ($(cat "$LSTATE/merge/cycles.log"))"
  [ "$(ceo_lines)" = 1 ] || fail "stalled: want 1 needs-ceo line, got $(ceo_lines)"
  grep -q 'rsi/p1' "$LSTATE/needs-ceo.md" || fail "stalled: the needs-ceo line does not name the branch"
  [ ! -s "$T/start.log" ] || fail "stalled: a verifier was started for a sent-back PR"
  # The same sendback again: one line each, never a storm every 600 s.
  run_dispatch; run_dispatch
  [ "$(stalled_lines)" = 1 ] || fail "stalled: re-escalated the same sendback ($(stalled_lines) lines)"
  [ "$(ceo_lines)" = 1 ] || fail "stalled: repeated the needs-ceo line for the same sendback"
  pass stalled-sendback-escalates-once
}

# --- 3. a fresh sendback on the same slug escalates again ---------------------------------------
case_new_sendback_escalates_again() {
  want new-sendback-escalates-again || return 0
  reset_ctrl; pr_json; sendback 30
  run_dispatch
  [ "$(stalled_lines)" = 1 ] || fail "new-sendback: first escalation missing ($(stalled_lines))"
  sendback 30 p1 2     # a second rework round: same slug, different file mtime
  run_dispatch
  [ "$(stalled_lines)" = 2 ] || fail "new-sendback: a second sendback did not escalate ($(stalled_lines) lines)"
  [ "$(ceo_lines)" = 2 ] || fail "new-sendback: want 2 needs-ceo lines, got $(ceo_lines)"
  pass new-sendback-escalates-again
}

# --- 4. a live lane owns the slug: skip, never escalate -----------------------------------------
case_live_lane_is_not_stalled() {
  want live-lane-is-not-stalled || return 0
  reset_ctrl; pr_json; sendback 60; active_lane
  run_dispatch
  [ "$rc" -eq 0 ] || fail "live-lane: dispatcher rc=$rc ($out)"
  printf '%s\n' "$out" | grep -q 'p1: lane active, skip' || fail "live-lane: the active lane did not win ($out)"
  [ "$(stalled_lines)" = 0 ] || fail "live-lane: escalated a slug another lane owns"
  [ "$(ceo_lines)" = 0 ] || fail "live-lane: wrote a needs-ceo line for a slug another lane owns"
  [ ! -s "$T/start.log" ] || fail "live-lane: a second verifier was started"
  pass live-lane-is-not-stalled
}

# --- 5. the threshold is a knob, and the default is what production gets ------------------------
case_threshold_is_honoured() {
  want threshold-is-honoured || return 0
  reset_ctrl; pr_json; sendback 30
  out="$(RSI_REWORK_STALL_MIN=45 RSI_PR_LIST_CMD="cat $T/pr.json" RSI_START_LOG="$T/start.log" \
    RSI_PR_STATE_CMD='echo OPEN' bash "$MERGE" 2>&1)"; rc=$?
  [ "$rc" -eq 0 ] || fail "threshold: dispatcher rc=$rc ($out)"
  printf '%s\n' "$out" | grep -q 'waiting for rework (30m, no lane)' || fail "threshold: no age in the line ($out)"
  [ "$(stalled_lines)" = 0 ] || fail "threshold: escalated below the configured 45m"
  sendback 60 p1 2    # past the raised threshold
  out="$(RSI_REWORK_STALL_MIN=45 RSI_PR_LIST_CMD="cat $T/pr.json" RSI_START_LOG="$T/start.log" \
    RSI_PR_STATE_CMD='echo OPEN' bash "$MERGE" 2>&1)"
  [ "$(stalled_lines)" = 1 ] || fail "threshold: did not escalate above the configured 45m"
  # The production default is 20 minutes, not the test's 45.
  grep -q 'REWORK_STALL_MIN="${RSI_REWORK_STALL_MIN:-20}"' "$RSI/runtime/merge.sh" \
    || fail "threshold: the production default is not 20 minutes"
  pass threshold-is-honoured
}

for c in young-sendback-waits-quietly stalled-sendback-escalates-once \
         new-sendback-escalates-again live-lane-is-not-stalled threshold-is-honoured; do
  "case_${c//-/_}"
done
echo "PASS all"
