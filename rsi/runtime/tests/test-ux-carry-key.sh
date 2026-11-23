#!/bin/bash
# test-ux-carry-key.sh — a cached UX walk survives a main move that cannot change the rendered
# console: a move touching nothing under ui/, or only test/spec/fixture/mutant/markdown files.
# It is thrown away when a rendered input, the PR's lockfile half, the PR diff or the recorded
# evidence moved. The key is what the merge lane stores in state/merge/<slug>.uxverified, so a
# narrower key here is the whole point: one test-only main move used to cost a ~20 min walk.
#
# Hermetic: temp git repos under mktemp -d. No network, no npm, no python beyond the stdlib.
# Exercises merge.sh --ux-carry-key-check, which prints the KEY the UX-gate block reads and runs
# the same ux_carry_verdict() the land loop calls. Prints "PASS <case>" per case and exits
# non-zero on the first failure. Set RSI_TEST_ONLY=<case name> to run one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
R=""; OUT=""; RC=0; V=""; CASE="setup"; K0=""; K1=""
ONLY="${RSI_TEST_ONLY:-}"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $CASE: $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# --- fixture -----------------------------------------------------------------------------------

# new_repo <name> — one file per path family the cases move, `main` committed and published on
# refs/remotes/origin/main, the PR branch `feat` checked out.
new_repo() {
  R="$T/$1"; rm -rf "$R"; mkdir -p "$R"
  g init -q -b main || fail "git init"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  mkdir -p "$R/ui/src/pages" "$R/docs"
  printf 'page\n' > "$R/ui/src/pages/X.tsx"
  printf 'test\n' > "$R/ui/src/pages/X.dom.test.tsx"
  printf 'css\n' > "$R/ui/src/index.css"
  printf '{}\n' > "$R/ui/package.json"
  printf '{"lockfileVersion": 3}\n' > "$R/ui/package-lock.json"
  printf 'docs\n' > "$R/docs/x.md"
  g add -A >/dev/null && g commit -q -m base || fail "base commit"
  g update-ref refs/remotes/origin/main HEAD
  g checkout -q -b feat || fail "checkout feat"
}

# main_move <path> <text> — rewrite <path> on main (creating it when new), commit, publish
# origin/main, and leave the PR branch checked out. The key is a fact of origin/main, not of the
# merge, so the cases can read it before the PR branch syncs.
main_move() {
  g checkout -q main || fail "checkout main"
  printf '%s\n' "$2" > "$R/$1" || fail "write $1 on main"
  g add -A >/dev/null && g commit -q -m "main moves $1" || fail "main commit"
  g update-ref refs/remotes/origin/main main
  g checkout -q feat || fail "checkout feat"
}

# --- seam helpers ------------------------------------------------------------------------------

# seam <main-ref> <uxverified-file> <pr-diff-hash> — one hermetic run of the same key + verdict
# the UX-gate block reads; sets OUT and RC. The guard makes a merge.sh without the seam fail this
# case fast instead of falling through into the dispatcher, which is what the red-first run sees.
seam() {
  grep -qF -- '--ux-carry-key-check' "$MERGE" || fail "merge.sh has no --ux-carry-key-check seam"
  OUT="$(RSI_CTRL="$T/ctrl" bash "$MERGE" --ux-carry-key-check "$R" "$1" "${2:-}" "${3:-}" 2>&1)"; RC=$?
}

# key_now <main-ref> — the KEY line's digest of the ui/ inputs at <main-ref>.
key_now() { seam "$1" "" ""; printf '%s\n' "$OUT" | sed -n 's/^KEY //p'; }

# record_walk <name> <main-ref> <diff-hash> — the evidence a PASS walk leaves behind: the recorded
# PR diff, PASS, and the key the seam reports for <main-ref> plus the PR head's lockfile half,
# the same shape the land block writes.
record_walk() {
  V="$T/$1.uxverified"
  printf '%s PASS %s-%s\n' "$3" "$(key_now "$2")" "$(g rev-parse HEAD:ui/package-lock.json)" > "$V"
  [ -s "$V" ] || fail "could not write $V"
}

expect_carry() {
  [ "$RC" -eq 0 ] || fail "re-gated, expected a carry ($OUT)"
  printf '%s\n' "$OUT" | grep -q '^CARRY ' || fail "the seam did not print CARRY ($OUT)"
}

expect_regate() {
  [ "$RC" -ne 0 ] || fail "carried, expected a re-gate ($OUT)"
  printf '%s\n' "$OUT" | grep -q '^REGATE ' || fail "the seam did not print REGATE ($OUT)"
}

# --- cases -------------------------------------------------------------------------------------

