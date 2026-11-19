#!/bin/bash
# test-dispatch-review-findings.sh — a strong FAIL must record what it found.
#
# A FAIL outcome used to be recorded with the bare note "VERDICT: FAIL" at both
# dispatch sites, so escalations.jsonl never carried a blocker/major line and
# `escalate.py --weekly` printed Found-what-DeepSeek-missed: 0 by construction
# (has_bm was structurally false). This suite runs the real dispatch.sh against
# fake model CLIs: a FAIL whose review names a blocker/major must record that
# line in outcome_note and set has_bm, a nits-only FAIL must stay bare (never
# invent a tag), PASS/hold notes must be unchanged, and the escalated
# named-model branch must record findings too.
#
# Hermetic: RSI_CTRL/RSI_RUNS/RSI_STATE live under mktemp -d, codex/claude are
# fakes on PATH, escalate.py is a policy double that answers --check (and
# --no-strong-available) and hands --outcome to the real engine. No network and
# no model calls. Prints "N/N cases passed" and exits on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DISPATCH="$REPO/rsi/runtime/dispatch.sh"
REAL_ESCALATE="$REPO/rsi/runtime/escalate.py"

n=0
pass() { n=$((n + 1)); echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

T="$(mktemp -d)"
cleanup() { rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/ctrl/rsi/state" "$T/ctrl/rsi/runtime" "$T/runs" "$T/home/.local/bin" "$T/cwd"
ln -s "$REPO/rsi/runtime/parse_result.py" "$T/ctrl/rsi/runtime/parse_result.py"
printf 'review this change\n' > "$T/prompt"

# Policy double. dispatch.sh invokes escalate.py as `python3 <path> ...`, so this
# must be Python. --check answers with the case's scripted escalation; the test
# seeds the matching pending record. Everything else (--outcome, --save-strong,
# --sol-limited) is the real engine working on the temp state dir.
cat > "$T/ctrl/rsi/runtime/escalate.py" <<'PY'
#!/usr/bin/env python3
import os
import sys

if "--check" in sys.argv:
    env = os.environ.get("FAKE_CHECK_ENV", "")
    if env and os.path.exists(env):
        sys.stdout.write(open(env, encoding="utf-8").read())
    raise SystemExit(0)
if "--no-strong-available" in sys.argv:
    raise SystemExit(1)  # a strong model is available; never hold
os.execv(sys.executable, [sys.executable, os.environ["FAKE_ESCALATE_REAL"]] + sys.argv[1:])
PY

# seed_record <id> — the pending escalation record --check would have logged.
seed_record() {
  printf '{"id":"%s","ts":"2026-11-19T00:00:00+08:00","kind":"escalation","outcome":"pending"}\n' "$1" \
    >> "$T/ctrl/rsi/state/escalations.jsonl"
}

# field <id> <field> — the record's field, "<absent>" when the key is missing,
# "<no-record>" when no record carries the id. Booleans print true/false.
field() {
  python3 - "$T/ctrl/rsi/state/escalations.jsonl" "$1" "$2" <<'PY'
import json, sys
path, eid, field = sys.argv[1:4]
for line in open(path, encoding="utf-8"):
    try:
        rec = json.loads(line)
    except Exception:
        continue
    if rec.get("id") == eid:
        if field not in rec:
            print("<absent>")
        elif isinstance(rec[field], bool):
            print("true" if rec[field] else "false")
        else:
            print(rec[field])
        raise SystemExit(0)
print("<no-record>")
raise SystemExit(2)
PY
}

# run_case <tag> <role> — run the real dispatch.sh under this suite's own
# watchdog. Sets RC and TIMED_OUT; a hung dispatch can never hang the suite.
run_case() {
  local tag="$1" role="$2" t0=$SECONDS dp wd
  : > "$T/out"; : > "$T/err"; rm -f "$T/timed-out"
  HOME="$T/home" RSI_CTRL="$T/ctrl" RSI_RUNS="$T/runs" \
    FAKE_CHECK_ENV="$T/check.env" FAKE_ESCALATE_REAL="$REAL_ESCALATE" \
    DISPATCH_MAX_SECS=20 \
    bash "$DISPATCH" "$role" "$T/cwd" "$T/prompt" "$tag" >"$T/out" 2>"$T/err" &
  dp=$!
  ( sleep 30; : > "$T/timed-out"; kill -KILL "$dp" 2>/dev/null ) & wd=$!
  wait "$dp"; RC=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  TIMED_OUT=0; [ -e "$T/timed-out" ] && TIMED_OUT=1
  ELAPSED=$((SECONDS - t0))
  return 0
}

fake_codex() { # stdin becomes the fake's behavior, verbatim
  cat > "$T/home/.local/bin/codex"
  chmod +x "$T/home/.local/bin/codex"
}

# 1. Default reviewer-alt path (emit_and_exit): a FAIL with a blocker records it.
fake_codex <<'SH'
#!/bin/bash
printf 'Reviewed the diff.\nVERDICT: FAIL\n**Blocker** the follow-up is dropped\n'
exit 0
SH
printf 'RSI_ESCALATE_ID=test-case1\n' > "$T/check.env"
seed_record test-case1
run_case case1 reviewer-alt
[ "$TIMED_OUT" -eq 0 ] || fail "case 1: dispatch had to be killed after ${ELAPSED}s"
[ "$(field test-case1 outcome)" = FAIL ] \
  || fail "case 1: outcome=$(field test-case1 outcome), not FAIL (stderr: $(cat "$T/err"))"
[ "$(field test-case1 has_bm)" = true ] \
  || fail "case 1: has_bm=$(field test-case1 has_bm), not true; note=$(field test-case1 outcome_note)"
note1="$(field test-case1 outcome_note)"
case "$note1" in
  "VERDICT: FAIL"*) ;;
  *) fail "case 1: outcome_note does not keep the VERDICT: FAIL prefix: $note1" ;;
