#!/bin/bash
# test-ux-walk-timeout.sh — the UX walk must have a ceiling, and hitting it must
# be an honest "no verdict", not an infinite merge-lane wait and not a pass.
#
# Measured 2026-11-19: one UI PR's walk ran 40 minutes; merge.sh -> ux-gate.sh ->
# ux-walk.sh -> heavy.sh -> node was unbounded at every step, so from outside the
# lane nobody could tell slow from dead. The bound is now RSI_WALK_MAX_S (default
# 1800s) around the walker, with an outer RSI_UX_GATE_MAX_S (default 5400s) in
# merge.sh that maps exit 124 to "unavailable + cooldown, no sendback, not merged".
#
# This suite drives the build-free --timeout-probe seam in ux-walk.sh: no UI
# build, no daemon, no network. It proves what a ceiling alone does not:
#   1. a command past the ceiling is reported unavailable (exit 2), never rc 0;
#   2. its descendants die with it, including a child the tree would otherwise
#      respawn (heavy.sh's node walker used to outlive a killed wrapper);
#   3. a child that finishes keeps its own status even when the deadline is in
#      the same tick — a polling loop used to relabel that answer as a timeout;
#   4. a fast non-zero exit is not a timeout;
#   5. a deadline identity read that fails is "cannot inspect", not "pid reused":
#      the tree is still killed (fail closed);
#   6. a watchdog flag set while the child is still alive does not relabel the
#      child's own non-signal exit as 124;
#   7. merge.sh's wiring: the outer bound, the 124 -> unavailable mapping, and
#      the preserved red's sources (the first walk under state/shots, a finished
#      confirm's clearance, known artefacts) — what turns a wedged gate into a
#      next-cycle retry instead of a false-red sendback.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WALK="$REPO/rsi/runtime/ux-walk.sh"
MERGE="$REPO/rsi/runtime/merge.sh"
T="$(mktemp -d)"; trap 'pkill -f "$T/rsi-killtag-" 2>/dev/null || true; rm -rf "$T"' EXIT

