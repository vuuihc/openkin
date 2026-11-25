#!/bin/bash
# test-lane-orphan-reap.sh — a killed lane must reap what its worker left behind
# even when that process is no longer in the worker's process tree.
#
# Incident (2026-11-25): a lane worker ran `expo start`, which called setsid and
# reparented to launchd, and booted two iOS simulators owned by launchd too.
# cleanup()'s pgid kill and pgrep -P walk only reach the worker's own tree, so
# all three survived the watchdog and held the host under load for hours.
#
# Hermetic: real processes in a temp dir, stubbed lsof/xcrun on PATH, no Xcode,
# no network. Sources common.sh with RSI_CTRL redirected so STATE stays in the
# temp dir. Prints "ok: <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
COMMON="$REPO/rsi/runtime/common.sh"
LANE="$REPO/rsi/runtime/lane.sh"

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

mkdir -p "$T/ctrl/rsi/state" "$T/wt/sub" "$T/wt-other" "$T/bin"

# run <body> — evaluate under common.sh with RSI_CTRL at the temp control root.
# common.sh exports its own PATH, so stubs go in through RSI_TEST_BIN, which the
# snippet prepends after sourcing.
run() { RSI_CTRL="$T/ctrl" RSI_TEST_BIN="$T/bin" bash -c 'source "$1"; export PATH="$RSI_TEST_BIN:$PATH"; shift; body="$1"; shift; eval "$body"' _ "$COMMON" "$@"; }

alive() { kill -0 "$1" 2>/dev/null; }
# gone <pid> — dead or an unreaped zombie (kill -0 still answers on a zombie).
gone() {
  alive "$1" || return 0
  ps -o stat= -p "$1" 2>/dev/null | grep -q Z
}
# wait_gone <pid> — poll up to ~3s; TERM->KILL inside rsi_kill_tree takes ~0.3s.
wait_gone() { for _ in $(seq 1 30); do gone "$1" && return 0; sleep 0.1; done; return 1; }

# spawn_orphan <dir> <pidfile> — start a setsid'd sleeper with cwd <dir> whose
# launcher exits immediately, so it reparents out of our tree like `expo start`.
spawn_orphan() {
  ( cd "$1" && python3 -c 'import os,time,sys; os.setsid(); print(os.getpid(), file=open(sys.argv[1],"w")); time.sleep(300)' "$2" & ) 
  for _ in $(seq 1 50); do [ -s "$2" ] && return 0; sleep 0.1; done
  return 1
}

# 1. A detached process whose cwd is under the worktree is reaped by cwd sweep.
spawn_orphan "$T/wt/sub" "$T/orphan.pid" || fail "case 1: orphan did not start"
ORPHAN="$(cat "$T/orphan.pid")"; PIDS="$PIDS $ORPHAN"
alive "$ORPHAN" || fail "case 1: orphan died before the sweep"
run 'rsi_reap_cwd "$1"' "$T/wt" 2>"$T/e1"
wait_gone "$ORPHAN" || fail "case 1: detached process survived rsi_reap_cwd"
grep -Eq "reaped [1-9][0-9]* process\(es\) under $T/wt" "$T/e1" || fail "case 1: missing reap line: $(cat "$T/e1")"
pass "a setsid'd process under the worktree is reaped by cwd"

# 2. A sibling whose name shares the prefix ($T/wt-other) survives: the boundary
#    is "dir/", not a bare string prefix.
spawn_orphan "$T/wt-other" "$T/sib.pid" || fail "case 2: sibling did not start"
SIB="$(cat "$T/sib.pid")"; PIDS="$PIDS $SIB"
run 'rsi_reap_cwd "$1"' "$T/wt" 2>/dev/null
sleep 1
alive "$SIB" || fail "case 2: $T/wt-other was reaped — prefix boundary broken"
kill -KILL "$SIB" 2>/dev/null
pass "a sibling dir sharing the name prefix is not reaped"

# 3. A symlinked dir argument still matches (realpath on both sides).
ln -s "$T/wt" "$T/wt-link"
spawn_orphan "$T/wt/sub" "$T/orphan2.pid" || fail "case 3: orphan did not start"
ORPHAN2="$(cat "$T/orphan2.pid")"; PIDS="$PIDS $ORPHAN2"
run 'rsi_reap_cwd "$1"' "$T/wt-link" 2>/dev/null
wait_gone "$ORPHAN2" || fail "case 3: orphan survived a symlinked dir argument"
pass "a symlinked dir argument resolves and still reaps"

