#!/bin/bash
# test-gate-lock-timeout.sh — a verifier that cannot acquire state/.gate.lock must skip its
# cycle, never charge the wait to the branch. #387 (2026-11-19) was sent back as
# "gate failed: gate lock timeout": a rework lane, one of the three attempts, and a worker
# editing code nobody had proved wrong. The wait is the loop's own contention between
# verifiers, not a verdict on the PR.
#
# Hermetic: a temp state dir, fake lock dirs with a live and a dead pid, and the gate lock's
# poll shortened through RSI_GATE_LOCK_POLL (the max wait stays in seconds). No network, gh,
# npm, gate or python.
#
# Exercises merge.sh --gate-lock-check, which runs the same mklock() + gate_lock_decision()
# the gate body calls. Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"; HOLDER=""
trap 'rm -rf "$T"; [ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null' EXIT
export RSI_GATE_LOCK_POLL=0.05   # poll cadence only: a held lock still "waits" 0 s here
ONLY="${RSI_TEST_ONLY:-}"
RC=0; OUT=""; ST=""; HEAD=0123456789abcdef0123456789abcdef01234567
# The red run (unmodified merge.sh has no seam) falls through to the dispatcher; PAUSE is the
# first thing it honours, so no gh, fetch or dispatch happens either way.
mkdir -p "$T/ctrl/rsi/state"; : > "$T/ctrl/rsi/state/PAUSE"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

new_state() { ST="$T/state"; rm -rf "$ST"; mkdir -p "$ST/merge" "$ST/sendback"; }

# hold_lock — the state two contending verifiers leave: a lock dir whose pid is alive.
hold_lock() {
  [ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null
  mkdir -p "$ST/.gate.lock"
  sleep 30 & HOLDER=$!; disown "$HOLDER" 2>/dev/null || true
  echo "$HOLDER" > "$ST/.gate.lock/pid"
}

seam() { # <slug> <sha> [state] -> RC, OUT
  RSI_CTRL="$T/ctrl" bash "$MERGE" --gate-lock-check "$1" "$2" "${3:-$ST}" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
}

lines() { [ -e "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

expect_skip() { # <case>
  [ "$RC" -eq 0 ] || fail "$1: exit $RC, want 0 ($OUT)"
  case "$OUT" in SKIP*) ;; *) fail "$1: output is '$OUT', want a SKIP line" ;; esac
}

expect_gate() { # <case>
  [ "$RC" -eq 1 ] || fail "$1: exit $RC, want 1 ($OUT)"
  case "$OUT" in GATE*) ;; *) fail "$1: output is '$OUT', want a GATE line" ;; esac
}

# --- cases -------------------------------------------------------------------------------------

# A held lock is loop contention: skip the cycle, no sendback, no attempt spent.
test_timeout_skips() {
  new_state; hold_lock; echo 1 > "$ST/merge/t.attempts"
  seam t "$HEAD"
  expect_skip timeout-skips
  [ ! -e "$ST/sendback/t.md" ] || fail "timeout-skips: wrote a sendback"
  [ "$(cat "$ST/merge/t.attempts")" = 1 ] \
    || fail "timeout-skips: attempts moved to $(cat "$ST/merge/t.attempts")"
}

# No lock: the gate proceeds, and the seam leaves the lock free again.
test_free_gates() {
  new_state
  seam t "$HEAD"
  expect_gate free-gates
  [ ! -e "$ST/.gate.lock" ] || fail "free-gates: the seam left the gate lock behind"
}

# A dead pid is reclaimed by mklock exactly as today: a stale lock is not a timeout.
test_stale_pid_gates() {
  new_state
  ( exit 0 ) & local dead=$!; wait "$dead" 2>/dev/null
  kill -0 "$dead" 2>/dev/null && fail "stale-pid-gates: cannot produce a dead pid"
  mkdir -p "$ST/.gate.lock"; echo "$dead" > "$ST/.gate.lock/pid"
  seam t "$HEAD"
  expect_gate stale-pid-gates
}

# The second timeout on one head leaves exactly one needs-ceo line; a third adds none, and a
# new head gets its own line (the marker is per head).
test_repeat_timeout_one_line() {
  new_state; hold_lock
  seam t "$HEAD"; seam t "$HEAD"
  expect_skip repeat-timeout-one-line
  [ "$(lines "$ST/needs-ceo.md")" -eq 1 ] \
    || fail "repeat: $(lines "$ST/needs-ceo.md") lines after two timeouts, want 1"
  seam t "$HEAD"
  [ "$(lines "$ST/needs-ceo.md")" -eq 1 ] || fail "repeat: a third timeout added another line"
  seam t "${HEAD}ff"; seam t "${HEAD}ff"
  [ "$(lines "$ST/needs-ceo.md")" -eq 2 ] || fail "repeat: a new head did not get its own line"
}

# The prettier and outside-footprint re-gates take the same skip path as the first gate: a lock
# timeout may never fall back to GRC=1, which reaches the GATE_OK=0 sendback and costs an attempt.
test_regate_timeout_skips() {
  local region n_dec n_exit
  region="$(sed -n '/^GATE_OK=1; GATE_NOTE=""; GATE_OUTSIDE=0$/,/^if \[ -n "\$REVPID" \]; then$/p' "$MERGE")"
  [ -n "$region" ] || fail "regate: cannot delimit the gate block"
  grep -q 'GRC=1' <<<"$region" && fail "regate: a lock timeout still sets GRC=1 (gate failure)"
  n_dec="$(grep -cF 'gate_lock_decision timeout "$SLUG" "$SHA" "$STATE"' <<<"$region")"
  n_exit="$(grep -cE '^ *exit 0$' <<<"$region")"
  [ "$n_dec" -eq 3 ] \
    || fail "regate: $n_dec timeout skip paths in the gate block, want 3 (first gate + prettier + outside re-gates)"
  [ "$n_exit" -eq 3 ] \
    || fail "regate: $n_dec skip paths but $n_exit exit 0 lines; each timeout must leave the verifier"
}

# A missing or partial argument list is a usage error, never a fall-through into the dispatcher.
test_seam_usage() {
  RSI_CTRL="$T/ctrl" bash "$MERGE" --gate-lock-check > "$T/usage" 2>&1
  [ $? -ne 0 ] || fail "usage: the seam without arguments exited 0"
  grep -q 'usage: merge.sh --gate-lock-check' "$T/usage" \
    || fail "usage: no usage line ($(tr '\n' ' ' < "$T/usage"))"
  RSI_CTRL="$T/ctrl" bash "$MERGE" --gate-lock-check t "$HEAD" > "$T/usage" 2>&1
  [ $? -ne 0 ] || fail "usage: a short argument list exited 0"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$1" || exit 1
  pass "$1"
}

run test_timeout_skips
run test_free_gates
run test_stale_pid_gates
run test_repeat_timeout_one_line
run test_regate_timeout_skips
run test_seam_usage
echo ALL-PASS
