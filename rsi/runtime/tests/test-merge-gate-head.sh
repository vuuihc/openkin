#!/bin/bash
# test-merge-gate-head.sh — a gate that starts on a PR head which then moves must not finish on the
# stale SHA. 2026-11-27 14:24 (followup rsi/state/followups.md:2198): #812's .gate-head was
# a257d605 while a CEO touch-up had pushed the live head to 67460726; the verifier kept running
# check.sh for eight minutes and its verdict could not be used either way. Today the only head-move
# protection is AFTER the review (sendback()'s suppression). The gate must re-read the head while
# it runs and unwind as a SKIP: no sendback, no attempt, no PASS line, the gate's process tree dead,
# the gate lock released, a killed reviewer's partial output discarded, one operator line per stale
# head, and fail-closed on an unreadable head (a blank, a gh warning line or a failing gh keeps
# today's behaviour).
#
# Hermetic: temp control tree (with PAUSE set, so a red run that falls through to the dispatcher
# stops before gh), temp state dir, a stubbed PR head through RSI_PR_HEAD_CMD, a stub gate script
# that records its pid/child and waits for a release file, RSI_HEAD_POLL_SECS=1. No network, gh,
# npm, python, real gate or dispatch.
#
# Exercises merge.sh --gate-head-check, which runs the same gate_watched() + gate_head_unwind()
# the gate body calls. Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"
PIDS=""
trap 'for p in $PIDS; do kill "$p" 2>/dev/null; done
      for f in "$T"/*.gatepid "$T"/*.childpid; do [ -e "$f" ] && kill "$(cat "$f" 2>/dev/null)" 2>/dev/null; done
      rm -rf "$T"' EXIT
# Stub head modes (STUB_HEAD_MODE): file = print the file, warn = a gh warning line then a blank,
# fail = non-zero, blank = exit 0 with nothing.
HEAD=0123456789abcdef0123456789abcdef01234567
HEAD2=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
HEAD3=cccccccccccccccccccccccccccccccccccccccc
ONLY="${RSI_TEST_ONLY:-}"
RC=0; OUT=""; CASE=""; ST=""; RPID=""; SEAM_PID=""; CURRENT=""

pass() { echo "PASS $*"; }
fail() { echo "FAIL ${CURRENT:-$CASE}: $*" >&2; exit 1; }

# --- stubs -------------------------------------------------------------------------------------
cat > "$T/head-stub.sh" <<'SH'
#!/bin/bash
set -u
[ -n "${STUB_HEAD_ARG_FILE:-}" ] && printf '%s' "${1:-UNSET}" > "$STUB_HEAD_ARG_FILE"
# Record a COMPLETED poll, not its start: when a waiter sees this line the stub has exited, so
# head_moved_live() already holds the value and its comparison is the next thing the watcher runs.
trap '[ -z "${STUB_HEAD_LOG:-}" ] || printf "poll\n" >> "$STUB_HEAD_LOG"' EXIT
case "${STUB_HEAD_MODE:-file}" in
  warn)  printf 'warning: failed to read the PR head\n\n'; exit 0 ;;
  fail)  exit 1 ;;
  blank) exit 0 ;;
esac
cat "${STUB_HEAD_FILE:?}" 2>/dev/null || exit 1
SH

# Stand-in for gate.sh: records its pid, optionally starts a sleeping child, and holds until a
# release file appears — so a case can move the head while the gate is certainly still running.
cat > "$T/gate-stub.sh" <<'SH'
#!/bin/bash
set -u
printf '%s\n' "$$" > "${STUB_GATE_PID:?}"
printf 'ran\n' >> "${STUB_GATE_RAN:?}"
: > "${STUB_GATE_STARTED:?}"
if [ "${STUB_GATE_HOLD:-0}" = 1 ]; then
  sleep 30 & c=$!
  printf '%s\n' "$c" > "${STUB_GATE_CHILD:?}"
  while [ ! -e "${STUB_GATE_RELEASE:?}" ]; do sleep 0.1; done
  kill "$c" 2>/dev/null
  wait "$c" 2>/dev/null
fi
exit "${STUB_GATE_RC:-0}"
SH

# Stand-in for the review child: half-writes $PREV.new, then sleeps long enough to be killed.
cat > "$T/review-stub.sh" <<'SH'
#!/bin/bash
set -u
printf 'partial review: still reading the diff\n' > "${1:?}.new"
sleep 30
printf 'VERDICT: PASS\n' >> "$1.new"
SH

# --- helpers -----------------------------------------------------------------------------------
alive() { # <pid> -> 0 while the process exists and is not a zombie
  local s
  s="$(ps -o state= -p "${1:-0}" 2>/dev/null | tr -d ' ')"
  [ -n "$s" ] && [ "${s#Z}" = "$s" ]
}

wait_file() { # <secs> <file>
  local i=0 n=$(( $1 * 10 ))
  while [ "$i" -lt "$n" ]; do [ -e "$2" ] && return 0; sleep 0.1; i=$((i+1)); done
  return 1
}

wait_polls() { # <secs> <n> — bounded wait for >= <n> completed head-stub polls in $STUB_HEAD_LOG
  local i=0 lim=$(( $1 * 10 )) have=0
  while [ "$i" -lt "$lim" ]; do
    have="$(grep -c . "$STUB_HEAD_LOG" 2>/dev/null || true)"
    [ "${have:-0}" -ge "$2" ] && return 0
    sleep 0.1; i=$((i+1))
  done
  return 1
}

new_case() { # <name> — fresh state dir and control tree
  CASE="$1"; ST="$T/state"; RPID=""; SEAM_PID=""
  STUB_HEAD_LOG="$T/$CASE.polls"
  rm -rf "$ST"; mkdir -p "$ST/merge" "$ST/sendback"
  rm -rf "$T/ctrl"; mkdir -p "$T/ctrl/rsi/state"; : > "$T/ctrl/rsi/state/PAUSE"
  rm -f "$T/$CASE".head "$T/$CASE".started "$T/$CASE".release "$T/$CASE".out \
        "$T/$CASE".gatepid "$T/$CASE".childpid "$T/$CASE".ran "$T/$CASE".polls
}

start_seam() { # <case> <stale-sha> <hold|fast> [head-mode] [gate-rc]
  local hold=0
  [ "$3" = hold ] && hold=1
  STUB_HEAD_MODE="${4:-file}" STUB_HEAD_FILE="$T/$1.head" STUB_HEAD_LOG="$STUB_HEAD_LOG" \
  STUB_GATE_HOLD="$hold" STUB_GATE_RC="${5:-0}" \
  STUB_GATE_STARTED="$T/$1.started" STUB_GATE_RELEASE="$T/$1.release" \
  STUB_GATE_PID="$T/$1.gatepid" STUB_GATE_CHILD="$T/$1.childpid" \
  STUB_GATE_RAN="$T/$1.ran" \
  RSI_HEAD_POLL_SECS=1 RSI_CTRL="$T/ctrl" \
  RSI_PR_HEAD_CMD="bash $T/head-stub.sh \"\$1\"" \
  RSI_TEST_REV_PID="$RPID" \
    bash "$MERGE" --gate-head-check 242 "$2" "$ST" t "$ST/gate.log" bash "$T/gate-stub.sh" \
      > "$T/$1.out" 2>&1 &
  SEAM_PID=$!
  PIDS="$PIDS $SEAM_PID"
}

finish_seam() { # <secs> — bounded wait; fails instead of hanging when the gate was not killed
  local i=0 n=$(( $1 * 10 ))
  while [ "$i" -lt "$n" ] && alive "$SEAM_PID"; do sleep 0.1; i=$((i+1)); done
  if alive "$SEAM_PID"; then
    : > "$T/$CASE.release"      # let a surviving gate end, then reap it
    sleep 0.5
    kill "$SEAM_PID" 2>/dev/null; wait "$SEAM_PID" 2>/dev/null
    fail "$CASE: the seam did not return within ${1}s (gate not killed?): $(tr '\n' ' ' < "$T/$CASE.out")"
  fi
  wait "$SEAM_PID" 2>/dev/null; RC=$?
  OUT="$(cat "$T/$CASE.out")"
}

moved_cycle() { # <tag> <stale> <live> — one seam run whose head moves while the gate holds
  CASE="$1"
  printf '%s\n' "$2" > "$T/$1.head"
  mkdir -p "$ST/.gate.lock"     # the production gate block holds it; the unwind must release it
  start_seam "$1" "$2" hold
  wait_file 10 "$T/$1.started" || fail "$1: the stub gate never started"
  printf '%s\n' "$3" > "$T/$1.head"
  finish_seam 15
  case "$OUT" in *"SKIP $3"*) ;; *) fail "$1: output '$OUT', want SKIP $3" ;; esac
}

# --- cases -------------------------------------------------------------------------------------

# The head stays the same: the gate runs to completion and its own PASS/FAIL code is untouched.
test_same_head_keeps_the_gate() {
  new_case same-head
  printf '%s\n' "$HEAD" > "$T/$CASE.head"
  start_seam "$CASE" "$HEAD" hold
  wait_file 10 "$T/$CASE.started" || fail "same-head: the stub gate never started"
  # Two completed polls: the first poll's whole compare/kill path has finished. A bare sleep
  # would let a loaded machine release the gate before the watcher ever wrote its marker.
  wait_polls 10 2 || fail "same-head: the watcher never polled the head"
  : > "$T/$CASE.release"
  finish_seam 15
  [ "$RC" -eq 0 ] || fail "same-head: seam exited $RC ($OUT)"
  case "$OUT" in *"GATE 0"*) ;; *) fail "same-head: output '$OUT', want GATE 0" ;; esac
  [ "$(grep -c . "$T/$CASE.ran" 2>/dev/null || echo 0)" = 1 ] \
    || fail "same-head: the gate ran $(grep -c . "$T/$CASE.ran" 2>/dev/null || echo 0) times, want 1"
  [ "$(grep -c head_moved_skip "$ST/merge/cycles.log" 2>/dev/null || echo 0)" = 0 ] \
    || fail "same-head: recorded a head move for an unchanged head"
  [ ! -e "$ST/needs-ceo.md" ] || fail "same-head: wrote an operator line"
  return 0
}

# The live head moves mid-gate: skip, never a verdict. No sendback, no attempt, no PASS line.
test_moved_head_skips_the_cycle() {
  new_case moved-skip
  moved_cycle moved-skip "$HEAD" "$HEAD2"
  [ "$RC" -eq 0 ] || fail "moved-skip: seam exited $RC ($OUT)"
  grep -q 'head_moved_skip' "$ST/merge/cycles.log" \
    || fail "moved-skip: no head_moved_skip line in cycles.log"
  [ ! -e "$ST/sendback/t.md" ] || fail "moved-skip: wrote a sendback"
  [ ! -e "$ST/merge/t.attempts" ] || fail "moved-skip: created an attempts file"
  [ ! -e "$ST/merge/t.verified" ] || fail "moved-skip: wrote a verified PASS"
  [ ! -e "$ST/merge/t.reviewed" ] || fail "moved-skip: wrote a reviewed PASS"
  [ "$(grep -c . "$ST/needs-ceo.md" 2>/dev/null || echo 0)" = 1 ] \
    || fail "moved-skip: needs-ceo.md is not exactly one line: $(cat "$ST/needs-ceo.md" 2>/dev/null)"
  grep -q 'head moved 01234567 -> bbbbbbbb during the gate' "$ST/needs-ceo.md" \
    || fail "moved-skip: operator line wrong: $(cat "$ST/needs-ceo.md")"
  [ ! -e "$ST/.gate.lock" ] || fail "moved-skip: the gate lock survived the unwind"
  return 0
}

# Fail closed on READING: a gh warning line, a failing gh and a blank all keep today's behaviour.
test_unreadable_head_fails_open() {
  local mode
  for mode in warn fail blank; do
    new_case "unreadable-$mode"
    printf '%s\n' "$HEAD" > "$T/$CASE.head"
    start_seam "$CASE" "$HEAD" hold "$mode"
    wait_file 10 "$T/$CASE.started" || fail "$mode: the stub gate never started"
    # Two completed polls on an unreadable head must not kill the gate.
    wait_polls 10 2 || fail "$mode: the watcher did not poll the head twice"
    : > "$T/$CASE.release"
    finish_seam 15
    [ "$RC" -eq 0 ] || fail "$mode: seam exited $RC ($OUT)"
    case "$OUT" in *"GATE 0"*) ;; *) fail "$mode: output '$OUT', want GATE 0 (fail open)" ;; esac
    [ "$(grep -c . "$T/$CASE.ran" 2>/dev/null || echo 0)" = 1 ] \
      || fail "$mode: the gate did not run to completion"
    [ "$(grep -c head_moved_skip "$ST/merge/cycles.log" 2>/dev/null || echo 0)" = 0 ] \
      || fail "$mode: skipped the cycle on an unreadable head"
    [ ! -e "$ST/needs-ceo.md" ] || fail "$mode: wrote an operator line"
  done
  return 0
}

# The gate's whole process tree dies with the unwind, and the lock is released on the skip path.
test_moved_head_kills_the_gate_tree() {
  new_case moved-kill
  moved_cycle moved-kill "$HEAD" "$HEAD2"
  [ ! -e "$ST/.gate.lock" ] || fail "moved-kill: .gate.lock survived the unwind"
  wait_file 5 "$T/moved-kill.childpid" || fail "moved-kill: the gate never started its child"
  local gp cp i=0
  gp="$(cat "$T/moved-kill.gatepid")"; cp="$(cat "$T/moved-kill.childpid")"
  while [ "$i" -lt 50 ] && { alive "$gp" || alive "$cp"; }; do sleep 0.1; i=$((i+1)); done
  alive "$cp" && fail "moved-kill: the gate's sleeping child (pid $cp) survived the unwind"
  alive "$gp" && fail "moved-kill: the gate itself (pid $gp) survived the unwind"
  return 0
}

# A killed reviewer's half-written review is discarded, never promoted over the last real one.
test_moved_head_discards_the_partial_review() {
  new_case moved-review
  printf 'reviewed head, VERDICT: PASS\n' > "$ST/merge/t.review.txt"
  bash "$T/review-stub.sh" "$ST/merge/t.review.txt" & RPID=$!
  disown "$RPID" 2>/dev/null || true   # the kill below is a SIGKILL: keep bash's job line out of the PASS output
  PIDS="$PIDS $RPID"
  wait_file 10 "$ST/merge/t.review.txt.new" || fail "moved-review: the review stub wrote no partial"
  moved_cycle moved-review "$HEAD" "$HEAD2"
  [ ! -e "$ST/merge/t.review.txt.new" ] || fail "moved-review: the partial review survived the unwind"
  [ "$(cat "$ST/merge/t.review.txt")" = 'reviewed head, VERDICT: PASS' ] \
    || fail "moved-review: \$PREV was overwritten: $(cat "$ST/merge/t.review.txt")"
  local i=0
  while [ "$i" -lt 50 ] && alive "$RPID"; do sleep 0.1; i=$((i+1)); done
  alive "$RPID" && fail "moved-review: the killed reviewer (pid $RPID) survived the unwind"
  wait "$RPID" 2>/dev/null || true
  return 0
}

# A skip never burns a rework attempt: an existing count is untouched.
test_moved_head_does_not_burn_an_attempt() {
  new_case moved-attempts
  echo 2 > "$ST/merge/t.attempts"
  moved_cycle moved-attempts "$HEAD" "$HEAD2"
  [ "$(cat "$ST/merge/t.attempts")" = 2 ] \
    || fail "moved-attempts: attempts became $(cat "$ST/merge/t.attempts"), want 2"
  [ ! -e "$ST/sendback/t.md" ] || fail "moved-attempts: wrote a sendback"
  return 0
}

# The operator line is keyed per stale head: repeated cycles on one stale head write it once.
test_moved_head_marker_is_per_head() {
  new_case marker
  moved_cycle marker-a "$HEAD" "$HEAD2"
  moved_cycle marker-b "$HEAD" "$HEAD2"
  [ "$(grep -c . "$ST/needs-ceo.md" 2>/dev/null || echo 0)" = 1 ] \
    || fail "marker: two cycles on one stale head wrote $(grep -c . "$ST/needs-ceo.md") lines, want 1"
  [ "$(grep -c head_moved_skip "$ST/merge/cycles.log")" = 2 ] \
    || fail "marker: cycles.log has $(grep -c head_moved_skip "$ST/merge/cycles.log") skip lines, want 2"
  moved_cycle marker-c "$HEAD2" "$HEAD3"
  [ "$(grep -c . "$ST/needs-ceo.md" 2>/dev/null || echo 0)" = 2 ] \
    || fail "marker: a new stale head did not get its own line"
  return 0
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  CURRENT="$1"
  "$1" || exit 1
  pass "$1"
}

run test_same_head_keeps_the_gate
run test_moved_head_skips_the_cycle
run test_unreadable_head_fails_open
run test_moved_head_kills_the_gate_tree
run test_moved_head_discards_the_partial_review
run test_moved_head_does_not_burn_an_attempt
run test_moved_head_marker_is_per_head
echo ALL-PASS
