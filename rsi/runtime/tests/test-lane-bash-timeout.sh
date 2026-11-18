#!/bin/bash
# test-lane-bash-timeout.sh — a stuck command must not eat a whole worker round.
#
# Two numbers keep this honest: the Bash tool's default timeout must stay under the
# worker watchdog (LANE_WORKER_SECS, 50 min), and `lanes.py status` must say how long
# an active lane has been SILENT, not only how long it has been alive. On 2026-11-18
# a lane-2 worker hung 2,400 s on stdin (a nested heredoc swallowed its closing `)`);
# the 55-min Bash default outlived the 50-min watchdog, so the round was lost, and
# `ACTIVE age=39m` looked healthy while the worker was silent.
#
# Hermetic: RSI_CTRL/RSI_STATE/RSI_RUNS all point under mktemp -d, no network, no
# sleep; npm, go, node and curl are booby traps (exit 97) so a future edit cannot
# start calling them. Prints "N/N cases passed" and exits on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
COMMON="$REPO/rsi/runtime/common.sh"
LANES="$REPO/rsi/runtime/lanes.py"
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
mkdir -p "$T/state/lanes" "$T/runs"

# field <status line> <name> — value of the `name=value` word on that line.
field() { printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1; }

# 1. The exported defaults are the new pair, ordered, and shorter than the watchdog
#    read from the same file. RSI_CTRL is redirected so common.sh's mkdir -p stays in
#    the temp dir and its git self-heal finds no checkout.
vals="$(RSI_CTRL="$T/ctrl" bash -c 'source "$1"; printf "%s %s %s\n" "$BASH_DEFAULT_TIMEOUT_MS" "$BASH_MAX_TIMEOUT_MS" "$LANE_WORKER_SECS"' _ "$COMMON" 2>/dev/null)" \
  || fail "case 1: sourcing $COMMON failed"
def="${vals%% *}"; rest="${vals#* }"; max="${rest%% *}"; secs="${rest#* }"
[ "$def" = 600000 ] && [ "$max" = 1800000 ] \
  || fail "case 1: BASH_DEFAULT_TIMEOUT_MS/BASH_MAX_TIMEOUT_MS are '$def $max', not '600000 1800000'"
[ "$def" -le "$max" ] || fail "case 1: default ${def}ms > max ${max}ms"
budget=$(( secs * 1000 ))
[ "$def" -lt "$budget" ] || fail "case 1: default ${def}ms is not under the worker watchdog ${budget}ms (LANE_WORKER_SECS=$secs)"
[ "$max" -lt "$budget" ] || fail "case 1: max ${max}ms is not under the worker watchdog ${budget}ms"
pass "Bash tool defaults are ${def}/${max} ms, under the ${budget}ms worker watchdog"

# 2. An old worker log makes silence visible and distinct from age: the lane started
#    now (age 0m), but its newest event log was last written in 2020.
cat > "$T/state/lanes/1.json" <<JSON
{"status":"running","pid":$$,"slug":"demo-item","item":"R-demo","started_at":$(date +%s)}
JSON
LOG1="$T/runs/2026-01-01-000000-dispatch-lane1-demo-item-worker.jsonl"
: > "$LOG1"
touch -t 202001010000 "$LOG1"
line1="$(RSI_STATE="$T/state" RSI_RUNS="$T/runs" RSI_MAX_LANES=2 python3 "$LANES" status 2>/dev/null | grep '^lane 1:')" \
  || fail "case 2: lanes.py status printed no lane 1 line"
case "$line1" in "lane 1: ACTIVE"*) ;; *) fail "case 2: lane 1 is not ACTIVE: $line1" ;; esac
age="$(field "$line1" age)"; silent="$(field "$line1" silent)"
[ -n "$age" ] && [ -n "$silent" ] || fail "case 2: age=/silent= missing from: $line1"
case "$age" in
  *m) age="${age%m}" ;;
  *) fail "case 2: age is '$age', not NNm" ;;
esac
case "$age" in ''|*[!0-9]*) fail "case 2: age is '$age', not whole minutes" ;; esac
[ "$age" -le 1 ] || fail "case 2: age=${age}m for a lane started now"
case "$silent" in
  *m) silent="${silent%m}" ;;
  *) fail "case 2: silent is '$silent', not NNm" ;;
esac
case "$silent" in ''|*[!0-9]*) fail "case 2: silent is '$silent', not whole minutes" ;; esac
# 2020-01-01 is >100000 minutes ago; 0m of age proves the number comes from the log
# mtime rather than started_at.
[ "$silent" -ge 100000 ] || fail "case 2: silent=${silent}m does not reflect the 2020 log mtime"
pass "an old log shows as silence: age=${age}m silent=${silent}m"

# 3. A just-claimed lane has no log yet: silence is unknown, not a number.
cat > "$T/state/lanes/2.json" <<JSON
{"status":"claimed","claimed_at":$(date +%s),"slug":"no-log","item":"R-demo"}
JSON
line2="$(RSI_STATE="$T/state" RSI_RUNS="$T/runs" RSI_MAX_LANES=2 python3 "$LANES" status 2>/dev/null | grep '^lane 2:')" \
  || fail "case 3: lanes.py status printed no lane 2 line"
case "$line2" in "lane 2: ACTIVE"*) ;; *) fail "case 3: a fresh claim is not ACTIVE: $line2" ;; esac
case "$line2" in *"age="*) ;; *) fail "case 3: age= missing from: $line2" ;; esac
[ "$(field "$line2" silent)" = "-" ] || fail "case 3: a claimed lane with no log should print silent=-: $line2"
pass "a claimed lane with no log prints silent=-"

# 4. This suite is wired into the gate's shell-test job on an executable line.
body="$(awk '/^job_shell_test\(\)[[:space:]]*\{/ { on = 1 } on { print } on && /^\}/ { exit }' "$CHECK")"
[ -n "$body" ] || fail "case 4: $CHECK has no job_shell_test()"
printf '%s\n' "$body" | grep -Eq '^[[:space:]]*bash rsi/runtime/tests/test-lane-bash-timeout\.sh([[:space:]]|\|\||$)' \
  || fail "case 4: test-lane-bash-timeout.sh is not wired into scripts/check.sh"
pass "the suite is wired into scripts/check.sh"

echo "lane bash timeout guard: $n/$n cases passed"