pass() { echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# A stub walker that leaves a live grandchild, the way heavy.sh leaves node:
# if the ceiling only kills the direct child, child.pid is still alive here.
cat > "$T/stub.sh" <<'SH'
#!/bin/bash
sleep 6 & echo $! > "$1/child.pid"
wait
SH

# A stub that keeps a tagged child alive and respawns it when it dies: a tree
# kill that merely walks children leaves a replacement running behind.
TAG="$T/rsi-killtag-$$"
cat > "$T/spawner.sh" <<'SH'
#!/bin/bash
tag="$1"
trap '' TERM   # a node-style parent: TERM does not stop it from forking
while :; do bash -c 'sleep 3; :' "$tag" & sleep 0.05; done
SH

# 1. past the ceiling: unavailable, and the grandchild is gone
OUT1="$T/o1"; mkdir -p "$OUT1"
T0="$(date +%s)"
RSI_WALK_MAX_S=2 bash "$WALK" --timeout-probe "$OUT1" bash "$T/stub.sh" "$OUT1" >/dev/null 2>&1
RC=$?
EL=$(( $(date +%s) - T0 ))
[ "$RC" -eq 2 ] || fail "ceiling: expected exit 2 (unavailable), got $RC"
[ -s "$OUT1/UNAVAILABLE" ] || fail "ceiling: no UNAVAILABLE marker"
grep -q 'exceeded 2s' "$OUT1/UNAVAILABLE" || fail "ceiling: marker does not name the ceiling: $(cat "$OUT1/UNAVAILABLE")"
[ "$EL" -le 15 ] || fail "ceiling: took ${EL}s, the bound did not fire promptly"
CPID="$(cat "$OUT1/child.pid" 2>/dev/null || echo '')"
[ -n "$CPID" ] || fail "ceiling: stub never wrote child.pid"
for _ in 1 2 3 4 5; do kill -0 "$CPID" 2>/dev/null || break; sleep 1; done
kill -0 "$CPID" 2>/dev/null && fail "ceiling: grandchild $CPID survived the timeout (orphaned walker)"
pass "ceiling: walk reported unavailable and its process tree died"

# 2. a tree that respawns its child: no replacement may survive the kill
OUT2="$T/o2"; mkdir -p "$OUT2"
RSI_WALK_MAX_S=2 bash "$WALK" --timeout-probe "$OUT2" bash "$T/spawner.sh" "$TAG" >/dev/null 2>&1
[ $? -eq 2 ] || fail "respawn: the bound did not report unavailable"
for _ in 1 2 3; do pgrep -f "$TAG" >/dev/null 2>&1 || break; sleep 0.5; done
pgrep -f "$TAG" >/dev/null 2>&1 && fail "respawn: a replacement child outlived the tree kill: $(pgrep -fl "$TAG" | head -3)"
pass "respawn: no replacement child survived the tree kill"

# 3. a child that finishes near the deadline keeps its own status
OUT3="$T/o3"; mkdir -p "$OUT3"
T0="$(date +%s)"
RSI_WALK_MAX_S=1 bash "$WALK" --timeout-probe "$OUT3" bash -c 'sleep 0.2; exit 5' >/dev/null 2>&1
RC=$?
EL=$(( $(date +%s) - T0 ))
[ "$RC" -eq 5 ] || fail "near-ceiling exit: expected rc 5 (the child's answer), got $RC"
[ "$EL" -le 5 ] || fail "near-ceiling exit: waited ${EL}s instead of returning at once"
[ ! -e "$OUT3/UNAVAILABLE" ] || fail "near-ceiling exit: mislabelled as a timeout"
pass "near-ceiling exit: keeps the child's own status (no polling-tick timeout)"

# 4. a fast non-zero exit is not a timeout either
OUT4="$T/o4"; mkdir -p "$OUT4"
RSI_WALK_MAX_S=30 bash "$WALK" --timeout-probe "$OUT4" bash -c 'exit 3' >/dev/null 2>&1
RC=$?
[ "$RC" -eq 3 ] || fail "fast failure: expected rc 3, got $RC"
[ ! -e "$OUT4/UNAVAILABLE" ] || fail "fast failure: mislabelled as a timeout"
pass "fast failure: keeps its own exit code, no timeout label"

# 5. a deadline identity read that fails must still kill the tree. An empty
#    `ps` answer is "cannot inspect", not a reused pid; reading it as a mismatch
#    would leave the hung walker running. The stub answers the identity read,
#    then fails every later call (the deadline read).
OUT5="$T/o5"; mkdir -p "$OUT5"
PSCOUNT="$T/pscount"; REAL_PS="$(command -v ps)"
export PSCOUNT REAL_PS
cat > "$T/psstub.bash" <<'SH'
ps() {
  local n=0
  [ -f "$PSCOUNT" ] && n="$(cat "$PSCOUNT")"
  n=$((n + 1)); printf '%s\n' "$n" > "$PSCOUNT"
  [ "$n" -eq 1 ] && { "$REAL_PS" "$@"; return; }
  return 1
}
SH
T0="$(date +%s)"
BASH_ENV="$T/psstub.bash" RSI_WALK_MAX_S=1 bash "$WALK" --timeout-probe "$OUT5" bash "$T/stub.sh" "$OUT5" >/dev/null 2>&1
RC=$?
EL=$(( $(date +%s) - T0 ))
[ "$RC" -eq 2 ] || fail "blind deadline read: expected exit 2 (unavailable), got $RC"
[ -s "$OUT5/UNAVAILABLE" ] || fail "blind deadline read: no UNAVAILABLE marker"
[ "$EL" -le 5 ] || fail "blind deadline read: took ${EL}s; an unreadable ps skipped the kill"
CPID="$(cat "$OUT5/child.pid" 2>/dev/null || echo '')"
[ -n "$CPID" ] || fail "blind deadline read: stub never wrote child.pid"
for _ in 1 2 3 4 5; do kill -0 "$CPID" 2>/dev/null || break; sleep 1; done
kill -0 "$CPID" 2>/dev/null && fail "blind deadline read: grandchild $CPID survived (fail-open kill)"
pass "blind deadline read: an unreadable identity still kills the tree (fail closed)"

# 6. the watchdog can set its flag and lose the race: the child finishes on its
#    own, with a non-signal status, after the flag exists. That status is the
#    answer; only a signal death (rc >= 128) is the no-verdict 124. rsi_kill_tree
#    is a no-op so the race is constructed every run, not left to timing.
OUT6="$T/o6"; mkdir -p "$OUT6"
RSI_CTRL="$T/ctrl" bash -c '
  set -u
  source "$1"
  rsi_kill_tree() { :; }
  bounded_run 1 bash -c "sleep 3; exit 7"
  printf "%s\n" "$?" > "$2/rc"
' _ "$REPO/rsi/runtime/common.sh" "$OUT6" || true
RC="$(cat "$OUT6/rc" 2>/dev/null || echo none)"
[ "$RC" = 7 ] || fail "flag race: expected rc 7 (the child's own answer), got $RC"
pass "flag race: a non-signal exit keeps its status even after the watchdog flag"

# 7. wiring: the outer gate bound exists and 124 is not a pass
grep -q 'bounded_run "$GATE_MAX" bash "$RSI_DIR/runtime/ux-gate.sh"' "$MERGE" \
  || fail "wiring: merge.sh calls ux-gate.sh without bounded_run"
grep -q 'if \[ "$urc" -eq 124 \]' "$MERGE" \
  || fail "wiring: merge.sh does not map 124 to unavailable"
# An outer expiry that lands during the confirmation re-walk must keep the first
# walk's red (ux-gate's own fail-closed rule), not turn it into "unavailable".
grep -q 'keeping the walk red' "$MERGE" \
  || fail "wiring: merge.sh can turn a walk red into unavailable on outer expiry"
# Fixed string: `if [ -n "$RED" ]` alone also prefixes the known-artefact filter.
grep -qF 'if [ -n "$RED" ]; then' "$MERGE" \
  || fail "wiring: merge.sh has no red-preserving branch"
# ux-gate writes the first walk to $STATE/shots/<slug>/journeys/walk.json;
# $STATE/ux/<slug>/walk.json exists nowhere, and red from it makes the branch dead.
grep -qF '"$STATE/shots/$SLUG/journeys/walk.json"' "$MERGE" \
  || fail "wiring: merge.sh reads the first walk from a path no script writes"
# A confirm that finished rewrote the red set: prefer it, and a line it cleared
# (empty confirm.hard) must not be sent back on an outer expiry.
grep -qF 'if [ -e "$STATE/ux/$SLUG/confirm.json" ]; then' "$MERGE" \
  || fail "wiring: merge.sh does not check whether the confirm finished"
grep -qF '"$STATE/ux/$SLUG/confirm.hard"' "$MERGE" \
  || fail "wiring: merge.sh ignores a finished confirm's surviving reds"
# Known environment artefacts are printed but never convict, as in ux-gate.
grep -qF 'grep -v -F -f "$KNOWN"' "$MERGE" \
  || fail "wiring: merge.sh does not drop known walk artefacts"
pass "wiring: merge.sh bounds the gate, maps 124, and reads a preserved red from ux-gate's paths"

echo "all cases passed"
