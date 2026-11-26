#!/bin/bash
# test-lane-orphan-reap.sh — a killed lane must reap what its worker left behind
# even when that process is no longer in the worker's process tree.
#
# Incident (2026-11-25): a lane worker ran `expo start`, which called setsid and
# reparented to launchd, and booted two iOS simulators owned by launchd too.
# cleanup()'s pgid kill and pgrep -P walk only reach the worker's own tree, so
# all three survived the watchdog and held the host under load for hours.
#
# Hermetic: real processes in a temp dir, stubbed lsof/xcrun on PATH, and the
# "xcrun absent" case run against an empty PATH directory — the host's Xcode and
# CoreSimulator are never queried. No network. Sources common.sh with RSI_CTRL
# redirected so STATE stays in the temp dir. Prints "ok: <case>" per case and
# exits non-zero on the first failure.
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
printf 'UDID-A\n#complete\n' > "$T/before.sims"
XCRUN_LOG="$T/xcrun.log" run 'rsi_sim_shutdown_new "$1"' "$T/before.sims" 2>"$T/e5"
grep -qx 'simctl shutdown UDID-B' "$T/xcrun.log" || fail "case 5: UDID-B not shut down: $(cat "$T/xcrun.log" 2>/dev/null)"
! grep -q 'UDID-A' "$T/xcrun.log" || fail "case 5: UDID-A (already booted) was shut down"
! grep -q 'UDID-C' "$T/xcrun.log" || fail "case 5: UDID-C (not booted) was shut down"
grep -q 'shut down 1 simulator(s)' "$T/e5" || fail "case 5: missing shutdown line: $(cat "$T/e5")"
pass "only newly booted simulators are shut down"

# 5b. A snapshot without the '#complete' marker is a failed query, not an empty
#     host: shutdown must leave every simulator alone instead of killing the
#     ones that predate the lane.
printf 'UDID-A\n' > "$T/before-incomplete.sims"
: > "$T/xcrun.log"
XCRUN_LOG="$T/xcrun.log" run 'rsi_sim_shutdown_new "$1"' "$T/before-incomplete.sims" 2>"$T/e5b"
[ ! -s "$T/xcrun.log" ] || fail "case 5b: shutdown ran on an incomplete snapshot: $(cat "$T/xcrun.log")"
! grep -q 'shut down' "$T/e5b" || fail "case 5b: reported a shutdown from an incomplete snapshot"
pass "an incomplete simulator snapshot shuts nothing down"
rm -f "$T/bin/xcrun"

# 6. No xcrun on PATH — an empty dir, not /usr/bin where the host may have it:
#    rsi_sim_booted prints nothing and returns 0.
mkdir -p "$T/empty"
out6="$(run 'PATH="$1"; rsi_sim_booted' "$T/empty")"
[ -z "$out6" ] || fail "case 6: rsi_sim_booted printed without xcrun: $out6"
pass "rsi_sim_booted is silent when xcrun is absent"

# 6b. A failing query returns non-zero with no output, so lane.sh can mark the
#     snapshot incomplete instead of reading it as "nothing booted".
cat > "$T/bin/xcrun" <<'SH'
#!/bin/bash
exit 1
SH
chmod +x "$T/bin/xcrun"
out6b="$(run 'rsi_sim_booted' 2>/dev/null)" && rc6b=0 || rc6b=$?
[ "$rc6b" -ne 0 ] || fail "case 6b: a failed xcrun query returned 0"
[ -z "$out6b" ] || fail "case 6b: a failed xcrun query printed: $out6b"
pass "a failed simulator query is distinguishable from an empty one"
rm -f "$T/bin/xcrun"

# 7. Wiring: lane.sh snapshots sims-before before the worker launch, marks the
#    snapshot complete, calls rsi_reap_cwd "$WT", consults the live-lane
#    interlock and calls rsi_sim_shutdown_new.
grep -q 'rsi_sim_booted > "$STATE/lanes/$N.sims-before"' "$LANE" \
  || fail "case 7: lane.sh does not snapshot booted simulators"
grep -q "echo '#complete' >> \"\$STATE/lanes/\$N.sims-before\"" "$LANE" \
  || fail "case 7: lane.sh does not mark the snapshot complete"
sims_line=$(grep -n 'rsi_sim_booted > .*sims-before' "$LANE" | head -1 | cut -d: -f1)
wstart_line=$(grep -n 'W_START=$(date +%s)' "$LANE" | head -1 | cut -d: -f1)
[ "$sims_line" -lt "$wstart_line" ] || fail "case 7: sims-before is written after the worker launch"
grep -q 'rsi_reap_cwd "$WT"' "$LANE" || fail "case 7: cleanup never calls rsi_reap_cwd \"\$WT\""
grep -q 'other_live="$(rsi_other_live_lane "$LK")"' "$LANE" \
  || fail "case 7: cleanup never consults the live-lane interlock"
grep -q 'left new simulators booted' "$LANE" \
  || fail "case 7: cleanup never reports simulators left for a live lane"
grep -q 'rsi_sim_shutdown_new "$STATE/lanes/$N.sims-before"' "$LANE" \
  || fail "case 7: cleanup never calls rsi_sim_shutdown_new"
