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
#      next-cycle retry instead of a false-red sendback;
#   8. merge.sh clears the slug's confirm evidence before the gate runs, so an
#      outer 124 cannot read a previous attempt's tree as this attempt's red.
#   9-13. the walk's ceiling does not count the wait for the heavy slot: the
#      composition seam (--walk-probe, shared with the real walk) starts the
#      walker's bound only after the slot is held; an expired slot wait is its
#      own message, never "walker exceeded"; RSI_NO_HEAVY still fails closed
#      before any slot or walk; and a fast non-zero walker exit keeps its status.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WALK="$REPO/rsi/runtime/ux-walk.sh"
MERGE="$REPO/rsi/runtime/merge.sh"
T="$(mktemp -d)"
SLOT_HOLD_PID=""
trap 'pkill -f "$T/rsi-killtag-" 2>/dev/null || true; [ -n "$SLOT_HOLD_PID" ] && kill "$SLOT_HOLD_PID" 2>/dev/null; rm -rf "$T"' EXIT

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

# 8. ux-gate clears confirm.json only below its first walk, so a stale file from
#    an earlier attempt on the same slug must be gone before the gate starts:
#    otherwise an outer 124 during this attempt's build/seed/walk reads the
#    previous tree's confirm.hard and sends back reds this head never produced.
RM_LINE="$(grep -nF 'rm -f "$STATE/ux/$SLUG/confirm.json" "$STATE/ux/$SLUG/confirm.hard"' "$MERGE" | head -1 | cut -d: -f1)"
GATE_LINE="$(grep -nF 'bounded_run "$GATE_MAX" bash "$RSI_DIR/runtime/ux-gate.sh"' "$MERGE" | head -1 | cut -d: -f1)"
[ -n "$RM_LINE" ] || fail "stale confirm: merge.sh does not clear the slug's confirm evidence before the gate"
[ -n "$GATE_LINE" ] || fail "stale confirm: the ux-gate bounded_run call moved"
[ "$RM_LINE" -lt "$GATE_LINE" ] \
  || fail "stale confirm: clearing (line $RM_LINE) is not before the gate call (line $GATE_LINE)"
pass "stale confirm: the gate's confirm evidence is cleared before it runs"

# --- 9-13: the walk's ceiling must not count the wait for the heavy slot --------
# Measured 2026-11-23 (PR #610): ux-walk.sh wrapped heavy.sh AND the walker in
# one bounded_run, so the queue for the machine-wide slot spent the walker's
# 1800s. A healthy 29.5-minute walk was killed and recorded as "walker exceeded
# 1800s"; the merge lane re-walked the PR as unavailable and the next reader
# could not tell a busy machine from a hung walker. The composition is now two
# bounds: the slot wait (RSI_HEAVY_WAIT_MAX, fail-closed for the walk) and the
# walker (RSI_WALK_MAX_S, starting only once the slot is held). The real walk
# and the build-free --walk-probe seam share one function, so these cases drive
# the same order the gate does.
SLOT_CTRL="$T/ctrl-slot"; mkdir -p "$SLOT_CTRL/rsi/runtime"
cp "$REPO/rsi/runtime/common.sh" "$SLOT_CTRL/rsi/runtime/common.sh"
cp "$WALK" "$SLOT_CTRL/rsi/runtime/ux-walk.sh"
chmod +x "$SLOT_CTRL/rsi/runtime/"*.sh
# Stub slot holder: records that the slot path was entered, spends
# STUB_SLOT_WAIT seconds "queueing", then runs the command as its holder. The
# real heavy.sh is exercised by case 11, which occupies a real slot instead.
cat > "$SLOT_CTRL/rsi/runtime/heavy.sh" <<'SH'
#!/bin/bash
if [ -n "${STUB_HEAVY_MARKER:-}" ]; then : > "$STUB_HEAVY_MARKER"; fi
sleep "${STUB_SLOT_WAIT:-0}"
exec env RSI_HEAVY_HELD=1 "$@"
SH
chmod +x "$SLOT_CTRL/rsi/runtime/heavy.sh"
SLOT_SEAM="$SLOT_CTRL/rsi/runtime/ux-walk.sh"
cat > "$T/walk-2_5s.sh" <<'SH'
#!/bin/bash
sleep 2.5
exit 0
SH
cat > "$T/walk-mark.sh" <<'SH'
#!/bin/bash
if [ -n "${WALK_MARK:-}" ]; then : > "$WALK_MARK"; fi
exit 0
SH
chmod +x "$T/walk-2_5s.sh" "$T/walk-mark.sh"

