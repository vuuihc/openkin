#!/bin/bash
# test-outside-tests.sh — hermetic checks for runtime/outside-tests.py
#
# 2026-11-21 (#506): #506 changed task.notFound in ui/src/i18n/locales/{en,zh}.ts
# from "Task not found" to "Conversation not found". ui/src/pages/
# TaskSessionHost.handoff.dom.test.tsx still asserted the old literal, so the
# failure was caused by that very PR — but the test file was outside the PR's
# paths and classify() called it "outside PR footprint". merge.sh then reran CI
# every cycle and never sent the PR back; a person patched the test by hand.
# These cases pin the locale rule (a locale value change puts UI tests that
# assert copy in scope) and its boundaries (Go and non-test failures stay out).
#
# Hermetic: temp fixtures only. --changed-files and --log are explicit and
# --module is passed, so no git repo, go.mod or network is read.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used by the mutants manifest).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/outside-tests.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
MOD=github.com/vuuihc/openkin

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
want_case() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# classify <changed-file-list> <log-file> — leaves the classifier's one line in
# OUT and its exit code in RC (0 mechanical, 1 quality/sendback). Both are set
# in this shell, not a subshell, so callers can assert on them.
OUT=""
RC=0
classify() {
  OUT="$(python3 "$SCRIPT" --worktree "$T" --module "$MOD" \
    --known "$T/known-none.txt" --changed-files "$1" --log "$2" 2>&1)"
  RC=$?
}

expect_rc() { # <case> <want> <got> <out>
  [ "$3" -eq "$2" ] || fail "$1: exit $3, want $2: $4"
}
expect_prefix() { # <case> <prefix> <out>
  case "$3" in "$2"*) ;; *) fail "$1: output does not start with $2: $3" ;; esac
}
expect_contains() { # <case> <needle> <out>
  case "$3" in *"$2"*) ;; *) fail "$1: output does not contain '$2': $3" ;; esac
}
expect_absent() { # <case> <needle> <out>
  case "$3" in *"$2"*) fail "$1: output unexpectedly contains '$2': $3" ;; *) ;; esac
}

# A PR that changes locale values only.
locale_changed() { printf 'ui/src/i18n/locales/en.ts\nui/src/i18n/locales/zh.ts\n'; }

# --- 1. a locale value change sends back a UI test asserting the old copy ----
test_locale_value_change_sends_back() {
  want_case test_locale_value_change_sends_back || return 0
  local c=test_locale_value_change_sends_back
  locale_changed > "$T/c1.changed"
  printf 'FAIL  src/pages/TaskSessionHost.handoff.dom.test.tsx > shows the missing conversation\n' > "$T/c1.log"
  classify "$T/c1.changed" "$T/c1.log"
  expect_rc "$c" 1 "$RC" "$OUT"
  expect_prefix "$c" "QUALITY:" "$OUT"
  expect_contains "$c" "TaskSessionHost.handoff.dom.test.tsx" "$OUT"
  expect_contains "$c" "ui/src/pages" "$OUT"
  expect_contains "$c" "locale" "$OUT"
  pass "$c"
}

# --- 2. a locale change does not pull a Go failure into scope ----------------
test_locale_change_keeps_go_tests_mechanical() {
  want_case test_locale_change_keeps_go_tests_mechanical || return 0
  local c=test_locale_change_keeps_go_tests_mechanical
  locale_changed > "$T/c2.changed"
  {
    printf -- '--- FAIL: TestFoo (0.01s)\n'
    printf '    foo_test.go:12: boom\n'
    printf 'FAIL\n'
    printf 'FAIL\tgithub.com/vuuihc/openkin/internal/node\t0.012s\n'
  } > "$T/c2.log"
  classify "$T/c2.changed" "$T/c2.log"
  expect_rc "$c" 0 "$RC" "$OUT"
  expect_prefix "$c" "MECHANICAL:" "$OUT"
  expect_contains "$c" "outside PR footprint" "$OUT"
  pass "$c"
}

# --- 3. without a locale change an outside UI test is still a rerun-once -----
test_ui_change_without_locale_keeps_outside_test_mechanical() {
  want_case test_ui_change_without_locale_keeps_outside_test_mechanical || return 0
  local c=test_ui_change_without_locale_keeps_outside_test_mechanical
  # ui/src/main.tsx is a sibling of ui/src/pages, so the package is not touched.
  printf 'ui/src/main.tsx\n' > "$T/c3.changed"
  printf 'FAIL  src/pages/Settings.test.tsx > renders\n' > "$T/c3.log"
  classify "$T/c3.changed" "$T/c3.log"
  expect_rc "$c" 0 "$RC" "$OUT"
  expect_prefix "$c" "MECHANICAL:" "$OUT"
  expect_contains "$c" "outside PR footprint" "$OUT"
  pass "$c"
}