esac
case "$note1" in
  *"the follow-up is dropped"*) ;;
  *) fail "case 1: the blocker line is missing from outcome_note: $note1" ;;
esac
pass "a failing strong review records its blocker line, so has_bm is true"

# 2. A FAIL that names only nits stays bare: no fabricated tag, has_bm false.
fake_codex <<'SH'
#!/bin/bash
printf 'VERDICT: FAIL\n**Nit** spacing in the doc comment\n'
exit 0
SH
printf 'RSI_ESCALATE_ID=test-case2\n' > "$T/check.env"
seed_record test-case2
run_case case2 reviewer-alt
[ "$TIMED_OUT" -eq 0 ] || fail "case 2: dispatch had to be killed after ${ELAPSED}s"
[ "$(field test-case2 outcome)" = FAIL ] || fail "case 2: outcome=$(field test-case2 outcome), not FAIL"
[ "$(field test-case2 has_bm)" = false ] \
  || fail "case 2: has_bm=$(field test-case2 has_bm), not false; a nits-only FAIL must not invent a tag"
[ "$(field test-case2 outcome_note)" = "VERDICT: FAIL" ] \
  || fail "case 2: outcome_note=$(field test-case2 outcome_note), not the bare verdict"
pass "a failing review naming only nits records has_bm false"

# 3. PASS is untouched.
fake_codex <<'SH'
#!/bin/bash
printf 'VERDICT: PASS\n'
exit 0
SH
printf 'RSI_ESCALATE_ID=test-case3\n' > "$T/check.env"
seed_record test-case3
run_case case3 reviewer-alt
[ "$TIMED_OUT" -eq 0 ] || fail "case 3: dispatch had to be killed after ${ELAPSED}s"
[ "$(field test-case3 outcome)" = PASS ] || fail "case 3: outcome=$(field test-case3 outcome), not PASS"
[ "$(field test-case3 outcome_note)" = "VERDICT: PASS" ] \
  || fail "case 3: outcome_note=$(field test-case3 outcome_note), not exactly VERDICT: PASS"
[ "$(field test-case3 has_bm)" = false ] || fail "case 3: has_bm=$(field test-case3 has_bm), not false"
pass "a passing review keeps its note unchanged and has_bm false"

