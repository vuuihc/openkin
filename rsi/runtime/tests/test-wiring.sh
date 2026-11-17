#!/bin/bash
# test-wiring.sh — every guard the loop keeps for itself must actually run in the gate.
#
# scripts/check.sh's job_shell_test() is the only job that runs the loop's shell
# suites, so a suite that exists under rsi/runtime but is not named there never
# runs: not in a PR gate, not in CI. This test enumerates every suite directory and
# requires every *.sh in it to be named in that function, by its full repo-relative
# path so equal basenames in different directories cannot collide. Comments are
# stripped from the function body first, so a commented-out line is not wiring.
#
# RSI_CHECK_SH / RSI_TESTS_DIR point the checker at another check.sh and tests dir
# (the negative cases below use a temp copy); with either set, only that pair is
# enumerated, so a negative case cannot recurse into itself.
#
# Hermetic: temp dirs, no network. Prints "PASS <case>" per case and exits non-zero
# on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
DEFAULT_CHECK="$REPO/scripts/check.sh"
CHECK="${RSI_CHECK_SH:-$DEFAULT_CHECK}"
TESTS="${RSI_TESTS_DIR:-$HERE}"
# Every directory that holds loop suites. ux/ is enumerated too; its one
# non-hermetic suite is allowlisted in allow_unwired() below.
SUITE_DIRS=("$HERE" "$RUNTIME/nas/tests" "$RUNTIME/ux")
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL $*" >&2; exit 1; }

# job_body <check.sh> — print the body of job_shell_test(), the job that runs loop suites.
job_body() {
  local f="$1" body
  [ -f "$f" ] && [ -r "$f" ] || fail "check.sh missing or unreadable: $f"
  body="$(awk '/^job_shell_test\(\)[[:space:]]*\{/ { on = 1 } on { print } on && /^\}/ { exit }' "$f")"
  [ -n "$body" ] || fail "check.sh has no job_shell_test(): $f"
  # Strip shell comments: a commented-out wiring line must not satisfy the check.
  body="$(sed -E 's/(^|[[:space:]])#.*$//' <<<"$body")"
  printf '%s\n' "$body"
}

# named <body> <path> — true when an executable line names <path> as a whole word.
# A temp copy keeps the real check.sh (repo-relative paths) beside a copied tests
# dir, so the tests/<base> suffix is accepted too.
named() {
  awk -v p="$2" '{
    s = "/" p
    for (i = 1; i <= NF; i++)
      if ($i == p || substr($i, length($i) - length(s) + 1) == s) { found = 1; exit }
  } END { exit !found }' <<<"$1"
}

# allow_unwired <repo-relative path> — suites deliberately kept out of the gate.
allow_unwired() {
  case "$1" in
    # needs a built kin binary (UX_KIN_BIN), so it is not hermetic
    rsi/runtime/ux/gate-test.sh) return 0 ;;
  esac
  return 1
}

# unwired <check.sh> <suite-dir> — print every suite file that job_shell_test() does not name.
unwired() {
  local check="$1" dir="$2" body f rel rc=0
  [ -d "$dir" ] || fail "suite dir missing: $dir"
  body="$(job_body "$check")" || exit 1
  for f in "$dir"/*.sh; do
    [ -e "$f" ] || fail "no *.sh suites in $dir"
    rel="${f#"$REPO"/}"
    [ "$rel" = "$f" ] && rel="tests/${f##*/}"
    allow_unwired "$rel" && continue
    if ! named "$body" "$rel"; then
      echo "$rel"
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
wired() { # <case> <repo-relative suite path>
  local name="$1" path="$2" body
  body="$(job_body "$CHECK")" || exit 1
  named "$body" "$path" || fail "$name: $path is not named in job_shell_test() of $CHECK"
  echo "PASS $name"
}

wired wired-node-stamp rsi/runtime/tests/node-stamp-test.sh
wired wired-escalate rsi/runtime/tests/test-escalate.sh
wired wired-gate-backpressure rsi/runtime/tests/test-gate-backpressure.sh
wired wired-outside-tests rsi/runtime/tests/test-outside-tests.sh
wired wired-throughput rsi/runtime/tests/test-throughput.sh
wired wired-merge-gen-resolve rsi/runtime/tests/test-merge-gen-resolve.sh
wired wired-nas rsi/runtime/nas/tests/test-nas.sh
wired wired-ux-retry rsi/runtime/ux/retry-test.sh

# And no suite may be left behind: a newly added file is unwired until check.sh names it.
for d in "${SUITE_DIRS[@]}"; do
  if ! bad="$(unwired "$CHECK" "$d")"; then
    fail "unwired suites in $d: ${bad//$'\n'/ }"
  fi
done
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

# A commented-out wiring line does not count: the suite must still be reported unwired.
mkdir -p "$T/commented/tests"
printf '#!/bin/bash\nexit 0\n' > "$T/commented/tests/test-real.sh"
printf '#!/bin/bash\nexit 0\n' > "$T/commented/tests/test-commented.sh"
cat > "$T/commented/check.sh" <<'EOF'
job_shell_test() {
  # bash tests/test-commented.sh || return 1
  bash tests/test-real.sh || return 1
}
EOF
if out="$(RSI_CHECK_SH="$T/commented/check.sh" RSI_TESTS_DIR="$T/commented/tests" bash "$HERE/test-wiring.sh" 2>&1)"; then
  fail "commented-out-fails: checker exited 0"
fi
grep -q 'test-commented.sh' <<<"$out" || fail "commented-out-fails: output does not name the commented suite: $out"
grep -q 'test-real.sh' <<<"$out" && fail "commented-out-fails: wired suite reported unwired: $out"
echo "PASS commented-out-fails"

# A missing check.sh is a failure, never a silent pass.
if out="$(RSI_CHECK_SH="$T/unwired/nope.sh" RSI_TESTS_DIR="$HERE" bash "$HERE/test-wiring.sh" 2>&1)"; then
  fail "missing-check-sh-fails: checker exited 0"
fi
grep -q 'check.sh' <<<"$out" || fail "missing-check-sh-fails: output does not name check.sh: $out"
echo "PASS missing-check-sh-fails"
