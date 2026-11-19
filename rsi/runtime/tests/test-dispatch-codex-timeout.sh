#!/bin/bash
# test-dispatch-codex-timeout.sh — a silent `codex exec` review must not hold the merge lane forever.
#
# On 2026-11-15 two `codex exec` reviews wrote nothing for an hour and held both
# verifier slots. run_claude and run_agy already had a DISPATCH_MAX_SECS watchdog;
# run_codex did not, and merge.sh waits on the reviewer with no deadline of its own,
# so a hung codex stalled that PR (and its gate slot) indefinitely. This suite runs
# the real dispatch.sh: a hung codex must be killed at DISPATCH_MAX_SECS, report the
# failure, and fall back to claude -p; a healthy codex must answer unchanged.
#
# Hermetic: RSI_CTRL/RSI_RUNS/RSI_STATE live under mktemp -d, codex and claude are
# fakes on PATH, no network and no model calls. escalate.py is deliberately absent
# from the temp runtime: reviewer-alt always asks for a strong model when escalation
# can answer, and the codex default path is what dispatch takes when it cannot
# (merge.sh's own path reaches run_codex through the escalated fallback chain, but
# the failure line under test belongs to the default path). Prints "N/N cases passed"
# and exits on the first failure; the whole suite stays well under 20 s.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DISPATCH="$REPO/rsi/runtime/dispatch.sh"

n=0
pass() { n=$((n + 1)); echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

T="$(mktemp -d)"
cleanup() {
  local p
  for p in "$T/codex.pid" "$T/codex-child.pid"; do
    [ -s "$p" ] && kill -KILL "$(cat "$p" 2>/dev/null)" 2>/dev/null
  done
  rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$T/ctrl/rsi/state" "$T/ctrl/rsi/runtime" "$T/runs" "$T/home/.local/bin" "$T/cwd"
ln -s "$REPO/rsi/runtime/parse_result.py" "$T/ctrl/rsi/runtime/parse_result.py"
printf 'review this change\n' > "$T/prompt"

export CODEX_ARGS="$T/codex-args" CODEX_PID="$T/codex.pid" CODEX_CHILD="$T/codex-child.pid"
export CLAUDE_ARGS="$T/claude-args"

cat > "$T/home/.local/bin/claude" <<'SH'
#!/bin/bash
printf 'claude %s\n' "$*" >> "${CLAUDE_ARGS:?}"
printf '%s\n' '{"type":"result","result":"VERDICT: PASS","is_error":false}'
exit "${FAKE_CLAUDE_EXIT:-0}"
SH
chmod +x "$T/home/.local/bin/claude"

# start_dispatch <outer-bound-secs> — run reviewer-alt through the real dispatch.sh.
# Sets RC, ELAPSED and TIMED_OUT; the outer bound is the suite's own watchdog, so a
# hung codex can never hang this test.
start_dispatch() {
  local bound="$1" t0=$SECONDS
  : > "$T/err"
  : > "$CODEX_ARGS"
  : > "$CLAUDE_ARGS"
  rm -f "$T/timed-out" "$CODEX_PID" "$CODEX_CHILD"
  HOME="$T/home" RSI_CTRL="$T/ctrl" RSI_RUNS="$T/runs" DISPATCH_MAX_SECS=2 \
    bash "$DISPATCH" reviewer-alt "$T/cwd" "$T/prompt" test-codex-watchdog \
    >"$T/out" 2>"$T/err" &
  local dp=$!
  ( sleep "$bound"; : > "$T/timed-out"; kill -KILL "$dp" 2>/dev/null ) & local wd=$!
  wait "$dp"; RC=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  ELAPSED=$((SECONDS - t0))
  TIMED_OUT=0; [ -e "$T/timed-out" ] && TIMED_OUT=1
  return 0
}

# gone <pidfile> — the recorded process no longer answers kill -0. Retries briefly:
# a killed child can be a zombie for a moment before its parent reaps it.
gone() {
  local i p
  [ -s "$1" ] || return 1
  p="$(cat "$1")"
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    kill -0 "$p" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

# 1. A hung codex exec is killed at DISPATCH_MAX_SECS and the run falls back to claude -p.
cat > "$T/home/.local/bin/codex" <<'SH'
#!/bin/bash
printf 'codex %s\n' "$*" >> "${CODEX_ARGS:?}"
echo $$ > "${CODEX_PID:?}"
exec sleep 30
SH
chmod +x "$T/home/.local/bin/codex"
start_dispatch 15
[ "$TIMED_OUT" -eq 0 ] || fail "case 1: dispatch itself had to be killed after ${ELAPSED}s; the codex call was not bounded"
[ "$ELAPSED" -le 10 ] || fail "case 1: dispatch returned after ${ELAPSED}s, not within 10s (DISPATCH_MAX_SECS=2)"
grep -qF '[codex exec failed, falling back to claude -p on ' "$T/err" \
  || fail "case 1: stderr does not carry the fallback line: $(cat "$T/err")"
[ "$RC" -eq 0 ] || fail "case 1: dispatch exited $RC, not the fake claude's 0"
grep -q -- '--model codex/gpt-6.1-sol' "$CLAUDE_ARGS" \
  || fail "case 1: claude -p was not called on the codex model"
pass "a codex exec silent for ${ELAPSED}s was killed and the run fell back to claude -p"

# 2. The timed-out codex and its child are gone.
cat > "$T/home/.local/bin/codex" <<'SH'
#!/bin/bash
echo $$ > "${CODEX_PID:?}"
sleep 60 &
echo $! > "${CODEX_CHILD:?}"
wait
SH
chmod +x "$T/home/.local/bin/codex"
start_dispatch 15
[ "$TIMED_OUT" -eq 0 ] || fail "case 2: dispatch itself had to be killed after ${ELAPSED}s"
[ -s "$CODEX_PID" ] || fail "case 2: the fake codex never recorded its pid"
[ -s "$CODEX_CHILD" ] || fail "case 2: the fake codex never recorded its child"
gone "$CODEX_PID" || fail "case 2: the timed-out codex (pid $(cat "$CODEX_PID")) is still running"
gone "$CODEX_CHILD" || fail "case 2: the codex child (pid $(cat "$CODEX_CHILD")) is still running"
pass "the timed-out codex and its child are gone"

# 3. A healthy codex exec still answers without the fallback.
cat > "$T/home/.local/bin/codex" <<'SH'
#!/bin/bash
printf 'codex %s\n' "$*" >> "${CODEX_ARGS:?}"
printf 'VERDICT: PASS\n'
exit 0
SH
chmod +x "$T/home/.local/bin/codex"
start_dispatch 15
[ "$TIMED_OUT" -eq 0 ] || fail "case 3: dispatch itself had to be killed after ${ELAPSED}s"
[ "$RC" -eq 0 ] || fail "case 3: a healthy codex exited $RC, not 0"
if grep -qF '[codex exec failed, falling back to claude -p on ' "$T/err"; then
  fail "case 3: a healthy codex still reported the fallback: $(cat "$T/err")"
fi
[ -s "$CLAUDE_ARGS" ] && fail "case 3: claude -p ran even though codex succeeded: $(cat "$CLAUDE_ARGS")"
grep -q -- '-m gpt-6.1-sol -s read-only' "$CODEX_ARGS" \
  || fail "case 3: codex was not called with -m gpt-6.1-sol -s read-only: $(cat "$CODEX_ARGS")"
grep -qF 'VERDICT: PASS' "$T/out" || fail "case 3: the codex verdict did not reach stdout: $(cat "$T/out")"
pass "a healthy codex exec answered without the fallback"

echo "$n/$n cases passed"