pass "lane.sh wires the snapshot, the cwd sweep and the sim shutdown"

# 8. The live-lane interlock: only another lock whose pid is alive counts, so a
#    leftover lock from a dead lane does not keep this lane's simulators up.
mkdir -p "$T/lanes/1.lock" "$T/lanes/2.lock" "$T/lanes/3.lock"
echo $$ > "$T/lanes/2.lock/pid"
( exit 0 ) & dead=$!
wait "$dead" 2>/dev/null
echo "$dead" > "$T/lanes/3.lock/pid"
other="$(run 'rsi_other_live_lane "$1"' "$T/lanes/1.lock")"
[ "$other" = "2.lock" ] || fail "case 8: live-lane scan returned '$other', want 2.lock"
rm -f "$T/lanes/2.lock/pid"
other="$(run 'rsi_other_live_lane "$1"' "$T/lanes/1.lock")"
[ -z "$other" ] || fail "case 8: a dead lane's lock still counts: $other"
pass "only a live other lane's lock holds the simulator shutdown"

# 9. A successful lane must release host resources too. #724 covered only
#    cleanup()'s failure path: on a `done` lane `rm -rf "$LK"; trap - EXIT`
#    disarmed cleanup before it ran, stranding the worker's simulators and the
#    sims-before snapshot (2026-11-25: two simulators kept load near 100-600).
#    Runs lane.sh's own lane_release_host, extracted by awk so it cannot drift.
RELEASE_FN="$(awk '/^lane_release_host\(\) \{/,/^\}/' "$LANE")"
[ -n "$RELEASE_FN" ] || fail "case 9: lane.sh has no lane_release_host"
mkdir -p "$T/state9/lanes/9.lock" "$T/wt9"
cat > "$T/bin/xcrun" <<'SH'
#!/bin/bash
if [ "$1 $2" = "simctl list" ]; then
  cat <<'JSON'
{"devices":{"r":[{"udid":"UDID-A","state":"Booted"},{"udid":"UDID-B","state":"Booted"}]}}
JSON
  exit 0
fi
echo "$@" >> "$XCRUN_LOG"
exit 0
SH
chmod +x "$T/bin/xcrun"
printf 'UDID-A\n#complete\n' > "$T/state9/lanes/9.sims-before"
: > "$T/xcrun.log"
XCRUN_LOG="$T/xcrun.log" run '
  eval "$1"
  STATE="$2"; N=9; WT="$3"; LK="$STATE/lanes/$N.lock"
  echo $$ > "$LK/pid"
  lane_release_host
' "$RELEASE_FN" "$T/state9" "$T/wt9" 2>"$T/e9"
grep -qx 'simctl shutdown UDID-B' "$T/xcrun.log" \
  || fail "case 9: lane-booted simulator not shut down: $(cat "$T/xcrun.log" 2>/dev/null) $(cat "$T/e9")"
! grep -q 'UDID-A' "$T/xcrun.log" || fail "case 9: a pre-existing simulator was shut down"
[ ! -f "$T/state9/lanes/9.sims-before" ] || fail "case 9: sims-before not removed"
rm -f "$T/bin/xcrun"
pass "a lane release shuts down simulators booted after the snapshot and removes sims-before"

# 10. Wiring: the success path releases host resources while the lane is still
#     advertised as running — before `finish done`, which makes lanes.py report
#     the lane idle (merge.sh then stops skipping this PR and can start a
#     verifier here while rsi_reap_cwd sweeps; a pulse can claim the still-locked
#     lane for 25 min) — and before `rm -rf "$LK"; trap - EXIT`; cleanup() still
#     calls it.
#     `trap - EXIT` must stay: cleanup's pgrep -P kill loop would otherwise kill
#     the nohup merge/pulse handoff launched right after.
cleanup_ln="$(grep -n '^cleanup()' "$LANE" | cut -d: -f1)"
awk -v c="$cleanup_ln" 'NR > c && /^  lane_release_host$/ { found = 1; exit } END { exit !found }' "$LANE" \
  || fail "case 10: cleanup no longer calls lane_release_host"
unlock_ln="$(grep -n '^rm -rf "$LK"; trap - EXIT$' "$LANE" | cut -d: -f1)"
call_ln="$(grep -n '^lane_release_host$' "$LANE" | cut -d: -f1)"
done_ln="$(grep -n '^finish done ' "$LANE" | cut -d: -f1)"
[ -n "$call_ln" ] && [ -n "$done_ln" ] && [ -n "$unlock_ln" ] \
  && [ "$call_ln" -lt "$done_ln" ] && [ "$done_ln" -lt "$unlock_ln" ] \
  || fail "case 10: success path must release host resources before finish done (lane stays running during the sweep) and before dropping the lock"
pass "lane.sh releases host resources on the success path before finish done and before dropping the lock"

# 11. The shell gate job runs this suite, so a regression cannot land green.
grep -q 'bash rsi/runtime/tests/test-lane-orphan-reap.sh || return 1' "$REPO/scripts/check.sh" \
  || fail "case 11: scripts/check.sh does not run this suite"
pass "scripts/check.sh runs this suite"

echo "lane orphan reap: $n/$n cases passed"
