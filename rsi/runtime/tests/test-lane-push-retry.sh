#!/bin/bash
# test-lane-push-retry.sh — a transient `git push` must not throw away a finished round.
#
# 2026-11-15 18:46 (#84) and 2026-11-24 21:09 (#693): a lane finished its round, passed every
# check, committed — and one TLS blip on `git push` made lane.sh record failed and abandon the
# work; each time a person found the commit, pushed the branch and opened the PR by hand.
#
# The trap in that incident: the server may have accepted the push before the connection died.
# A blind retry pushes the same commit again (harmless at the remote, but a second failure is
# indistinguishable from the first) and a retry that keeps failing hides that the branch already
# landed — so every retry looks at the remote head before pushing again, exactly as lane-pr.sh
# looks before it creates a PR.
#
# Hermetic: mktemp -d, a stub `git` passed to the helper as its first argument (no network), no
# real retry sleep; npm, go, node, curl and a bare `git` are booby traps (exit 97). Prints
# "lane push retry: N/N cases passed" and exits on the first failure.
# RSI_TEST_ONLY=<case name> runs one case (the mutant manifests name them one at a time).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
HELPER="$REPO/rsi/runtime/lane-push.sh"
LANE="$REPO/rsi/runtime/lane.sh"
CHECK="$REPO/scripts/check.sh"

n=0
TN=""
pass() { n=$((n + 1)); echo "ok: $*"; }
fail() { echo "FAIL: ${TN}: $*" >&2; exit 1; }
want="${RSI_TEST_ONLY:-}"
should_run() { [ -z "$want" ] || [ "$want" = "$1" ]; }
begin() { TN="$1"; require_helper; }

npm()  { echo "booby trap: npm invoked" >&2; exit 97; }
go()   { echo "booby trap: go invoked" >&2; exit 97; }
node() { echo "booby trap: node invoked" >&2; exit 97; }
curl() { echo "booby trap: curl invoked" >&2; exit 97; }
git()  { echo "booby trap: bare git invoked" >&2; exit 97; }
export -f npm go node curl git
( npm ) >/dev/null 2>&1; [ $? -eq 97 ] || fail "the npm booby trap is not live"
( git ) >/dev/null 2>&1; [ $? -eq 97 ] || fail "the bare-git booby trap is not live"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/wt"
: > "$T/log"
GIT_HEAD_SHA=0123456789abcdef0123456789abcdef01234567
export GIT_LOG="$T/log" GIT_MODE_FILE="$T/mode" GIT_PUSH_COUNT_FILE="$T/pushes" GIT_HEAD_SHA

# Stub git: every call is appended to GIT_LOG; GIT_MODE_FILE picks the scripted reply and
# GIT_PUSH_COUNT_FILE counts `push` calls, so a case can assert attempt counts exactly. Error
# text goes to stderr, exactly as the real git does. `ls-remote` reports the remote head only in
# landed mode, where the push that reported failure did land.
cat > "$T/bin/git" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$GIT_LOG"
mode="$(cat "$GIT_MODE_FILE" 2>/dev/null || true)"
sub="${3:-}"
case "$sub" in
  push)
    c=$(( $(cat "$GIT_PUSH_COUNT_FILE" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$GIT_PUSH_COUNT_FILE"
    case "$mode" in
      ok) exit 0 ;;
      flaky) [ "$c" -eq 1 ] && { echo 'fatal: unable to access remote: TLS connection reset by peer' >&2; exit 1; }; exit 0 ;;
      landed) echo 'fatal: the remote end hung up unexpectedly' >&2; exit 1 ;;
      permanent) echo 'fatal: unable to access remote: Could not resolve host: example.invalid' >&2; exit 1 ;;
    esac
    exit 0 ;;
  ls-remote)
    [ "$mode" = landed ] && printf '%s\trefs/heads/rsi/demo\n' "$GIT_HEAD_SHA"
    exit 0 ;;
  rev-parse)
    printf '%s\n' "$GIT_HEAD_SHA"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$T/bin/git"

reset_case() { # mode
  printf '%s\n' "$1" > "$T/mode"; : > "$T/log"; rm -f "$T/pushes"
}

require_helper() {
  [ -f "$HELPER" ] || fail "lane-push.sh is missing: $HELPER"
}

# run_bounded <secs> cmd... — kill a runaway (an unbounded retry mutant must fail the
# suite in seconds, not hang the gate until the harness gives up).
run_bounded() {
  local s="$1"; shift
  "$@" & local p=$!
  ( sleep "$s"; kill -KILL "$p" 2>/dev/null ) >/dev/null 2>&1 & local w=$!
  wait "$p"; local rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}

