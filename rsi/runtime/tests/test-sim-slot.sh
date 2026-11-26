#!/bin/bash
# test-sim-slot.sh — one iOS simulator per lane at a time, machine-wide.
#
# Incident (2026-11-25): two RN worker lanes each booted an iOS simulator and
# ran maestro at the same time; the host went to load ~900 with 15 GB of swap
# on a 16 GB Mac. lane.sh already reaps leftover simulators on cleanup; this
# suite proves the xcrun shim prevents a second lane from booting while another
# live lane holds the slot.
#
# Hermetic: the real shim at rsi/runtime/shim/xcrun runs against a fake `xcrun`
# on a temp PATH that only logs its argv; the slot dir, lane pids (background
# `sleep`s) and state live under mktemp -d. No real simulators, no network.
# Prints "ok: <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SHIMDIR="$REPO/rsi/runtime/shim"
LANE="$REPO/rsi/runtime/lane.sh"
COMMON="$REPO/rsi/runtime/common.sh"

T="$(mktemp -d)"
PIDS=""
cleanup() {
  for p in $PIDS; do kill -KILL "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT

n=0
pass() { n=$((n + 1)); echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$T/bin" "$T/state" "$T/wt" "$T/ctrl/rsi/state"
SLOT="$T/state/.sim-slot"
LOG="$T/xcrun.log"
: > "$LOG"

# The fake real xcrun: records argv and exits 0. The shim strips its own dir
# from PATH to find this, so $T/bin must be on PATH alongside the shim dir.
cat > "$T/bin/xcrun" <<'SH'
#!/bin/bash
echo "$@" >> "$XCRUN_LOG"
exit 0
SH
chmod +x "$T/bin/xcrun"

# xc <env...> -- run a command through env with the shim dir first on PATH.
xc() { env PATH="$SHIMDIR:$T/bin:/usr/bin:/bin" XCRUN_LOG="$LOG" "$@"; }

# live_pid — a background sleeper standing in for a live lane pid. The sleep's
# stdout is closed so $(live_pid) does not wait on the pipe.
live_pid() { sleep 300 >/dev/null 2>&1 & echo $!; }
# dead_pid — a pid that has already exited.
dead_pid() { ( exit 0 ) & local p=$!; wait "$p" 2>/dev/null; echo "$p"; }

boots() { grep -c '^simctl boot' "$LOG" 2>/dev/null || echo 0; }

# a. A non-boot call passes straight through and creates no slot.
xc xcrun simctl list devices || fail "case a: simctl list failed"
grep -qx 'simctl list devices' "$LOG" || fail "case a: fake xcrun not called: $(cat "$LOG")"
[ ! -e "$SLOT" ] || fail "case a: slot created by a non-boot call"
pass "a non-boot xcrun call passes through without the slot"

# b. Outside a lane (RSI_LANE_PID unset — CEO, gate, a human shell) `simctl boot`
#    passes through too, even with a slot path configured.
xc RSI_SIM_SLOT="$SLOT" xcrun simctl boot UDID-0 || fail "case b: no-lane boot failed"
grep -qx 'simctl boot UDID-0' "$LOG" || fail "case b: fake xcrun not called"
[ ! -e "$SLOT" ] || fail "case b: slot created without RSI_LANE_PID"
pass "a boot with no lane pid passes through without the slot"

# c. Lane A (a live pid) boots: the slot is taken with A's pid and lane number.
A="$(live_pid)"; PIDS="$PIDS $A"
xc RSI_LANE_PID="$A" RSI_LANE_N=1 RSI_SIM_SLOT="$SLOT" xcrun simctl boot UDID-A \
  || fail "case c: lane A boot failed"
[ "$(cat "$SLOT/pid" 2>/dev/null)" = "$A" ] || fail "case c: slot pid is $(cat "$SLOT/pid" 2>/dev/null), want $A"
[ "$(cat "$SLOT/lane" 2>/dev/null)" = "1" ] || fail "case c: slot lane is $(cat "$SLOT/lane" 2>/dev/null), want 1"
grep -qx 'simctl boot UDID-A' "$LOG" || fail "case c: fake xcrun not called"
pass "a lane boot takes the slot under its own pid"

# d. Lane B (another live pid) boots while A holds the slot: it waits out
#    RSI_SIM_SLOT_WAIT, prints the one-line busy verdict to stderr and exits 75
#    without ever calling the real xcrun.
B="$(live_pid)"; PIDS="$PIDS $B"
before="$(boots)"
xc RSI_LANE_PID="$B" RSI_LANE_N=2 RSI_SIM_SLOT="$SLOT" RSI_SIM_SLOT_WAIT=2 \
   xcrun simctl boot UDID-B 2>"$T/eD" && fail "case d: busy boot returned 0" || rcD=$?
[ "$rcD" -eq 75 ] || fail "case d: rc=$rcD, want 75"
grep -qx "sim slot busy: lane 1 holds the simulator; no simulator evidence this run (no verdict)" "$T/eD" \
  || fail "case d: stderr is '$(cat "$T/eD")'"
[ "$(boots)" = "$before" ] || fail "case d: real xcrun was called while the slot was busy"
pass "a second live lane's boot waits, reports no verdict and exits 75"

# d2. A slot the (live) holder releases mid-wait lets the waiting lane through.
W="$(live_pid)"; PIDS="$PIDS $W"
rm -rf "$SLOT"; mkdir "$SLOT"; echo "$W" > "$SLOT/pid"; echo 3 > "$SLOT/lane"
W2="$(live_pid)"; PIDS="$PIDS $W2"
( sleep 2; rm -rf "$SLOT" ) & PIDS="$PIDS $!"
start=$(date +%s)
xc RSI_LANE_PID="$W2" RSI_LANE_N=4 RSI_SIM_SLOT="$SLOT" RSI_SIM_SLOT_WAIT=30 \
   xcrun simctl boot UDID-W || fail "case d2: waiting boot failed after release"
elapsed=$(( $(date +%s) - start ))
[ "$elapsed" -lt 25 ] || fail "case d2: boot took ${elapsed}s on a slot freed at ~2s"
grep -qx 'simctl boot UDID-W' "$LOG" || fail "case d2: real xcrun not called"
[ "$(cat "$SLOT/pid" 2>/dev/null)" = "$W2" ] || fail "case d2: slot not re-taken by the waiter"
pass "a lane waiting on the slot boots as soon as the holder releases it"

# e. A slot whose pid is dead is reclaimed: B boots without waiting.
kill -KILL "$W2" 2>/dev/null; wait "$W2" 2>/dev/null
E="$(live_pid)"; PIDS="$PIDS $E"
xc RSI_LANE_PID="$E" RSI_LANE_N=5 RSI_SIM_SLOT="$SLOT" RSI_SIM_SLOT_WAIT=2 \
   xcrun simctl boot UDID-E || fail "case e: reclaim boot failed"
[ "$(cat "$SLOT/pid" 2>/dev/null)" = "$E" ] || fail "case e: dead slot not reclaimed"
grep -qx 'simctl boot UDID-E' "$LOG" || fail "case e: real xcrun not called"
pass "a dead holder's slot is reclaimed"

# e2. A leftover slot with no pid file is a leftover, not a live lane.
rm -rf "$SLOT"; mkdir "$SLOT"
F="$(live_pid)"; PIDS="$PIDS $F"
xc RSI_LANE_PID="$F" RSI_LANE_N=6 RSI_SIM_SLOT="$SLOT" RSI_SIM_SLOT_WAIT=20 \
   xcrun simctl boot UDID-F || fail "case e2: pidless slot not reclaimed"
[ "$(cat "$SLOT/pid" 2>/dev/null)" = "$F" ] || fail "case e2: pidless slot not reclaimed"
pass "a pidless leftover slot is reclaimed"

# f. The holding lane boots again without waiting.
xc RSI_LANE_PID="$F" RSI_LANE_N=6 RSI_SIM_SLOT="$SLOT" RSI_SIM_SLOT_WAIT=2 \
   xcrun simctl boot UDID-F2 || fail "case f: same-lane re-boot failed"
grep -qx 'simctl boot UDID-F2' "$LOG" || fail "case f: real xcrun not called"
pass "the holding lane re-boots without waiting"
rm -rf "$SLOT"

# g. lane_release_host, extracted from lane.sh by awk so it cannot drift:
#    releases the slot when its pid file names the releaser, leaves it when a
#    different live pid owns it.
RELEASE_FN="$(awk '/^lane_release_host\(\) \{/,/^\}/' "$LANE")"
[ -n "$RELEASE_FN" ] || fail "case g: lane.sh has no lane_release_host"
mkdir -p "$SLOT"
RSI_CTRL="$T/ctrl" bash -c '
  source "$1"; eval "$2"
  STATE="$3"; N=7; WT="$4"; LK="$STATE/lanes/$N.lock"; mkdir -p "$LK"
  RSI_SIM_SLOT="$5"
  echo $$ > "$RSI_SIM_SLOT/pid"; echo 7 > "$RSI_SIM_SLOT/lane"
  lane_release_host
  [ ! -e "$RSI_SIM_SLOT" ] || exit 11
' _ "$COMMON" "$RELEASE_FN" "$T/state" "$T/wt" "$SLOT" \
  || fail "case g: lane_release_host left its own slot behind"
mkdir -p "$SLOT"
OTHER="$(live_pid)"; PIDS="$PIDS $OTHER"
echo "$OTHER" > "$SLOT/pid"; echo 9 > "$SLOT/lane"
RSI_CTRL="$T/ctrl" bash -c '
  source "$1"; eval "$2"
  STATE="$3"; N=7; WT="$4"; LK="$STATE/lanes/$N.lock"; mkdir -p "$LK"
  RSI_SIM_SLOT="$5"
  lane_release_host
  [ -e "$RSI_SIM_SLOT" ] || exit 12
' _ "$COMMON" "$RELEASE_FN" "$T/state" "$T/wt" "$SLOT" \
  || fail "case g: lane_release_host removed a slot another live lane owns"
[ "$(cat "$SLOT/pid")" = "$OTHER" ] || fail "case g: slot owner file was rewritten"
rm -rf "$SLOT"
pass "lane_release_host releases only a slot it owns"

# h. Wiring: lane.sh exports the lane pid, lane number and slot path before the
#    dispatch.sh worker launch, so the shim inside the worker can see them.
exp_line="$(grep -n 'export RSI_LANE_PID=\$\$ RSI_LANE_N=\$N RSI_SIM_SLOT="\$STATE/.sim-slot"' "$LANE" | head -1 | cut -d: -f1)"
[ -n "$exp_line" ] || fail "case h: lane.sh does not export RSI_LANE_PID/RSI_LANE_N/RSI_SIM_SLOT"
launch_line="$(grep -n 'dispatch.sh" worker' "$LANE" | head -1 | cut -d: -f1)"
[ -n "$launch_line" ] && [ "$exp_line" -lt "$launch_line" ] \
  || fail "case h: the slot env is exported after the worker launch"
grep -q 'rm -rf "$slot"' "$LANE" || fail "case h: lane.sh never releases the slot"
pass "lane.sh exports the slot env before the worker launch"

# i. The shell gate job runs this suite, so a regression cannot land green.
grep -q 'bash rsi/runtime/tests/test-sim-slot.sh || return 1' "$REPO/scripts/check.sh" \
  || fail "case i: scripts/check.sh does not run this suite"
pass "scripts/check.sh runs this suite"

echo "sim slot: $n/$n cases passed"