# 9. the red case: a 2s slot wait plus a 2.5s walker under a 3s walker ceiling.
#    On the wrapped order the ceiling started at heavy.sh, so 4.5s > 3s and a
#    healthy walk became 124/unavailable.
OUT9="$T/o9"; mkdir -p "$OUT9"
T0="$(date +%s)"
STUB_HEAVY_MARKER="$T/walk9.heavy" STUB_SLOT_WAIT=2 RSI_WALK_MAX_S=3 \
  bash "$SLOT_SEAM" --walk-probe "$OUT9" bash "$T/walk-2_5s.sh" >/dev/null 2>&1
RC=$?
EL=$(( $(date +%s) - T0 ))
[ "$RC" -eq 0 ] || fail "slot wait: the walker's ceiling starts after the heavy slot is held: exit $RC, wanted 0 (UNAVAILABLE: $(cat "$OUT9/UNAVAILABLE" 2>/dev/null))"
[ ! -e "$OUT9/UNAVAILABLE" ] || fail "slot wait: the walker's ceiling starts after the heavy slot is held: mislabelled as unavailable: $(cat "$OUT9/UNAVAILABLE")"
[ -f "$T/walk9.heavy" ] || fail "slot wait: the walker's ceiling starts after the heavy slot is held: the slot path was never entered"
[ "$EL" -ge 4 ] || fail "slot wait: the walker's ceiling starts after the heavy slot is held: returned in ${EL}s, before the 2s slot wait could have finished"
pass "slot wait: the walker's ceiling starts after the heavy slot is held"

# 10. the walker's own ceiling still fails closed after the slot is held, and
#     its tree dies with it (the composed inner bound, not only the outer one).
OUT10="$T/o10"; mkdir -p "$OUT10"
STUB_SLOT_WAIT=1 RSI_WALK_MAX_S=2 \
  bash "$SLOT_SEAM" --walk-probe "$OUT10" bash "$T/stub.sh" "$OUT10" >/dev/null 2>&1
RC=$?
[ "$RC" -eq 2 ] || fail "slot wait: a walker that itself exceeds the ceiling still reports unavailable: exit $RC, wanted 2"
[ -s "$OUT10/UNAVAILABLE" ] || fail "slot wait: a walker that itself exceeds the ceiling still reports unavailable: no UNAVAILABLE marker"
grep -q 'exceeded 2s' "$OUT10/UNAVAILABLE" \
  || fail "slot wait: a walker that itself exceeds the ceiling still reports unavailable: marker does not name the ceiling: $(cat "$OUT10/UNAVAILABLE")"
case "$(cat "$OUT10/UNAVAILABLE")" in
  *heavy\ slot*) fail "slot wait: a walker that itself exceeds the ceiling still reports unavailable: blamed the slot: $(cat "$OUT10/UNAVAILABLE")" ;;
esac
CPID="$(cat "$OUT10/child.pid" 2>/dev/null || echo '')"
[ -n "$CPID" ] || fail "slot wait: a walker that itself exceeds the ceiling still reports unavailable: stub never wrote child.pid"
for _ in 1 2 3 4 5; do kill -0 "$CPID" 2>/dev/null || break; sleep 1; done
kill -0 "$CPID" 2>/dev/null \
  && fail "slot wait: a walker that itself exceeds the ceiling still reports unavailable: grandchild $CPID survived (the composed bound did not kill the tree)"
pass "slot wait: a walker that itself exceeds the ceiling still reports unavailable"

# 11. the real heavy.sh, with its slot occupied by a live holder: a small
#     RSI_HEAVY_WAIT_MAX expires, the walker never starts, and the report is
#     about the slot. It must not borrow the walker's message (the defect this
#     row removes: "walker exceeded" for time spent queueing).
REAL_CTRL="$T/ctrl-real"; mkdir -p "$REAL_CTRL/rsi/runtime"
cp "$REPO/rsi/runtime/common.sh" "$REAL_CTRL/rsi/runtime/common.sh"
cp "$WALK" "$REAL_CTRL/rsi/runtime/ux-walk.sh"
cp "$REPO/rsi/runtime/heavy.sh" "$REAL_CTRL/rsi/runtime/heavy.sh"
chmod +x "$REAL_CTRL/rsi/runtime/"*.sh
mkdir -p "$REAL_CTRL/rsi/state/heavy/slot1"
sleep 300 & SLOT_HOLD_PID=$!
printf '%s\n' "$SLOT_HOLD_PID" > "$REAL_CTRL/rsi/state/heavy/slot1/pid"
OUT11="$T/o11"; mkdir -p "$OUT11"
T0="$(date +%s)"
WALK_MARK="$T/walk11.ran" RSI_HEAVY_WAIT_MAX=1 RSI_WALK_MAX_S=30 \
  bash "$REAL_CTRL/rsi/runtime/ux-walk.sh" --walk-probe "$OUT11" bash "$T/walk-mark.sh" >/dev/null 2>&1
