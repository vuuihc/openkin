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
# The python suites under scripts/ are enumerated too: a *_test.py or *.test.py
# that no job in check.sh names never runs, and can rot or be deleted silently.
# Any job may run one, so the search covers the whole file, comments stripped;
# allow_unwired_py() carries the measured reason for a suite kept out. That
# reason is only honest while the suite runs somewhere else, so every
# allowlisted suite must also be named in the CI workflow (comments stripped):
# allowlisted in one place and run nowhere is rot with a note attached. The
# RSI_SCRIPTS_DIR seam points that section at another scripts dir (the python
# negative cases use a temp one) and is honoured only when the directory
# exists; RSI_CI_FILE does the same for the workflow file.
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
SCRIPTS="${RSI_SCRIPTS_DIR:-$REPO/scripts}"
# RSI_CI_FILE points the CI half at another workflow file; like RSI_SCRIPTS_DIR
# it is honoured only when the file exists, so a stale path falls back to the
# real workflow rather than silently passing everything.
CI="${RSI_CI_FILE:-}"
[ -f "$CI" ] || CI="$REPO/.github/workflows/ci.yml"
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

# allow_unwired_py <repo-relative path> — python suites deliberately kept out of
# check.sh, each with the measured reason. Both are hermetic but too slow to run
# on every change, so they run in CI instead; py_unwired() requires each of them
# to be named in $CI, so this list cannot outlive the job that runs it.
allow_unwired_py() {
  case "$1" in
    # 49 s measured here (40 cases); the #251 review measured ~58 s. Each case
    # runs the real seed script against a local http.server stub, which is why
    # it is not in the always-on gate.
    scripts/journeys_seed_test.py) return 0 ;;
    # 17 s measured (3 cases): three deliberate sleeps (2.5 s pending window,
    # 3 s default hold, 10 s clamp), so hermetic is not the same as cheap.
    scripts/journeys_fake_agent_test.py) return 0 ;;
  esac
  return 1
}

# whole_body <check.sh> — the whole file with shell comments stripped: any job may
# run a python suite, so unlike job_body() this does not stop at job_shell_test().
whole_body() {
  local f="$1"
  [ -f "$f" ] && [ -r "$f" ] || fail "check.sh missing or unreadable: $f"
  sed -E 's/(^|[[:space:]])#.*$//' "$f"
}

# ci_body <ci.yml> — the workflow with YAML comments stripped: a suite named
# only in a comment, or in a commented-out step, must not count as wired.
ci_body() {
  local f="$1"
  [ -f "$f" ] && [ -r "$f" ] || fail "ci workflow missing or unreadable: $f"
  sed -E 's/(^|[[:space:]])#.*$//' "$f"
}

# py_unwired <check.sh> <scripts-dir> — print every python suite that runs
# nowhere: one not named by any job in <check.sh> and not allowlisted, or one
# allowlisted but not named in $CI. A trailing slash on the dir is ignored, so
# it cannot turn every path into "scripts//name".
py_unwired() {
  local check="$1" dir="${2%/}" body ci f rel rc=0
  [ -d "$dir" ] || fail "scripts dir missing: $dir"
  body="$(whole_body "$check")" || exit 1
  ci="$(ci_body "$CI")" || exit 1
  for f in "$dir"/*_test.py "$dir"/*.test.py; do
    [ -e "$f" ] || continue
    rel="${f#"$REPO"/}"
    [ "$rel" = "$f" ] && rel="scripts/${f##*/}"
    if allow_unwired_py "$rel"; then
      if ! named "$ci" "$rel"; then
        echo "$rel (allowlisted, but not named in $CI)"
        rc=1
      fi
      continue
    fi
    if ! named "$body" "$rel"; then
      echo "$rel"
      rc=1
    fi
  done
  return "$rc"
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
  # Only when the python section was pointed at its own temp dir: the shell-only
  # negative cases must not be judged against the repo's real scripts/*_test.py.
  if [ -n "${RSI_SCRIPTS_DIR:-}" ] && [ -d "$SCRIPTS" ]; then
    if ! bad="$(py_unwired "$CHECK" "$SCRIPTS")"; then
      fail "unwired python suites in $SCRIPTS: ${bad//$'\n'/ }"
    fi
    echo "PASS custom-target-python-wired"
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

# And no python suite may be left behind: a new scripts/*_test.py is unwired
# until some job in check.sh names it.
if ! bad="$(py_unwired "$CHECK" "$SCRIPTS")"; then
  fail "unwired python suites in $SCRIPTS: ${bad//$'\n'/ }"
fi
echo "PASS all-python-suites-wired"

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

# --- python suites: the same two negatives, against a temp check.sh and scripts dir -------------
# ui_lint_guard_test.py stands in for a suite that is already named, so the case
# also proves the python section does not report a wired file. journeys_extra.test.py
# covers the *.test.py half of the enumeration, which no checked-in suite exercises.
PY="$T/py"
mkdir -p "$PY/scripts"
printf '#!/usr/bin/env python3\n' > "$PY/scripts/journeys_walk_test.py"
printf '#!/usr/bin/env python3\n' > "$PY/scripts/journeys_extra.test.py"
printf '#!/usr/bin/env python3\n' > "$PY/scripts/ui_lint_guard_test.py"

