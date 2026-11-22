#!/bin/bash
# test-gate-no-verdict.sh — a gate that cannot run must say "no verdict", never "your change failed".
#
# 2026-11-22: two sendbacks in one night were the machine, not the branch.
# contract-story-012159 and approval-strip-reading-021235 were both 20 lines of
# `cp: … No space left on device` from a test that never ran, reported to the worker as
# `GATE_RESULT=FAIL: check` and billed as PR rework. AGENTS.md item 13 is explicit: a path that
# cannot produce a verdict reports "no verdict" instead of a fabricated one.
#
# `df` is not a usable precondition: APFS reported 18 GB available on this machine while cp was
# failing with ENOSPC in the same state (it counts purgeable space). The guard is therefore a
# probe write in $TMPDIR plus a scan of the failing step's own log for the ENOSPC marker.
#
# Hermetic: temp dirs, fake logs, a stub scripts/check.sh in a temp git repo, no network, no
# worktree, no npm, no model. The gate cases run the real gate.sh only far enough to decide:
# the probe fails before any step, and the step case runs a stub check.sh that cannot recurse.
#
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
GATE="$RUNTIME/gate.sh"
MERGE="$RUNTIME/merge.sh"
T="$(mktemp -d)"
trap 'chmod -R u+rwX "$T" 2>/dev/null; rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
export GIT_AUTHOR_NAME=gate-nv-test GIT_AUTHOR_EMAIL=gate-nv@example.com
export GIT_COMMITTER_NAME=gate-nv-test GIT_COMMITTER_EMAIL=gate-nv@example.com
export GIT_TERMINAL_PROMPT=0
GIT=/usr/bin/git
mkdir -p "$T/ctrl/rsi/state"
export RSI_CTRL="$T/ctrl"
RC=0; OUT=""

# The decision helpers, callable without running a gate: this suite must not recurse through
# check.sh (the gate runs check.sh, and check.sh runs this suite).
source "$RUNTIME/gate-env.sh"

fail() { echo "FAIL $*" >&2; exit 1; }
run_cmd() { # <cmd...> -> RC, OUT
  "$@" > "$T/out" 2>&1; RC=$?; OUT="$(cat "$T/out")"
}

# The exact failure shape from state/sendback/done/contract-story-012159.md: a copy that never
# happened because the volume was full, followed by the test's own misleading assertion.
ENOSPC_LINE='cp: /var/folders/4_/xxxx/T/tmp.rvevPv0Mef/bootstrap-fail/rsi/runtime/merge.sh: No space left on device'

# 1. The failing step's own log is the evidence: it carries the OS marker from the sendback.
test_gate_env_failure_detects_enospc_in_a_step_log() {
  local log="$T/enospc.log" r
  {
    echo "FAIL shell-test"
    echo "$ENOSPC_LINE"
    echo "FAIL bootstrap-failure-reported: stderr does not name merge: "
  } > "$log"
  r="$(gate_env_failure_in_log check "$log")" \
    || fail "enospc: a step log with 'No space left on device' was classified as a real failure"
  case "$r" in *check*) ;; *) fail "enospc: reason '$r' does not name the step" ;; esac
  case "$r" in *"no space left on device"*) ;; *) fail "enospc: reason '$r' does not name the cause" ;; esac
  # The bare errno spelling is the same environment failure.
  printf 'write error: ENOSPC\n' > "$log"
  gate_env_failure_in_log lint "$log" > /dev/null \
    || fail "enospc: a bare ENOSPC marker was not detected"
}

# 2. A normal red test log keeps today's FAIL verdict, byte for byte. No marker, no no-verdict.
test_gate_env_failure_ignores_a_red_test_log() {
  local log="$T/red.log"
  {
    echo "FAIL  src/design/tokens.test.ts > focus ring uses the outline token"
    echo "AssertionError: expected 'outline-none' to contain 'outline-kin-focus-ring'"
    echo "--- FAIL: TestTaskList (0.02s)"
    echo "Test Files  1 failed (1)"
  } > "$log"
  if gate_env_failure_in_log test "$log" > "$T/red.out"; then
    fail "red: an ordinary failing-test log was classified as an environment failure"
  fi
  [ -s "$T/red.out" ] && fail "red: the classifier printed a reason for a normal red log"
  # A FAIL line that only QUOTES the marker (this suite's own fail() text, or a test that dumps a
  # gate log) is test-runner output, not the machine: it must stay a real red.
  {
    echo "FAIL gate-nv: a step log with 'No space left on device' was classified as a real failure"
    echo "FAIL step-red: exit 1, want 1 (GATE_RESULT=FAIL: check ... No space left on device ...)"
    echo "AssertionError: expected 'no space left on device' to be absent"
    echo "✗ ENOSPC was detected in a log that only quoted it"
    echo "× --- FAIL: TestX (ENOSPC)"
  } > "$T/red-quoted.log"
  if gate_env_failure_in_log check "$T/red-quoted.log" > "$T/red-quoted.out"; then
    fail "red-quoted: a log quoting the marker in test output was classified as an environment failure"
  fi
  [ -s "$T/red-quoted.out" ] && fail "red-quoted: the classifier printed a reason for a quoted marker"
  return 0
}