# The motivating case: 44d6bcef added one *.dom.test.tsx to main while UI PRs were verified, and
# every walk was thrown away. A test-only move cannot change the rendered console, so it carries.
test_a_test_only_main_move_carries() {
  new_repo c1
  K0="$(key_now origin/main)"
  [ -n "$K0" ] || fail "the seam printed no KEY"
  record_walk c1 origin/main DH1
  main_move ui/src/pages/X.dom.test.tsx 'test moved'
  K1="$(key_now origin/main)"
  [ "$K0" = "$K1" ] || fail "a test-only main move changed the carry key ($K0 -> $K1)"
  seam origin/main "$V" DH1
  expect_carry
}

# A rendered page moved: the walk's screenshots no longer describe main. Re-walk.
test_a_rendered_tsx_move_regates() {
  new_repo c2
  K0="$(key_now origin/main)"
  record_walk c2 origin/main DH2
  main_move ui/src/pages/X.tsx 'page moved'
  K1="$(key_now origin/main)"
  [ "$K0" != "$K1" ] || fail "a rendered .tsx move left the carry key unchanged"
  seam origin/main "$V" DH2
  expect_regate
}

# Stylesheet moved: same verdict as any other rendered input.
test_a_css_move_regates() {
  new_repo c3
  K0="$(key_now origin/main)"
  record_walk c3 origin/main DH3
  main_move ui/src/index.css 'body { color: red; }'
  K1="$(key_now origin/main)"
  [ "$K0" != "$K1" ] || fail "a css move left the carry key unchanged"
  seam origin/main "$V" DH3
  expect_regate
}

# A mutant manifest under ui/ is test machinery, not a rendered input.
test_a_mutants_json_move_carries() {
  new_repo c4
  K0="$(key_now origin/main)"
  record_walk c4 origin/main DH4
  main_move ui/src/pages/X.mutants.json '[]'
  K1="$(key_now origin/main)"
  [ "$K0" = "$K1" ] || fail "a mutants manifest changed the carry key"
  seam origin/main "$V" DH4
  expect_carry
}

# Nothing under ui/ moved at all.
test_a_non_ui_move_carries() {
  new_repo c5
  K0="$(key_now origin/main)"
  record_walk c5 origin/main DH5
  main_move docs/x.md 'docs moved'
  K1="$(key_now origin/main)"
  [ "$K0" = "$K1" ] || fail "a non-ui move changed the carry key"
  seam origin/main "$V" DH5
  expect_carry
}

# The dependency graph moved: a lockfile can change what the console renders, and it is half of
# the key exactly as before this row. The PR syncs main, so its own half moves too; evidence that
# names the ui/ digest without the PR's lockfile half is not a match either.
test_a_main_lockfile_move_regates() {
  new_repo c6
  record_walk c6 origin/main DH6
  main_move ui/package-lock.json '{"lockfileVersion": 3, "moved": true}'
  g merge -q --no-edit origin/main >/dev/null 2>&1 || fail "merge of origin/main conflicted"
  seam origin/main "$V" DH6
  expect_regate
  V="$T/c6-nohalf.uxverified"
  printf '%s PASS %s\n' DH6 "$(key_now origin/main)" > "$V"
  seam origin/main "$V" DH6
  expect_regate
}

# The cache is only evidence for the diff it walked. A different PR diff, absent evidence, or a
# recorded FAIL all re-walk.
test_a_changed_pr_diff_or_missing_evidence_regates() {
  new_repo c7
  record_walk c7 origin/main DH7
  seam origin/main "$V" DH-other
  expect_regate
  V="$T/c7-missing.uxverified"; rm -f "$V"
  seam origin/main "$V" DH7
  expect_regate
  V="$T/c7-failed.uxverified"
  printf '%s FAIL %s-%s\n' DH7 "$(key_now origin/main)" "$(g rev-parse HEAD:ui/package-lock.json)" > "$V"
  seam origin/main "$V" DH7
  expect_regate
}

# Wiring pin (AGENTS §12): a suite the gate does not name is not a guard. The check.sh mutant
# that deletes this line makes the case red.
test_the_gate_names_this_suite() {
  grep -qF 'bash rsi/runtime/tests/test-ux-carry-key.sh || return 1' "$ROOT/scripts/check.sh" \
    || fail "scripts/check.sh does not run rsi/runtime/tests/test-ux-carry-key.sh"
}

run() {
  CASE="$1"
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$1" || exit 1
  pass "$1"
}

run test_a_test_only_main_move_carries
run test_a_rendered_tsx_move_regates
run test_a_css_move_regates
run test_a_mutants_json_move_carries
run test_a_non_ui_move_carries
run test_a_main_lockfile_move_regates
run test_a_changed_pr_diff_or_missing_evidence_regates
run test_the_gate_names_this_suite
echo ALL-PASS