# A python suite the check.sh copy does not name must fail the checker and be named.
grep -v 'scripts/journeys_walk_test\.py' "$DEFAULT_CHECK" > "$PY/check.sh"
if out="$(RSI_CHECK_SH="$PY/check.sh" RSI_SCRIPTS_DIR="$PY/scripts" bash "$HERE/test-wiring.sh" 2>&1)"; then
  fail "python-suite-fails: checker exited 0"
fi
grep -q 'scripts/journeys_walk_test.py' <<<"$out" || fail "python-suite-fails: output does not name the suite: $out"
grep -q 'scripts/journeys_extra.test.py' <<<"$out" || fail "python-suite-fails: output does not name the .test.py suite: $out"
grep -q 'ui_lint_guard_test.py' <<<"$out" && fail "python-suite-fails: wired python suite reported unwired: $out"
echo "PASS python-suite-fails"

# A commented-out python wiring line does not count: the suite must still be reported.
awk '{ if ($0 ~ /journeys_walk_test\.py/) sub(/^[[:space:]]*/, "  # "); print }' \
  "$DEFAULT_CHECK" > "$PY/check-commented.sh"
if out="$(RSI_CHECK_SH="$PY/check-commented.sh" RSI_SCRIPTS_DIR="$PY/scripts" bash "$HERE/test-wiring.sh" 2>&1)"; then
  fail "python-commented-out-fails: checker exited 0"
fi
grep -q 'scripts/journeys_walk_test.py' <<<"$out" || fail "python-commented-out-fails: output does not name the suite: $out"
grep -q 'scripts/journeys_extra.test.py' <<<"$out" || fail "python-commented-out-fails: output does not name the .test.py suite: $out"
grep -q 'ui_lint_guard_test.py' <<<"$out" && fail "python-commented-out-fails: wired python suite reported unwired: $out"
echo "PASS python-commented-out-fails"

# --- allowlisted suites must be named in the CI workflow ---------------------------------------
# A temp scripts dir holding the two allowlisted basenames stands in for the
# real ones; the real check.sh copy names none of them (that is the point of the
# allowlist), so only RSI_CI_FILE decides whether they pass.
CIDIR="$T/ci"
mkdir -p "$CIDIR/scripts"
printf '#!/usr/bin/env python3\n' > "$CIDIR/scripts/journeys_seed_test.py"
printf '#!/usr/bin/env python3\n' > "$CIDIR/scripts/journeys_fake_agent_test.py"
cp "$DEFAULT_CHECK" "$CIDIR/check.sh"

# A suite named in CI and one omitted: the omitted one must fail and be named.
cat > "$CIDIR/ci-one.yml" <<'EOF'
jobs:
  journeys:
    runs-on: ubuntu-latest
    steps:
      - run: python3 -B scripts/journeys_seed_test.py
EOF
if out="$(RSI_CHECK_SH="$CIDIR/check.sh" RSI_SCRIPTS_DIR="$CIDIR/scripts" RSI_CI_FILE="$CIDIR/ci-one.yml" bash "$HERE/test-wiring.sh" 2>&1)"; then
  fail "ci-missing-suite-fails: checker exited 0"
fi
grep -q 'scripts/journeys_fake_agent_test.py' <<<"$out" || fail "ci-missing-suite-fails: output does not name the suite missing from CI: $out"
grep -q 'scripts/journeys_seed_test.py' <<<"$out" && fail "ci-missing-suite-fails: suite named in CI reported unwired: $out"
echo "PASS ci-missing-suite-fails"

# A suite named only inside a YAML comment does not count: it must be reported.
cat > "$CIDIR/ci-commented.yml" <<'EOF'
jobs:
  journeys:
    runs-on: ubuntu-latest
    steps:
      - run: python3 -B scripts/journeys_seed_test.py
      # - run: python3 -B scripts/journeys_fake_agent_test.py
EOF
if out="$(RSI_CHECK_SH="$CIDIR/check.sh" RSI_SCRIPTS_DIR="$CIDIR/scripts" RSI_CI_FILE="$CIDIR/ci-commented.yml" bash "$HERE/test-wiring.sh" 2>&1)"; then
  fail "ci-commented-out-fails: checker exited 0"
fi
grep -q 'scripts/journeys_fake_agent_test.py' <<<"$out" || fail "ci-commented-out-fails: output does not name the commented suite: $out"
grep -q 'scripts/journeys_seed_test.py' <<<"$out" && fail "ci-commented-out-fails: suite named in CI reported unwired: $out"
echo "PASS ci-commented-out-fails"

# Both named: the seam must pass too, so the rule is not just always red.
cat > "$CIDIR/ci-both.yml" <<'EOF'
jobs:
  journeys:
    steps:
      - run: |
          python3 -B scripts/journeys_seed_test.py
          python3 -B scripts/journeys_fake_agent_test.py
EOF
if ! out="$(RSI_CHECK_SH="$CIDIR/check.sh" RSI_SCRIPTS_DIR="$CIDIR/scripts" RSI_CI_FILE="$CIDIR/ci-both.yml" bash "$HERE/test-wiring.sh" 2>&1)"; then
  fail "ci-both-named-passes: checker failed: $out"
fi
grep -q 'PASS custom-target-python-wired' <<<"$out" || fail "ci-both-named-passes: python section did not pass: $out"
echo "PASS ci-both-named-passes"
