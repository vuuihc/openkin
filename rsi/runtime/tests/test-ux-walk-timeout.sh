#!/bin/bash
# test-ux-walk-timeout.sh — the UX walk must have a ceiling, and hitting it must
# be an honest "no verdict", not an infinite merge-lane wait and not a pass.
#
# Measured 2026-11-19: one UI PR's walk ran 40 minutes; merge.sh -> ux-gate.sh ->
# ux-walk.sh -> heavy.sh -> node was unbounded at every step, so from outside the
# lane nobody could tell slow from dead. The bound is now RSI_WALK_MAX_S (default
# 1800s) around the walker, with an outer RSI_UX_GATE_MAX_S (default 2400s) in
# merge.sh that maps exit 124 to "unavailable + cooldown, no sendback, not merged".
#
# This suite drives the build-free --timeout-probe seam in ux-walk.sh: no UI
# build, no daemon, no network. It proves three things a ceiling alone does not:
#   1. a command past the ceiling is reported unavailable (exit 2), never rc 0;
#   2. its descendants die with it (a killed heavy.sh used to orphan the node
#      walker, which kept driving Chromium behind the gate's back);
#   3. a fast non-zero exit stays the walker's own answer, so a real "could not
#      run" is not relabelled as a timeout.
# The last case pins merge.sh's wiring textually: the outer bound and the 124 ->
# unavailable mapping are what turn a wedged gate into a next-cycle retry.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WALK="$REPO/rsi/runtime/ux-walk.sh"
MERGE="$REPO/rsi/runtime/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

pass() { echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# A stub walker that leaves a live grandchild, the way heavy.sh leaves node:
# if the ceiling only kills the direct child, child.pid is still alive here.
cat > "$T/stub.sh" <<'SH'
#!/bin/bash
sleep 20 & echo $! > "$1/child.pid"
wait
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

# 2. under the ceiling: the command's own answer passes through
OUT2="$T/o2"; mkdir -p "$OUT2"
RSI_WALK_MAX_S=30 bash "$WALK" --timeout-probe "$OUT2" true >/dev/null 2>&1
[ $? -eq 0 ] || fail "control: a fast success did not exit 0"
[ ! -e "$OUT2/UNAVAILABLE" ] || fail "control: a fast success wrote UNAVAILABLE"
pass "control: a fast success is untouched"

# 3. a fast non-zero exit is not a timeout (the elapsed check, not just rc)
OUT3="$T/o3"; mkdir -p "$OUT3"
T0="$(date +%s)"
RSI_WALK_MAX_S=30 bash "$WALK" --timeout-probe "$OUT3" bash -c 'exit 3' >/dev/null 2>&1
RC=$?
EL=$(( $(date +%s) - T0 ))
[ "$RC" -eq 3 ] || fail "fast failure: expected rc 3, got $RC"
[ ! -e "$OUT3/UNAVAILABLE" ] || fail "fast failure: mislabelled as a timeout"
[ "$EL" -lt 10 ] || fail "fast failure: waited ${EL}s instead of returning"
pass "fast failure: keeps its own exit code, no timeout label"

# 4. wiring: the outer gate bound exists and 124 is not a pass
grep -q 'bounded_run "$GATE_MAX" bash "$RSI_DIR/runtime/ux-gate.sh"' "$MERGE" \
  || fail "wiring: merge.sh calls ux-gate.sh without bounded_run"
grep -q 'if \[ "$urc" -eq 124 \]' "$MERGE" \
  || fail "wiring: merge.sh does not map 124 to unavailable"
pass "wiring: merge.sh bounds the gate and maps 124 to unavailable"

echo "all cases passed"
