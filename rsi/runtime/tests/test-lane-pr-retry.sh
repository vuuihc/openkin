#!/bin/bash
# test-lane-pr-retry.sh — a finished round must survive a transient `gh pr create` failure.
#
# 2026-11-18 21:01: lane 1 finished its round (check.sh 18/18, commit pushed) and then
# ONE un-retried `gh pr create` got `Post "https://api.github.com/graphql": EOF`; the
# lane recorded failed and the finished round was thrown away, re-entering the queue
# only because a person opened PR #329 by hand.
#
# The trap in that incident: the PR may already exist even though create reported
# failure. A retry that blindly creates again either duplicates the PR or dies on
# "already exists" and loses the round all over again — so the helper looks first.
#
# Hermetic: mktemp -d, a stub `gh` selected by GH (no network), no real retry sleep;
# npm, go, node and curl are booby traps (exit 97). Prints
# "lane pr retry: N/N cases passed" and exits on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
HELPER="$REPO/rsi/runtime/lane-pr.sh"
LANE="$REPO/rsi/runtime/lane.sh"
CHECK="$REPO/scripts/check.sh"

n=0
pass() { n=$((n + 1)); echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

npm()  { echo "booby trap: npm invoked" >&2; exit 97; }
go()   { echo "booby trap: go invoked" >&2; exit 97; }
node() { echo "booby trap: node invoked" >&2; exit 97; }
curl() { echo "booby trap: curl invoked" >&2; exit 97; }
export -f npm go node curl
( npm ) >/dev/null 2>&1; [ $? -eq 97 ] || fail "the npm booby trap is not live"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
printf 'test body\n' > "$T/body.md"
: > "$T/log"

# Stub gh: every call is appended to GH_LOG; GH_MODE_FILE picks the scripted reply and
# GH_COUNT_FILE counts `pr create` calls, so a case can assert attempt counts exactly.
# Error text goes to stderr, exactly as the real gh does.
cat > "$T/bin/gh" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$GH_LOG"
mode="$(cat "$GH_MODE_FILE" 2>/dev/null || true)"
case "$1 $2" in
  "pr create")
    c=$(( $(cat "$GH_COUNT_FILE" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$GH_COUNT_FILE"
    if [ "$mode" = forbidden ]; then
      echo "HTTP 403: Resource not accessible" >&2; exit 1
    fi
    if [ "$mode" = flaky ] && [ "$c" -eq 1 ]; then
      echo 'Post "https://api.github.com/graphql": EOF' >&2; exit 1
    fi
    if [ "$mode" = exists ] && [ "$c" -eq 1 ]; then
      echo 'Post "https://api.github.com/graphql": EOF' >&2; exit 1
    fi
    echo "https://github.com/vuuihc/openkin/pull/999"; exit 0 ;;
  "pr list")
    [ "$mode" = exists ] && echo 1001
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$T/bin/gh"
export GH="$T/bin/gh" GH_LOG="$T/log" GH_MODE_FILE="$T/mode" GH_COUNT_FILE="$T/count"

reset_case() { # mode
  printf '%s\n' "$1" > "$T/mode"; : > "$T/log"; rm -f "$T/count"
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

# run_helper <attempts> <stdout-file> <stderr-file> [kill-after-secs] — source the
# helper in a subshell and call gh_pr_create for vuuihc/openkin. No retry sleep.
run_helper() {
  local att="$1" out="$2" err="$3" lim="${4:-}" rc
  local call='source "$1"; gh_pr_create "$2" main "$3" "test title" "$4"'
  if [ -n "$lim" ]; then
    run_bounded "$lim" env RSI_GH_PR_RETRY_SLEEP=0 RSI_GH_PR_RETRY_ATTEMPTS="$att" \
      bash -c "$call" _ "$HELPER" vuuihc/openkin rsi/demo "$T/body.md" >"$out" 2>"$err"
    rc=$?
  else
    RSI_GH_PR_RETRY_SLEEP=0 RSI_GH_PR_RETRY_ATTEMPTS="$att" \
      bash -c "$call" _ "$HELPER" vuuihc/openkin rsi/demo "$T/body.md" >"$out" 2>"$err"
    rc=$?
  fi
  return $rc
}

creates() { grep -c '^pr create ' "$T/log" 2>/dev/null || true; }

[ -f "$HELPER" ] || fail "lane-pr.sh is missing: $HELPER"

# 1. One transient EOF: the second attempt succeeds and its URL is all stdout carries.
reset_case flaky
run_helper 3 "$T/o1" "$T/e1" || fail "case 1: helper returned non-zero: $(head -c 300 "$T/e1")"
[ "$(cat "$T/o1")" = "https://github.com/vuuihc/openkin/pull/999" ] \
  || fail "case 1: stdout is not exactly the PR URL: $(head -c 300 "$T/o1")"
[ "$(creates)" -eq 2 ] || fail "case 1: expected 2 pr create calls, saw $(creates)"
pass "a transient EOF is retried: attempt 2's URL is stdout, 2 pr create calls"

# 2. The PR already exists although create reported failure: look before creating again.
reset_case exists
run_helper 3 "$T/o2" "$T/e2" || fail "case 2: helper returned non-zero: $(head -c 300 "$T/e2")"
[ "$(cat "$T/o2")" = "https://github.com/vuuihc/openkin/pull/1001" ] \
  || fail "case 2: stdout is not the existing PR URL: $(head -c 300 "$T/o2")"
[ "$(creates)" -eq 1 ] || fail "case 2: expected 1 pr create call, saw $(creates) (duplicate PR risk)"
pass "an already-created PR is found, not duplicated: 1 pr create call"

# 3. A real permission failure stays a failure and the retries stay bounded.
reset_case forbidden
run_helper 3 "$T/o3" "$T/e3" 20; rc=$?
[ "$rc" -ne 0 ] || fail "case 3: helper returned 0 on an always-403 create"
grep -q '/pull/' "$T/o3" && fail "case 3: stdout carries a URL on failure: $(head -c 300 "$T/o3")"
[ "$(creates)" -eq 3 ] || fail "case 3: expected exactly 3 pr create calls, saw $(creates)"
pass "an always-403 create fails after exactly 3 attempts with no URL on stdout"

# 4. lane.sh routes its create through the helper; executable lines only, not comments.
exec_lines() { awk '!/^[[:space:]]*#/ { print }' "$1"; }
exec_lines "$LANE" | grep -Eq '^[[:space:]]*source[[:space:]].*lane-pr\.sh' \
  || fail "case 4: lane.sh does not source lane-pr.sh"
exec_lines "$LANE" | grep -Eq '(^|[^[:alnum:]_])gh_pr_create[[:space:]]' \
  || fail "case 4: lane.sh does not call gh_pr_create"
if exec_lines "$LANE" | grep -Eq '\$\{?GH\}?[[:space:]]+pr[[:space:]]+create'; then
  fail "case 4: a bare \$GH pr create remains in lane.sh"
fi
pass "lane.sh sources lane-pr.sh and its create path calls gh_pr_create"

# 5. This suite is wired into the gate's shell-test job on an executable line.
body="$(awk '/^job_shell_test\(\)[[:space:]]*\{/ { on = 1 } on { print } on && /^\}/ { exit }' "$CHECK")"
[ -n "$body" ] || fail "case 5: $CHECK has no job_shell_test()"
printf '%s\n' "$body" | grep -Eq '^[[:space:]]*bash rsi/runtime/tests/test-lane-pr-retry\.sh([[:space:]]|\|\||$)' \
  || fail "case 5: test-lane-pr-retry.sh is not wired into scripts/check.sh"
pass "the suite is wired into scripts/check.sh"

echo "lane pr retry: $n/$n cases passed"