# 3. A probe that writes, reads back and deletes: the only honest precondition on APFS.
test_gate_probe_write_fails_on_an_unwritable_target() {
  local ro="$T/ro" rw="$T/rw"
  mkdir -p "$ro" "$rw"
  chmod 500 "$ro"
  if gate_disk_probe "$ro"; then
    fail "probe: an unwritable target passed the write probe"
  fi
  case "$GATE_PROBE_REASON" in
    *"$ro"*) ;;
    *) fail "probe: reason '$GATE_PROBE_REASON' does not name the target" ;;
  esac
  gate_disk_probe "$rw" || fail "probe: a writable target failed ($GATE_PROBE_REASON)"
  [ -z "$(ls -A "$rw")" ] || fail "probe: left a file behind: $(ls -A "$rw")"
  chmod 700 "$ro"
  return 0
}

# 4. The end-to-end probe decision: one NO_VERDICT line, exit 3, and no PASS/FAIL line.
test_gate_prints_no_verdict_and_exits_three_when_the_probe_fails() {
  local wt="$T/wt-probe" ro="$T/ro-probe"
  mkdir -p "$wt" "$ro"
  chmod 500 "$ro"
  ( cd "$wt" && TMPDIR="$ro" bash "$GATE" "$wt" ) > "$T/out-probe" 2>&1
  local rc=$?
  chmod 700 "$ro"
  [ "$rc" -eq 3 ] || fail "probe-e2e: exit $rc, want 3 ($(tr '\n' ' ' < "$T/out-probe"))"
  [ "$(grep -c '^GATE_RESULT=NO_VERDICT: ' "$T/out-probe")" -eq 1 ] \
    || fail "probe-e2e: want exactly one 'GATE_RESULT=NO_VERDICT: ' line: $(tr '\n' ' ' < "$T/out-probe")"
  if grep -qE '^GATE_RESULT=(PASS|FAIL)' "$T/out-probe"; then
    fail "probe-e2e: printed a PASS/FAIL verdict on a run that could not judge"
  fi
  grep -q 'probe write failed' "$T/out-probe" \
    || fail "probe-e2e: the no-verdict reason does not say the probe failed"
  return 0
}

# 5. The one place a gate log is classified for a union batch: NO_VERDICT is its own arm,
# never FAIL (a batch would bisect and send back a member for the machine's full disk).
test_batch_gate_verdict_reads_no_verdict_not_fail() {
  local log="$T/nv-batch.log"
  printf '%s\n' 'GATE_RESULT=NO_VERDICT: disk: probe write failed in /tmp/x' > "$log"
  run_cmd env RSI_CTRL="$T/ctrl" bash "$MERGE" --batch-verdict-check "$log" 3
  [ "$RC" -eq 0 ] || fail "batch: seam exited $RC ($OUT)"
  case "$OUT" in
    NO_VERDICT:*) ;;
    *) fail "batch: classified '$OUT', want the NO_VERDICT arm" ;;
  esac
  case "$OUT" in FAIL:*) fail "batch: read a no-verdict log as '$OUT'" ;; esac
  # A real red log keeps today's classification byte for byte.
  printf '%s\n' 'GATE_RESULT=FAIL: check' > "$log"
  run_cmd env RSI_CTRL="$T/ctrl" bash "$MERGE" --batch-verdict-check "$log" 1
  [ "$RC" -eq 0 ] || fail "batch: red seam exited $RC ($OUT)"
  [ "$OUT" = "FAIL:check" ] || fail "batch: red log classified '$OUT', want FAIL:check"
  return 0
}

