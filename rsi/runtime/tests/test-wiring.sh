#!/bin/bash
# test-wiring.sh — every guard the loop keeps for itself must actually run in the gate.
#
# scripts/check.sh's job_shell_test() is the only job that runs the loop's shell
# suites, so a suite that exists in rsi/runtime/tests but is not named there never
# runs: not in a PR gate, not in CI. This test enumerates the tests directory and
# requires every *.sh in it to be named in that function.
#
# RSI_CHECK_SH / RSI_TESTS_DIR point the checker at another check.sh and tests dir
# (the negative cases below use a temp copy); with either set, only that pair is
# enumerated, so a negative case cannot recurse into itself.
#
# Hermetic: temp dirs, no network. Prints "PASS <case>" per case and exits non-zero
# on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_CHECK="$(cd "$HERE/../../.." && pwd)/scripts/check.sh"
CHECK="${RSI_CHECK_SH:-$DEFAULT_CHECK}"
TESTS="${RSI_TESTS_DIR:-$HERE}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL $*" >&2; exit 1; }

# job_body <check.sh> — print the body of job_shell_test(), the job that runs loop suites.
job_body() {
  local f="$1" body
  [ -f "$f" ] && [ -r "$f" ] || fail "check.sh missing or unreadable: $f"
  body="$(awk '/^job_shell_test\(\)[[:space:]]*\{/ { on = 1 } on { print } on && /^\}/ { exit }' "$f")"
  [ -n "$body" ] || fail "check.sh has no job_shell_test(): $f"
  printf '%s\n' "$body"
}

# unwired <check.sh> <tests-dir> — print every suite file that job_shell_test() does not name.
unwired() {
  local check="$1" dir="$2" body f base rc=0
  [ -d "$dir" ] || fail "tests dir missing: $dir"
  body="$(job_body "$check")" || exit 1
  for f in "$dir"/*.sh; do
    [ -e "$f" ] || fail "no *.sh suites in $dir"
    base="$(basename "$f")"
    if ! grep -qF "tests/$base" <<<"$body"; then
      echo "$base"
      rc=1
    fi
  done
  return "$rc"
}

# --- a custom target is validated and nothing else: the negative cases point here --------------
if [ "$CHECK" != "$DEFAULT_CHECK" ] || [ "$TESTS" != "$HERE" ]; then
  if ! bad="$(unwired "$CHECK" "$TESTS")"; then
    fail "unwired suites in $TESTS: ${bad//$'\n'/ }"
  fi
  echo "PASS custom-target-wired"
  exit 0
fi

# --- every named suite must be run by the gate -------------------------------------------------
wired() { # <case> <suite-file>
  local name="$1" base="$2" body
  body="$(job_body "$CHECK")" || exit 1
  grep -qF "tests/$base" <<<"$body" || fail "$name: $base is not named in job_shell_test() of $CHECK"
  echo "PASS $name"
}

wired wired-node-stamp node-stamp-test.sh
wired wired-escalate test-escalate.sh
wired wired-gate-backpressure test-gate-backpressure.sh
wired wired-outside-tests test-outside-tests.sh
wired wired-throughput test-throughput.sh
wired wired-merge-gen-resolve test-merge-gen-resolve.sh

# And no suite may be left behind: a newly added file is unwired until check.sh names it.
if ! bad="$(unwired "$CHECK" "$TESTS")"; then
  fail "unwired suites in $TESTS: ${bad//$'\n'/ }"
fi
echo "PASS all-suites-wired"

# --- negative cases: each points the checker at a temp copy ------------------------------------

# An extra suite the check.sh copy does not name must fail the checker and be named in its output.
mkdir -p "$T/unwired"
cp "$DEFAULT_CHECK" "$T/unwired/check.sh"
cp -R "$HERE" "$T/unwired/tests"
printf '#!/bin/bash\nexit 0\n' > "$T/unwired/tests/test-not-wired-extra.sh"
if out="$(RSI_CHECK_SH="$T/unwired/check.sh" RSI_TESTS_DIR="$T/unwired/tests" bash "$HERE/test-wiring.sh" 2>&1)"; then
  fail "unwired-fails: checker exited 0"
fi
grep -q 'test-not-wired-extra.sh' <<<"$out" || fail "unwired-fails: output does not name the suite: $out"
echo "PASS unwired-fails"

# A missing check.sh is a failure, never a silent pass.
if out="$(RSI_CHECK_SH="$T/unwired/nope.sh" RSI_TESTS_DIR="$HERE" bash "$HERE/test-wiring.sh" 2>&1)"; then
  fail "missing-check-sh-fails: checker exited 0"
fi
grep -q 'check.sh' <<<"$out" || fail "missing-check-sh-fails: output does not name check.sh: $out"
echo "PASS missing-check-sh-fails"