# run_helper <attempts> <stdout-file> <stderr-file> [kill-after-secs] — source the helper in a
# subshell and call git_push_retry against the stub. No retry sleep.
run_helper() {
  local att="$1" out="$2" err="$3" lim="${4:-}" rc
  local call='source "$1"; git_push_retry "$2" "$3" rsi/demo "$4"'
  if [ -n "$lim" ]; then
    run_bounded "$lim" env RSI_PUSH_RETRY_SLEEP=0 RSI_PUSH_RETRY_ATTEMPTS="$att" \
      bash -c "$call" _ "$HELPER" "$T/bin/git" "$T/wt" "$T/err" >"$out" 2>"$err"
    rc=$?
  else
    RSI_PUSH_RETRY_SLEEP=0 RSI_PUSH_RETRY_ATTEMPTS="$att" \
      bash -c "$call" _ "$HELPER" "$T/bin/git" "$T/wt" "$T/err" >"$out" 2>"$err"
    rc=$?
  fi
  return $rc
}

pushes() { grep -c 'push ' "$T/log" 2>/dev/null || true; }

# 1. One transient TLS failure: the second attempt succeeds and stdout stays empty.
if should_run test_transient_push_failure_is_retried; then
  begin test_transient_push_failure_is_retried
  reset_case flaky
  run_helper 3 "$T/o1" "$T/e1" || fail "helper returned non-zero: $(head -c 300 "$T/e1")"
  [ ! -s "$T/o1" ] || fail "stdout is not empty: $(head -c 300 "$T/o1")"
  [ "$(pushes)" -eq 2 ] || fail "expected 2 push calls, saw $(pushes)"
  grep -q 'attempt 1/3 failed' "$T/e1" || fail "stderr does not name the failed attempt: $(head -c 300 "$T/e1")"
  pass "a transient push failure is retried: attempt 2 succeeds, 2 push calls, stdout empty"
fi

# 2. The push landed although git reported failure: look at the remote head, do not push again.
if should_run test_push_that_landed_is_not_repeated; then
  begin test_push_that_landed_is_not_repeated
  reset_case landed
  run_helper 3 "$T/o2" "$T/e2" || fail "helper returned non-zero on a landed push: $(head -c 300 "$T/e2")"
  [ ! -s "$T/o2" ] || fail "stdout is not empty: $(head -c 300 "$T/o2")"
  [ "$(pushes)" -eq 1 ] || fail "expected exactly 1 push call, saw $(pushes) (a landed push was repeated)"
  grep -q "$GIT_HEAD_SHA" "$T/e2" || fail "stderr does not name the landed commit: $(head -c 300 "$T/e2")"
  pass "a push that landed is detected by the remote head and not repeated: 1 push call"
fi

# 3. A real network failure stays a failure, the retries stay bounded, and the last error survives.
if should_run test_permanent_push_failure_is_bounded; then
  begin test_permanent_push_failure_is_bounded
  reset_case permanent
  run_helper 3 "$T/o3" "$T/e3" 20; rc=$?
  [ "$rc" -ne 0 ] || fail "helper returned 0 although every push failed"
  [ ! -s "$T/o3" ] || fail "stdout is not empty on failure: $(head -c 300 "$T/o3")"
  [ "$(pushes)" -eq 3 ] || fail "expected exactly 3 push calls, saw $(pushes)"
  grep -q 'Could not resolve host' "$T/e3" || fail "stderr does not name the last error: $(head -c 300 "$T/e3")"
  pass "an always-failing push fails after exactly 3 attempts with the last error on stderr"
fi

# 4. An explicit attempt count is honoured: 1 attempt means 1 push.
if should_run test_attempt_count_override; then
  begin test_attempt_count_override
  reset_case permanent
  run_helper 1 "$T/o4" "$T/e4" || true
  [ "$(pushes)" -eq 1 ] || fail "RSI_PUSH_RETRY_ATTEMPTS=1 made $(pushes) push calls, not 1"
  pass "RSI_PUSH_RETRY_ATTEMPTS=1 makes exactly 1 push call"
fi