# 6. The merge lane retries a no-verdict cycle: no sendback, no attempt burned, exit 0.
test_merge_no_verdict_path_writes_no_sendback() {
  # merge.sh's $STATE is $RSI_CTRL/rsi/state, so the assertions must observe THAT dir: a state
  # tree the seam never reads would keep them green even if the skip wrote a sendback.
  local st="$T/ctrl/rsi/state" log="$T/nv-merge.log"
  rm -rf "$st"; mkdir -p "$st/merge" "$st/sendback"
  echo 1 > "$st/merge/t.attempts"
  printf '%s\n' \
    'GATE_RESULT=NO_VERDICT: disk: no space left on device during check' > "$log"
  run_cmd env RSI_CTRL="$T/ctrl" bash "$MERGE" --no-verdict-check 42 t "$log"
  [ "$RC" -eq 0 ] || fail "merge-nv: exit $RC, want 0 ($OUT)"
  case "$OUT" in
    *"no attempt burned"*) ;;
    *) fail "merge-nv: '$OUT' does not say the cycle is a retry, not a sendback" ;;
  esac
  [ -z "$(ls -A "$st/sendback")" ] \
    || fail "merge-nv: wrote a sendback: $(ls -A "$st/sendback")"
  [ "$(cat "$st/merge/t.attempts")" = 1 ] \
    || fail "merge-nv: attempts moved to $(cat "$st/merge/t.attempts")"
  # A real red log is still a verdict: the guard must not swallow FAIL.
  printf '%s\n' 'GATE_RESULT=FAIL: check' > "$log"
  run_cmd env RSI_CTRL="$T/ctrl" bash "$MERGE" --no-verdict-check 42 t "$log"
  [ "$RC" -eq 1 ] || fail "merge-nv: a FAIL log exited $RC, want 1 (it must reach the judge path)"
  return 0
}

# 7. A step that fails mid-run on ENOSPC prints no-verdict instead of FAIL:<steps>. The whole
# gate.sh runs, but only against a temp repo whose check.sh is a stub, so nothing recurses.
test_gate_step_enospc_prints_no_verdict() {
  local repo="$T/repo-step" out="$T/out-step" rc
  rm -rf "$repo"; mkdir -p "$repo/scripts"
  cat > "$repo/scripts/check.sh" <<'SH'
#!/bin/bash
# The exact shape of the 2026-11-22 sendback: the copy never happened, then a test assertion
# that reads as the PR's fault.
echo "$0: line 3: /tmp/tmp.rvevPv0Mef/err: No space left on device" >&2
echo "FAIL shell-test" >&2
echo "FAIL bootstrap-failure-reported: stderr does not name merge: " >&2
exit 1
SH
  chmod +x "$repo/scripts/check.sh"
  echo base > "$repo/README.md"
  $GIT init -q -b main "$repo" || fail "step-e2e: git init"
  $GIT -C "$repo" add -A || fail "step-e2e: git add"
  $GIT -C "$repo" commit -qm base || fail "step-e2e: git commit"
  $GIT -C "$repo" update-ref refs/remotes/origin/main HEAD || fail "step-e2e: origin/main"
  ( cd "$repo" && RSI_CTRL="$T/ctrl" bash "$GATE" "$repo" ) > "$out" 2>&1
  rc=$?
  [ "$rc" -eq 3 ] || fail "step-e2e: exit $rc, want 3 ($(tr '\n' ' ' < "$out"))"
  [ "$(grep -c '^GATE_RESULT=NO_VERDICT: ' "$out")" -eq 1 ] \
    || fail "step-e2e: want exactly one 'GATE_RESULT=NO_VERDICT: ' line: $(tr '\n' ' ' < "$out")"
  grep -q '^GATE_RESULT=NO_VERDICT: .*check' "$out" \
    || fail "step-e2e: the no-verdict reason does not name the step"
  if grep -qE '^GATE_RESULT=(PASS|FAIL)' "$out"; then
    fail "step-e2e: printed a PASS/FAIL verdict on a step the machine could not run"
  fi
  return 0
}

# 8. The other half of the contract: a red test log with no marker still fails the gate, so the
# no-verdict path can never become a blanket amnesty.
test_gate_step_red_test_still_fails() {
  local repo="$T/repo-red" out="$T/out-red" rc
  rm -rf "$repo"; mkdir -p "$repo/scripts"
  cat > "$repo/scripts/check.sh" <<'SH'
#!/bin/bash
echo "FAIL  src/design/tokens.test.ts > focus ring uses the outline token" >&2
echo "AssertionError: expected 'outline-none' to contain 'outline-kin-focus-ring'" >&2
exit 1
SH
  chmod +x "$repo/scripts/check.sh"
  echo base > "$repo/README.md"
  $GIT init -q -b main "$repo" || fail "step-red: git init"
  $GIT -C "$repo" add -A || fail "step-red: git add"
  $GIT -C "$repo" commit -qm base || fail "step-red: git commit"
  $GIT -C "$repo" update-ref refs/remotes/origin/main HEAD || fail "step-red: origin/main"
  ( cd "$repo" && RSI_CTRL="$T/ctrl" bash "$GATE" "$repo" ) > "$out" 2>&1
  rc=$?
  [ "$rc" -eq 1 ] || fail "step-red: exit $rc, want 1 ($(tr '\n' ' ' < "$out"))"
  grep -qE '^GATE_RESULT=FAIL: check( |$)' "$out" \
    || fail "step-red: want GATE_RESULT=FAIL: check, got: $(grep '^GATE_RESULT' "$out" | tr '\n' ' ')"
  if grep -q '^GATE_RESULT=NO_VERDICT' "$out"; then
    fail "step-red: an ordinary red test was excused as no-verdict"
  fi
  return 0
}