RC=$?
EL=$(( $(date +%s) - T0 ))
kill "$SLOT_HOLD_PID" 2>/dev/null; wait "$SLOT_HOLD_PID" 2>/dev/null; SLOT_HOLD_PID=""
rm -rf "$REAL_CTRL/rsi/state/heavy"
[ "$RC" -eq 2 ] || fail "slot wait: an expired slot wait is reported as the slot, not the walker: exit $RC, wanted 2"
[ -s "$OUT11/UNAVAILABLE" ] || fail "slot wait: an expired slot wait is reported as the slot, not the walker: no UNAVAILABLE marker"
grep -qi 'heavy slot\|machine-wide' "$OUT11/UNAVAILABLE" \
  || fail "slot wait: an expired slot wait is reported as the slot, not the walker: marker does not name the slot: $(cat "$OUT11/UNAVAILABLE")"
grep -q 'walker exceeded' "$OUT11/UNAVAILABLE" \
  && fail "slot wait: an expired slot wait is reported as the slot, not the walker: blamed the walker: $(cat "$OUT11/UNAVAILABLE")"
[ ! -e "$T/walk11.ran" ] \
  || fail "slot wait: an expired slot wait is reported as the slot, not the walker: the walker ran without the slot"
[ "$EL" -le 20 ] || fail "slot wait: an expired slot wait is reported as the slot, not the walker: took ${EL}s, the wait was not bounded"
pass "slot wait: an expired slot wait is reported as the slot, not the walker"

# 12. RSI_NO_HEAVY still fails closed before the slot wait and before the walk:
#     the stub would record both and sleep 5s if either was reached.
OUT12="$T/o12"; mkdir -p "$OUT12"
T0="$(date +%s)"
RSI_NO_HEAVY=1 STUB_SLOT_WAIT=5 STUB_HEAVY_MARKER="$T/walk12.heavy" WALK_MARK="$T/walk12.ran" \
  bash "$SLOT_SEAM" --walk-probe "$OUT12" bash "$T/walk-mark.sh" >/dev/null 2>&1
RC=$?
EL=$(( $(date +%s) - T0 ))
[ "$RC" -eq 2 ] || fail "slot wait: RSI_NO_HEAVY fails closed before any slot or walk: exit $RC, wanted 2"
[ -s "$OUT12/UNAVAILABLE" ] || fail "slot wait: RSI_NO_HEAVY fails closed before any slot or walk: no UNAVAILABLE marker"
grep -qi 'heavy slot\|machine-wide' "$OUT12/UNAVAILABLE" \
  || fail "slot wait: RSI_NO_HEAVY fails closed before any slot or walk: marker does not name the heavy slot: $(cat "$OUT12/UNAVAILABLE")"
[ ! -e "$T/walk12.heavy" ] || fail "slot wait: RSI_NO_HEAVY fails closed before any slot or walk: heavy.sh was reached"
[ ! -e "$T/walk12.ran" ] || fail "slot wait: RSI_NO_HEAVY fails closed before any slot or walk: the walker ran"
[ "$EL" -le 3 ] || fail "slot wait: RSI_NO_HEAVY fails closed before any slot or walk: took ${EL}s, the refusal waited"
pass "slot wait: RSI_NO_HEAVY fails closed before any slot or walk"

# 13. a fast non-zero walker exit is the walker's own answer: the composition
#     must not turn it into unavailable.
OUT13="$T/o13"; mkdir -p "$OUT13"
STUB_SLOT_WAIT=0 RSI_WALK_MAX_S=10 \
  bash "$SLOT_SEAM" --walk-probe "$OUT13" bash -c 'exit 3' >/dev/null 2>&1
RC=$?
[ "$RC" -eq 3 ] || fail "slot wait: a fast non-zero walker exit keeps its own status: exit $RC, wanted 3"
[ ! -e "$OUT13/UNAVAILABLE" ] || fail "slot wait: a fast non-zero walker exit keeps its own status: mislabelled as unavailable"
pass "slot wait: a fast non-zero walker exit keeps its own status"

echo "all cases passed"