# --- 4. the locale rule never swallows a non-test failure -------------------
test_locale_rule_does_not_swallow_non_test_failures() {
  want_case test_locale_rule_does_not_swallow_non_test_failures || return 0
  local c=test_locale_rule_does_not_swallow_non_test_failures
  locale_changed > "$T/c4.changed"
  printf "ui  Typecheck  2026-11-21T07:58:00.0Z  error TS2322: Type 'X' is not assignable\n" > "$T/c4.log"
  classify "$T/c4.changed" "$T/c4.log"
  expect_rc "$c" 1 "$RC" "$OUT"
  expect_prefix "$c" "QUALITY:" "$OUT"
  expect_contains "$c" "non-test" "$OUT"
  expect_absent "$c" "locale" "$OUT"
  pass "$c"
}

# 2026-11-25 (#712): on a machine at load avg ~370 the vitest pool starved
# ("[vitest-pool]: Failed to start forks worker", "[vitest-pool-runner]:
# Timeout waiting for worker to respond") and failed in-footprint test files;
# classify() sent the PR back as QUALITY. Pool starvation is machine load, so
# it is a rerun-once — but it must not swallow a real non-test failure, and
# without pool lines the footprint still decides.

# --- 5. a starved pool makes an in-footprint failure a mechanical rerun -----
test_starved_pool_makes_in_footprint_failure_mechanical() {
  want_case test_starved_pool_makes_in_footprint_failure_mechanical || return 0
  local c=test_starved_pool_makes_in_footprint_failure_mechanical
  printf 'ui/src/design/x.ts\n' > "$T/c5.changed"
  {
    printf 'FAIL  src/design/tailwind.test.ts > cascade foundation\n'
    printf '\033[31m\033[1mError\033[22m: [vitest-pool]: Failed to start forks worker for test files /x.ts.\033[39m\n'
    printf 'Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond\n'
  } > "$T/c5.log"
  classify "$T/c5.changed" "$T/c5.log"
  expect_rc "$c" 0 "$RC" "$OUT"
  expect_prefix "$c" "MECHANICAL:" "$OUT"
  expect_contains "$c" "starved" "$OUT"
  pass "$c"
}

# --- 6. without pool lines an in-footprint failure is still a sendback ------
test_in_footprint_failure_without_pool_lines_is_quality() {
  want_case test_in_footprint_failure_without_pool_lines_is_quality || return 0
  local c=test_in_footprint_failure_without_pool_lines_is_quality
  printf 'ui/src/design/x.ts\n' > "$T/c6.changed"
  printf 'FAIL  src/design/tailwind.test.ts > cascade foundation\n' > "$T/c6.log"
  classify "$T/c6.changed" "$T/c6.log"
  expect_rc "$c" 1 "$RC" "$OUT"
  expect_prefix "$c" "QUALITY:" "$OUT"
  expect_contains "$c" "touched package" "$OUT"
  pass "$c"
}

# --- 7. pool starvation never swallows a non-test failure -------------------
test_starved_pool_does_not_swallow_non_test_failures() {
  want_case test_starved_pool_does_not_swallow_non_test_failures || return 0
  local c=test_starved_pool_does_not_swallow_non_test_failures
  printf 'ui/src/design/x.ts\n' > "$T/c7.changed"
  {
    printf 'FAIL  src/design/tailwind.test.ts > cascade foundation\n'
    printf 'Error: [vitest-pool]: Failed to start forks worker for test files /x.ts.\n'
    printf "ui  Typecheck  2026-11-25T08:00:00.0Z  error TS2322: Type 'X' is not assignable\n"
  } > "$T/c7.log"
  classify "$T/c7.changed" "$T/c7.log"
  expect_rc "$c" 1 "$RC" "$OUT"
  expect_prefix "$c" "QUALITY:" "$OUT"
  expect_contains "$c" "non-test" "$OUT"
  pass "$c"
}

# The python self-test covers the same rule in-process; skip it when one named
# case is requested so a mutant is judged by that case alone.
if [ -z "$ONLY" ]; then
  python3 "$SCRIPT" --self-test || fail "self-test"
fi

test_locale_value_change_sends_back
test_locale_change_keeps_go_tests_mechanical
test_ui_change_without_locale_keeps_outside_test_mechanical
test_locale_rule_does_not_swallow_non_test_failures
test_starved_pool_makes_in_footprint_failure_mechanical
test_in_footprint_failure_without_pool_lines_is_quality
test_starved_pool_does_not_swallow_non_test_failures

echo "test-outside-tests: ALL-PASS"