# 9. A bisect run that cannot judge (exit 3) attributes nothing. At a singleton the old read
# printed CULPRIT and batch_run sent that member back for the machine's own failure.
test_bisect_no_verdict_is_not_a_culprit() {
  local repo="$T/repo-bisect" ctrl="$T/ctrl-bisect" base h1 h2 out
  rm -rf "$repo" "$ctrl"; mkdir -p "$repo/scripts" "$ctrl/rsi/runtime"
  # gate.sh is invoked from the runtime under merge.sh's RSI_CTRL; stage only the files a --only
  # check run sources, so this stays hermetic without copying runtime/runs.
  cp "$RUNTIME/common.sh" "$RUNTIME/node-stamp.sh" "$RUNTIME/gate-env.sh" "$RUNTIME/gate.sh" \
    "$ctrl/rsi/runtime/" || fail "bisect-nv: cannot stage the runtime"
  cat > "$repo/scripts/check.sh" <<'SH'
#!/bin/bash
# The machine's own failure text on a line that is not test-runner output: gate.sh reports
# GATE_RESULT=NO_VERDICT and exits 3.
echo "cp: /tmp/bisect: No space left on device" >&2
exit 1
SH
  chmod +x "$repo/scripts/check.sh"
  echo base > "$repo/README.md"
  $GIT init -q -b main "$repo" || fail "bisect-nv: git init"
  $GIT -C "$repo" add -A || fail "bisect-nv: git add"
  $GIT -C "$repo" commit -qm base || fail "bisect-nv: git commit"
  base="$($GIT -C "$repo" rev-parse HEAD)"
  $GIT -C "$repo" update-ref refs/remotes/origin/main HEAD
  $GIT -C "$repo" checkout -q -b rsi/nv1 main
  echo one > "$repo/one.txt"; $GIT -C "$repo" add -A; $GIT -C "$repo" commit -qm one
  h1="$($GIT -C "$repo" rev-parse HEAD)"
  $GIT -C "$repo" checkout -q -b rsi/nv2 main
  echo two > "$repo/two.txt"; $GIT -C "$repo" add -A; $GIT -C "$repo" commit -qm two
  h2="$($GIT -C "$repo" rev-parse HEAD)"
  $GIT -C "$repo" checkout -q main
  # Singleton: before the fix this printed CULPRIT <h1>, which batch_run sends back.
  out="$(RSI_CTRL="$ctrl" bash "$MERGE" --batch-bisect-check "$repo" "$base" check "$h1" 2>&1)"
  printf '%s\n' "$out" | grep -q '^NO_VERDICT' \
    || fail "bisect-nv: a run that could not judge did not print NO_VERDICT ($out)"
  printf '%s\n' "$out" | grep -q '^CULPRIT' \
    && fail "bisect-nv: blamed a member for the machine's own failure ($out)"
  # Two heads: the no-verdict union stops the branch instead of recursing into two more runs.
  out="$(RSI_CTRL="$ctrl" bash "$MERGE" --batch-bisect-check "$repo" "$base" check "$h1" "$h2" 2>&1)"
  [ "$(printf '%s\n' "$out" | grep -c '^NO_VERDICT')" -eq 1 ] \
    || fail "bisect-nv: want exactly one NO_VERDICT for a two-head bisect ($out)"
  printf '%s\n' "$out" | grep -q '^CULPRIT' \
    && fail "bisect-nv: a two-head no-verdict bisect blamed a member ($out)"
  return 0
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$1" || exit 1
  echo "PASS $1"
}

run test_gate_env_failure_detects_enospc_in_a_step_log
run test_gate_env_failure_ignores_a_red_test_log
run test_gate_probe_write_fails_on_an_unwritable_target
run test_gate_prints_no_verdict_and_exits_three_when_the_probe_fails
run test_batch_gate_verdict_reads_no_verdict_not_fail
run test_merge_no_verdict_path_writes_no_sendback
run test_gate_step_enospc_prints_no_verdict
run test_gate_step_red_test_still_fails
run test_bisect_no_verdict_is_not_a_culprit
echo ALL-PASS
