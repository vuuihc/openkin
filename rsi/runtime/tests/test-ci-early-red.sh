#!/bin/bash
# test-ci-early-red.sh — R-producer-checks part C: a COMPLETED FAILURE in the PR head's
# statusCheckRollup must send the PR back BEFORE the gate and review run — the verdict step 6
# reads is already decided, so the gate slot and the strong review were spent for nothing
# (#778 shipped an RN tsc failure that sat red through a full gate and a review). Pending,
# cancelled, skipped or an unreadable checks list must NOT short-circuit.
#
# Exercises merge.sh --ci-early-red-check, which runs the same ci_early_red() the step-3b call
# site runs, with `gh` stubbed through the RSI_GH env seam. No network, no model.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
# PAUSE covers the red run on an unmodified merge.sh: without the seam the dispatcher body runs,
# and PAUSE is the first thing it honours — so no gh, fetch or dispatch happens either way.
mkdir -p "$T/ctrl/rsi/state"; : > "$T/ctrl/rsi/state/PAUSE"
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
run() { if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi; "$1" || exit 1; pass "$1"; }

gh_stub() { # <json-file> — a fake gh whose `pr checks` prints the file
  cat > "$T/gh" <<SH
#!/bin/bash
if [ "\$1" = pr ] && [ "\$2" = checks ]; then cat "$1"; exit 0; fi
exit 0
SH
  chmod +x "$T/gh"
}

probe() { # -> RC, OUT; run the seam against the currently stubbed gh
  rm -f "$T/ci.txt"
  OUT="$(RSI_GH="$T/gh" RSI_CTRL="$T/ctrl" bash "$MERGE" --ci-early-red-check 7 tslug "$T/ci.txt" 2>&1)"
  RC=$?
}

test_completed_failure_short_circuits() {
  cat > "$T/checks.json" <<'J'
[{"name":"mobile-rn","bucket":"fail","link":"https://x/runs/1"},
 {"name":"build","bucket":"pass","link":"https://x/runs/2"},
 {"name":"smoke","bucket":"pending","link":"https://x/runs/3"}]
J
  gh_stub "$T/checks.json"; probe
  [ $RC -eq 0 ] && [ "$OUT" = RED ] || fail "red: rc=$RC out='$OUT', want RED"
  grep -q 'failing checks: mobile-rn' "$T/ci.txt" \
    || fail "red: ci.txt lacks the failing check name ($(cat "$T/ci.txt"))"
}

test_pending_does_not_short_circuit() {
  cat > "$T/checks.json" <<'J'
[{"name":"mobile-rn","bucket":"pending","link":"https://x/runs/1"},
 {"name":"build","bucket":"cancel","link":"https://x/runs/2"},
 {"name":"journeys","bucket":"skip","link":"https://x/runs/3"}]
J
  gh_stub "$T/checks.json"; probe
  [ $RC -eq 1 ] && [ "$OUT" = PROCEED ] || fail "pending: rc=$RC out='$OUT', want PROCEED"
  [ ! -s "$T/ci.txt" ] || fail "pending: ci.txt was written on a non-verdict read"
}

test_unreadable_or_empty_checks_proceed() {
  echo 'not json' > "$T/checks.json"; gh_stub "$T/checks.json"; probe
  [ $RC -eq 1 ] || fail "unreadable: garbage checks short-circuited ($OUT)"
  echo 'no checks reported' > "$T/checks.json"; gh_stub "$T/checks.json"; probe
  [ $RC -eq 1 ] || fail "empty: no-checks short-circuited ($OUT)"
}

test_call_site_precedes_gate() {
  local red_ln gate_ln
  red_ln="$(grep -n 'ci_early_red "$N"' "$MERGE" | head -1 | cut -d: -f1)"
  gate_ln="$(grep -n '^# 4\. gate and review' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$red_ln" ] || fail "wiring: no ci_early_red call site in the verifier body"
  [ -n "$gate_ln" ] && [ "$red_ln" -lt "$gate_ln" ] \
    || fail "wiring: the short-circuit (line $red_ln) is not before step 4 (line $gate_ln)"
  grep -q 'sendback "$SLUG" "$ITEM" "CI failed" "$STATE/merge/$SLUG.ci.txt" "ci"' "$MERGE" \
    || fail "wiring: the short-circuit does not reuse the step-6 CI sendback shape"
}

# The --one worker (the path step 3b runs on) never executes the `!= "--one"` dispatcher branch,
# so a definition inside that branch is undefined there: step 3b dies with 127 and the `if`
# silently proceeds to the gate. The function must sit at column 0 above the dispatcher.
test_definition_outside_dispatcher() {
  local def_ln disp_ln
  def_ln="$(grep -n '^ci_early_red()' "$MERGE" | head -1 | cut -d: -f1)"
  disp_ln="$(grep -n '!= "--one"' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$def_ln" ] || fail "placement: no column-0 ci_early_red definition"
  [ -n "$disp_ln" ] && [ "$def_ln" -lt "$disp_ln" ] \
    || fail "placement: ci_early_red (line $def_ln) is not above the != --one dispatcher (line $disp_ln); the --one worker would see it undefined"
  bash -n "$MERGE" || fail "placement: merge.sh fails bash -n"
}

run test_completed_failure_short_circuits
run test_pending_does_not_short_circuit
run test_unreadable_or_empty_checks_proceed
run test_call_site_precedes_gate
run test_definition_outside_dispatcher
echo ALL-PASS