# 4. The escalated named-model branch (dispatch.sh's RSI_ESCALATE_MODEL path,
# the `record_outcome FAIL` at its end): a planner-class run has no verdict
# requirement, so dispatch reaches that branch after the named model answers.
# The fake leaves stdout empty and writes the text parse_result reads to the
# run log, which is exactly what that branch greps.
fake_codex <<'SH'
#!/bin/bash
python3 - "$RSI_RUNS" <<'PY'
import datetime, sys, time
base = time.time()
for off in range(-5, 3):
    ts = datetime.datetime.fromtimestamp(base + off).strftime("%Y-%m-%d-%H%M%S")
    with open("%s/%s-dispatch-case4.jsonl" % (sys.argv[1], ts), "a", encoding="utf-8") as f:
        f.write("VERDICT: FAIL\n**Blocker** the escalated finding is dropped\n")
PY
exit 0
SH
printf 'RSI_ESCALATE_MODEL=codex\nRSI_ESCALATE_FALLBACK=\nRSI_ESCALATE_REASON=%s\nRSI_ESCALATE_COST_SOURCE=chatgpt\nRSI_ESCALATE_ID=test-case4\n' "'test-escalation'" > "$T/check.env"
seed_record test-case4
run_case case4 director
[ "$TIMED_OUT" -eq 0 ] || fail "case 4: dispatch had to be killed after ${ELAPSED}s"
[ "$(field test-case4 outcome)" = FAIL ] \
  || fail "case 4: outcome=$(field test-case4 outcome), not FAIL (stderr: $(cat "$T/err"))"
[ "$(field test-case4 has_bm)" = true ] \
  || fail "case 4: has_bm=$(field test-case4 has_bm), not true; note=$(field test-case4 outcome_note)"
case "$(field test-case4 outcome_note)" in
  *"the escalated finding is dropped"*) ;;
  *) fail "case 4: the escalated review's finding is missing from outcome_note: $(field test-case4 outcome_note)" ;;
esac
pass "the escalated named-model path records findings too"

# 5. The note is one bounded line: keep at most five finding lines, collapse
# newlines, and append exactly one escalations.log line per record.
before="$(wc -l < "$T/ctrl/rsi/state/escalations.log" 2>/dev/null || echo 0)"
fake_codex <<'SH'
#!/bin/bash
printf '%s\n' \
  'VERDICT: FAIL' \
  '**Blocker** first finding' \
  '- **major**: second finding with a long tail AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' \
  'Blocker B3 third finding' \
  'Major M4 fourth finding' \
  '- **blocker**: fifth finding' \
  '**Blocker** sixth finding must be dropped' \
  'Major M7 seventh finding must be dropped'
exit 0
SH
printf 'RSI_ESCALATE_ID=test-case5\n' > "$T/check.env"
seed_record test-case5
run_case case5 reviewer-alt
[ "$TIMED_OUT" -eq 0 ] || fail "case 5: dispatch had to be killed after ${ELAPSED}s"
note5="$(field test-case5 outcome_note)"
[ "$(field test-case5 has_bm)" = true ] || fail "case 5: has_bm=$(field test-case5 has_bm), not true"
case "$note5" in
  *$'\n'*) fail "case 5: outcome_note carries a newline: $note5" ;;
esac
[ "${#note5}" -le 1600 ] || fail "case 5: outcome_note is ${#note5} chars, over the ~1500 bound"
[ "$(printf '%s' "$note5" | grep -o ' | ' | wc -l | tr -d ' ')" = 5 ] \
  || fail "case 5: expected exactly five joined finding lines: $note5"
case "$note5" in
  *"sixth finding"*|*"seventh finding"*) fail "case 5: more than five findings were kept: $note5" ;;
esac
after="$(wc -l < "$T/ctrl/rsi/state/escalations.log")"
[ $((after - before)) -eq 1 ] \
  || fail "case 5: escalations.log grew by $((after - before)) lines, not 1"
pass "the recorded note is one bounded line"

echo "$n/$n cases passed"