# 5. The recovery note names the branch, the SHA and the exact command a person must run.
if should_run test_unpushed_note_names_the_recovery; then
  begin test_unpushed_note_names_the_recovery
  note="$(RSI_PUSH_RETRY_SLEEP=0 bash -c 'source "$1"; unpushed_note rsi/demo "$2" /tmp/wt' _ "$HELPER" "$GIT_HEAD_SHA")" \
    || fail "unpushed_note returned non-zero"
  printf '%s' "$note" | grep -q 'rsi/demo' || fail "note does not name the branch: $note"
  printf '%s' "$note" | grep -q "$GIT_HEAD_SHA" || fail "note does not name the SHA: $note"
  printf '%s' "$note" | grep -q 'git -C /tmp/wt push -u origin rsi/demo' \
    || fail "note does not name the recovery command: $note"
  pass "unpushed_note names the branch, the SHA and the recovery command"
fi

# 6. lane.sh routes its push through the helper; executable lines only, not comments.
if should_run test_lane_routes_push_through_helper; then
  TN=test_lane_routes_push_through_helper
  exec_lines() { awk '!/^[[:space:]]*#/ { print }' "$1"; }
  exec_lines "$LANE" | grep -Eq '^[[:space:]]*source[[:space:]].*lane-push\.sh' \
    || fail "lane.sh does not source lane-push.sh"
  exec_lines "$LANE" | grep -Eq '(^|[^[:alnum:]_])git_push_retry[[:space:]]' \
    || fail "lane.sh does not call git_push_retry"
  if exec_lines "$LANE" | grep -Eq '\$\{?GIT\}?[[:space:]]+-C[[:space:]]+"\$\{?WT\}?"[[:space:]]+push'; then
    fail "a bare \$GIT -C \"\$WT\" push remains in lane.sh"
  fi
  pass "lane.sh sources lane-push.sh and its push path calls git_push_retry"
fi

# 7. A final push failure marks the work delivered-unpushed and does not charge a runner failure.
if should_run test_lane_marks_delivered_unpushed; then
  TN=test_lane_marks_delivered_unpushed
  exec_lines() { awk '!/^[[:space:]]*#/ { print }' "$1"; }
  exec_lines "$LANE" | grep -Fq 'finish delivered-unpushed' \
    || fail "lane.sh does not finish delivered-unpushed on a final push failure"
  if exec_lines "$LANE" | grep -Fq 'count_fail "lane $N push"'; then
    fail "lane.sh still charges count_fail for a push failure"
  fi
  pass "a final push failure finishes delivered-unpushed and charges no runner failure"
fi

# 8. This suite is wired into the gate's shell-test job on an executable line.
if should_run test_suite_is_wired_into_check_sh; then
  TN=test_suite_is_wired_into_check_sh
  body="$(awk '/^job_shell_test\(\)[[:space:]]*\{/ { on = 1 } on { print } on && /^\}/ { exit }' "$CHECK")"
  [ -n "$body" ] || fail "$CHECK has no job_shell_test()"
  printf '%s\n' "$body" | grep -Eq '^[[:space:]]*bash rsi/runtime/tests/test-lane-push-retry\.sh([[:space:]]|\|\||$)' \
    || fail "test-lane-push-retry.sh is not wired into scripts/check.sh"
  pass "the suite is wired into scripts/check.sh"
fi

# 9. Both network-bound calls run under the runtime's watchdog, so a stalled connection cannot
#    wedge lane.sh with its lock and slot held. A helper-only suite never loads common.sh, so the
#    wrapper falls back to the direct call — cases 1-4 above are that fallback.
if should_run test_push_and_remote_read_are_bounded; then
  begin test_push_and_remote_read_are_bounded
  reset_case permanent
  BOUND_LOG="$T/timeout.log"; export BOUND_LOG
  : > "$BOUND_LOG"
  with_timeout() { printf 'bounded %s\n' "$1" >> "$BOUND_LOG"; shift; "$@"; }
  export -f with_timeout
  env RSI_PUSH_RETRY_SLEEP=0 RSI_PUSH_RETRY_ATTEMPTS=2 RSI_PUSH_TIMEOUT_SECS=42 \
    bash -c 'source "$1"; git_push_retry "$2" "$3" rsi/demo "$4"' \
    _ "$HELPER" "$T/bin/git" "$T/wt" "$T/err" >"$T/o9" 2>"$T/e9" || true
  [ "$(grep -c '^bounded 42$' "$BOUND_LOG")" -eq 4 ] \
    || fail "expected 2 pushes + 2 remote-head reads under the watchdog, saw: $(cat "$BOUND_LOG")"
  [ "$(grep -c . "$BOUND_LOG")" -eq 4 ] \
    || fail "a bounded call did not use RSI_PUSH_TIMEOUT_SECS=42: $(cat "$BOUND_LOG")"
  pass "push and remote-head read run under with_timeout with RSI_PUSH_TIMEOUT_SECS"
fi

echo "lane push retry: $n/$n cases passed"