# 4. A hanging lsof prints "no verdict" and returns 0 — cleanup never blocks.
cat > "$T/bin/lsof" <<'SH'
#!/bin/bash
sleep 60
SH
chmod +x "$T/bin/lsof"
start=$(date +%s)
run 'rsi_reap_cwd "$1"' "$T/wt" 2>"$T/e4" && rc4=0 || rc4=$?
elapsed=$(( $(date +%s) - start ))
[ "$rc4" -eq 0 ] || fail "case 4: rc=$rc4, must return 0 on lsof failure"
[ "$elapsed" -lt 40 ] || fail "case 4: sweep ran ${elapsed}s — the 20s bound did not fire"
grep -q "orphan sweep: no verdict" "$T/e4" || fail "case 4: missing no-verdict line: $(cat "$T/e4")"
pass "a hanging lsof is bounded and reports no verdict"
rm -f "$T/bin/lsof"

# 5. Shutdown touches only simulators the lane booted: before-file has UDID-A,
#    the fake xcrun reports A and B booted, only B is shut down.
cat > "$T/bin/xcrun" <<'SH'
#!/bin/bash
if [ "$1 $2" = "simctl list" ]; then
  cat <<'JSON'
{"devices":{"r":[{"udid":"UDID-A","state":"Booted"},{"udid":"UDID-B","state":"Booted"},{"udid":"UDID-C","state":"Shutdown"}]}}
JSON
  exit 0
fi
echo "$@" >> "$XCRUN_LOG"
exit 0
SH
chmod +x "$T/bin/xcrun"
echo UDID-A > "$T/before.sims"
XCRUN_LOG="$T/xcrun.log" run 'rsi_sim_shutdown_new "$1"' "$T/before.sims" 2>"$T/e5"
grep -qx 'simctl shutdown UDID-B' "$T/xcrun.log" || fail "case 5: UDID-B not shut down: $(cat "$T/xcrun.log" 2>/dev/null)"
! grep -q 'UDID-A' "$T/xcrun.log" || fail "case 5: UDID-A (already booted) was shut down"
! grep -q 'UDID-C' "$T/xcrun.log" || fail "case 5: UDID-C (not booted) was shut down"
grep -q 'shut down 1 simulator(s)' "$T/e5" || fail "case 5: missing shutdown line: $(cat "$T/e5")"
pass "only newly booted simulators are shut down"
rm -f "$T/bin/xcrun"

# 6. No xcrun on PATH: rsi_sim_booted prints nothing and returns 0.
out6="$(run 'PATH=/usr/bin:/bin; rsi_sim_booted')"
[ -z "$out6" ] || fail "case 6: rsi_sim_booted printed without xcrun: $out6"
pass "rsi_sim_booted is silent when xcrun is absent"

# 7. Wiring: lane.sh snapshots sims-before before the worker launch and cleanup
#    calls rsi_reap_cwd "$WT" and rsi_sim_shutdown_new.
grep -q 'rsi_sim_booted > "$STATE/lanes/$N.sims-before"' "$LANE" \
  || fail "case 7: lane.sh does not snapshot booted simulators"
sims_line=$(grep -n 'sims-before"' "$LANE" | head -1 | cut -d: -f1)
wstart_line=$(grep -n 'W_START=$(date +%s)' "$LANE" | head -1 | cut -d: -f1)
[ "$sims_line" -lt "$wstart_line" ] || fail "case 7: sims-before is written after the worker launch"
grep -q 'rsi_reap_cwd "$WT"' "$LANE" || fail "case 7: cleanup never calls rsi_reap_cwd \"\$WT\""
grep -q 'rsi_sim_shutdown_new "$STATE/lanes/$N.sims-before"' "$LANE" \
  || fail "case 7: cleanup never calls rsi_sim_shutdown_new"
pass "lane.sh wires the snapshot, the cwd sweep and the sim shutdown"

echo "lane orphan reap: $n/$n cases passed"
