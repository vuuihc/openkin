#!/bin/bash
# test-lane-mutants.sh — a lane cannot hand off a loop guard whose proof does not exist.
#
# The live rework shape `gate+review·rsi` (55 of 357 rounds in the 11-14→11-21 window) is mostly
# one finding: the changed guard's own test does not fail when the guard is broken. The reviewer
# was the first reader to notice (sendback/done/merge-sync-abort-090823, lane-leftovers-095231,
# walk-select-guard-071822, phone-console-baseline-b-045503). `scripts/mutants.py` already proves
# a test notices a mutant; what was missing is a hand-off rule. `lane.sh --mutant-evidence-check`
# decides which changed loop files need one, runs every covering manifest, and fails closed on a
# missing entry, a surviving mutant, a malformed manifest or a missing runner. lane.sh runs the
# same seam after the format commit and before the push, and the worker contract tells the worker
# to run it first.
#
# Hermetic: one bare origin and one worktree per case under mktemp -d, RSI_CTRL redirected into the
# temp dir (common.sh derives STATE and RSI_DIR from it), a stubbed lane-pr.sh. No network, no gh,
# no npm, no model calls. Each fixture's main commit seeds the real scripts/mutants.py so the
# runner is never itself a "changed" file (except the case that removes it on purpose).
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$RUNTIME/../.." && pwd)"
LANE="$RUNTIME/lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
CTRL="$T/ctrl"; mkdir -p "$CTRL/rsi/state/lanes" "$CTRL/rsi/runtime"
# lane.sh sources $RSI_DIR/runtime/lane-pr.sh before any seam. A stub keeps the seam hermetic.
printf '#!/bin/bash\n# stub: the seams never create a PR\n' > "$CTRL/rsi/runtime/lane-pr.sh"
R=""   # the worktree the current case works on
ONLY="${RSI_TEST_ONLY:-}"
OUT=""; RC=0

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# new_repo <name> [no-runner] — bare origin inside the temp dir plus a worktree on main. Main seeds
# README, a loop file (lane.sh) and an unrelated loop file (other.sh) the cases never change, and
# the real scripts/mutants.py unless the case is the one that proves a missing runner fails closed.
new_repo() {
  local name="$1" runner="${2:-}"
  R="$T/$name"; rm -rf "$R" "$T/$name.git"
  git init -q --bare "$T/$name.git" || fail "$name: bare init failed"
  git init -q -b main "$R" || fail "$name: git init failed"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  printf 'base\n' > "$R/README.md"
  # The real repo ignores built bundles; a lane that ran `npm run build` must still look clean.
  printf 'web/dist/assets/\n' > "$R/.gitignore"
  mkdir -p "$R/rsi/runtime" "$R/scripts"
  printf 'GUARD=enabled\n' > "$R/rsi/runtime/lane.sh"
  printf 'GUARD=other\n' > "$R/rsi/runtime/other.sh"
  printf '#!/usr/bin/env python3\nTOOL=on\n' > "$R/scripts/loop_tool.py"
  if [ "$runner" != no-runner ]; then
    mkdir -p "$R/scripts"
    cp "$REPO/scripts/mutants.py" "$R/scripts/mutants.py" || fail "$name: cannot copy mutants.py"
  fi
  g add -A >/dev/null && g commit -q -m base || fail "$name: base commit failed"
  g remote add origin "$T/$name.git" || fail "$name: remote add failed"
  g push -q -u origin main || fail "$name: push main failed"
  g update-ref refs/remotes/origin/main HEAD
}

# edit_lane <line> — the worker's one-line change to the tracked loop file, left uncommitted.
edit_lane() { printf '%s\n' "$1" >> "$R/rsi/runtime/lane.sh"; }

# manifest <relpath> <json> — write a manifest where `git ls-files -co` will find it.
manifest() { mkdir -p "$R/$(dirname "$1")"; printf '%s\n' "$2" > "$R/$1"; }

# seam — run the hidden check against the current worktree. Sets OUT (stdout) and RC.
seam() {
  OUT="$(RSI_CTRL="$CTRL" HOME="$T/home" bash "$LANE" --mutant-evidence-check "$R" 2>"$T/seam.err")"
  RC=$?
}
seam_output_has() { grep -qF -- "$1" <<<"$OUT"; }

# --- cases -------------------------------------------------------------------------------------

# A diff that touches only prompts and docs is not loop code; a guard must not invent work.
case_skip_when_no_loop_code_changed() {
  new_repo skip
  mkdir -p "$R/rsi/runtime/prompts" "$R/docs" "$R/web/dist/assets"
  printf '# fill prompt\n' > "$R/rsi/runtime/prompts/fill.md"
  printf '# plan\n' > "$R/docs/PLAN.md"
  printf 'bundle\n' > "$R/web/dist/assets/index-abc.js"   # built and ignored: not loop code
  seam
  [ "$RC" -eq 0 ] || fail "skip: expected exit 0, got $RC ($(cat "$T/seam.err"))"
  [ "$OUT" = "MUTANT_EVIDENCE_SKIP: no loop-code change" ] \
    || fail "skip: unexpected output: $OUT"
}

# A changed loop file with no manifest entry is exactly the hole this row closes.
case_changed_loop_file_without_manifest_fails() {
  new_repo missing
  edit_lane 'WORKER=done'
  seam
  [ "$RC" -ne 0 ] || fail "missing: a loop change without a manifest passed (output: $OUT)"
  [ "$OUT" = "MUTANT_EVIDENCE_MISSING: rsi/runtime/lane.sh" ] \
    || fail "missing: unexpected output: $OUT"
}

# An entry for a different file must not cover the changed one.
case_manifest_entry_for_another_file_does_not_count() {
  new_repo otherfile
  edit_lane 'WORKER=done'
  manifest rsi/runtime/tests/other.mutants.json \
    '[{"label":"unrelated","file":"rsi/runtime/other.sh","test":"true","old":"GUARD=other","new":"GUARD=mutated"}]'
  seam
  [ "$RC" -ne 0 ] || fail "otherfile: a manifest for another file covered lane.sh (output: $OUT)"
  seam_output_has 'MUTANT_EVIDENCE_MISSING: rsi/runtime/lane.sh' \
    || fail "otherfile: expected MISSING for lane.sh, got: $OUT"
}

# The proof itself: a mutant that turns the covering test red keeps the hand-off green.
case_manifest_with_red_mutant_passes() {
  new_repo redmutant
  edit_lane 'WORKER=done'
  manifest rsi/runtime/tests/lane.mutants.json \
    '[{"label":"the guard line must stay","file":"rsi/runtime/lane.sh","test":"grep -qx WORKER=done rsi/runtime/lane.sh","old":"WORKER=done","new":"WORKER=broken"}]'
  seam
  [ "$RC" -eq 0 ] || fail "redmutant: exit $RC ($OUT; $(cat "$T/seam.err"))"
  [ "$OUT" = "MUTANT_EVIDENCE_OK: 1 file(s) covered by 1 manifest(s)" ] \
    || fail "redmutant: unexpected output: $OUT"
}

# A test that passes with and without the mutant proves nothing: the seam must be red AND the
# mutated file must come back byte for byte.
case_surviving_mutant_fails_and_restores() {
  new_repo survivor
  edit_lane 'WORKER=done'
  cp "$R/rsi/runtime/lane.sh" "$T/survivor.before"
  manifest rsi/runtime/tests/survive.mutants.json \
    '[{"label":"test passes in both states","file":"rsi/runtime/lane.sh","test":"true","old":"WORKER=done","new":"WORKER=broken"}]'
  seam
  [ "$RC" -ne 0 ] || fail "survivor: a surviving mutant passed (output: $OUT)"
  seam_output_has 'MUTANT_EVIDENCE_RED:' || fail "survivor: no RED verdict: $OUT"
  seam_output_has 'test passes in both states' || fail "survivor: the label is not named: $OUT"
  seam_output_has 'SURVIVED' || fail "survivor: the mutants.py SURVIVED line is not included: $OUT"
  cmp -s "$T/survivor.before" "$R/rsi/runtime/lane.sh" \
    || fail "survivor: the file was not restored byte for byte"
}

# A manifest that cannot be parsed is a guard that cannot run; skipping it is the hole.
case_invalid_manifest_fails_closed() {
  new_repo broken
  edit_lane 'WORKER=done'
  manifest rsi/runtime/tests/broken.mutants.json '{ this is not json'
  seam
  [ "$RC" -ne 0 ] || fail "broken: a malformed manifest passed (output: $OUT)"
  seam_output_has 'MUTANT_EVIDENCE_RED:' || fail "broken: no RED verdict: $OUT"
  seam_output_has 'rsi/runtime/tests/broken.mutants.json' \
    || fail "broken: the malformed manifest is not named: $OUT"
}

# A runner that is absent must be a loud failure, not a skipped proof.
case_missing_runner_fails_closed() {
  new_repo norunner no-runner
  edit_lane 'WORKER=done'
  manifest rsi/runtime/tests/lane.mutants.json \
    '[{"label":"guard","file":"rsi/runtime/lane.sh","test":"true","old":"WORKER=done","new":"WORKER=broken"}]'
  seam
  [ "$RC" -ne 0 ] || fail "norunner: a missing scripts/mutants.py passed (output: $OUT)"
  seam_output_has 'MUTANT_EVIDENCE_RED:' || fail "norunner: no RED verdict: $OUT"
  seam_output_has 'scripts/mutants.py' || fail "norunner: the missing runner is not named: $OUT"
}

# The lever is the contract every worker reads first: it must name the command and the rule.
case_worker_contract_names_the_rule() {
  local out
  out="$(RSI_CTRL="$CTRL" HOME="$T/home" bash "$LANE" --worker-contract-check R-x new "$T/wt" rsi/x 2>"$T/seam.err")" \
    || fail "contract: the seam exited non-zero ($(cat "$T/seam.err"))"
  grep -qF -- '--mutant-evidence-check' <<<"$out" \
    || fail "contract: the worker contract does not name --mutant-evidence-check"
  grep -qF 'MUTANT_EVIDENCE_OK' <<<"$out" \
    || fail "contract: the worker contract does not name the OK verdict"
}

# The lane must run the check itself under a guard that fails the lane, after the format commit and
# before the push. A `|| true` (or a dropped exit) is the regression: the call still runs, the lane
# still pushes, and the reviewer is the first reader again.
case_lane_runs_check_before_push() {
  local call='if ! MUT_EV="$(bash "$SELF" --mutant-evidence-check "$WT" 2>&1)"; then' inv push fin
  [ -f "$LANE" ] || fail "wiring: $LANE missing"
  [ "$(grep -cF "$call" "$LANE")" -eq 1 ] \
    || fail "wiring: the guarded call occurs $(grep -cF "$call" "$LANE") time(s), want 1"
  inv="$(grep -nF "$call" "$LANE" | cut -d: -f1)"
  push="$(grep -n 'push -q -u' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$push" ] || fail "wiring: lane.sh has no 'push -q -u' line"
  [ "$inv" -lt "$push" ] \
    || fail "wiring: the check (line $inv) runs after the push (line $push)"
  fin="$(grep -nF 'finish failed "" "mutant evidence:' "$LANE" | cut -d: -f1)"
  [ -n "$fin" ] || fail "wiring: no failure branch records the mutant-evidence verdict"
  [ "$fin" -gt "$inv" ] && [ "$fin" -lt "$push" ] \
    || fail "wiring: the failure branch (line $fin) is not between the check and the push"
  awk -v a="$inv" -v b="$push" 'NR > a && NR < b && /^[[:space:]]*exit 1[[:space:]]*$/ { found = 1 } END { exit !found }' "$LANE" \
    || fail "wiring: no exit 1 between the check and the push"
}

# scripts/** is half the rule; a Python loop tool must not slip through a runtime-only half.
case_scripts_change_is_in_scope() {
  new_repo scripts
  printf 'WORKER=done\n' >> "$R/scripts/loop_tool.py"
  seam
  [ "$RC" -ne 0 ] || fail "scripts: a scripts/** change without a manifest passed (output: $OUT)"
  seam_output_has 'MUTANT_EVIDENCE_MISSING: scripts/loop_tool.py' \
    || fail "scripts: expected MISSING for scripts/loop_tool.py, got: $OUT"
}

# A branch point that cannot be read would make a committed loop change invisible; fail closed.
case_unresolvable_origin_main_fails_closed() {
  new_repo nobase
  edit_lane 'WORKER=done'
  g add -A >/dev/null && g commit -q -m 'loop guard' || fail "nobase: commit failed"
  g update-ref -d refs/remotes/origin/main || fail "nobase: cannot drop origin/main"
  seam
  [ "$RC" -ne 0 ] || fail "nobase: a missing origin/main was read as no loop change (output: $OUT)"
  seam_output_has 'MUTANT_EVIDENCE_RED:' || fail "nobase: no RED verdict: $OUT"
  seam_output_has 'origin/main' || fail "nobase: origin/main is not named: $OUT"
}

# Worktrees share refs, and merge.sh fetches origin/main continuously, so main moves while a worker
# runs. Only our side of the merge base is our change; another lane's merge must not become this
# lane's required evidence (2026-11-21 review blocker).
case_origin_main_advance_does_not_add_files() {
  new_repo advanced
  g checkout -q -b other
  printf 'GUARD=other2\n' >> "$R/rsi/runtime/other.sh"
  g add -A >/dev/null && g commit -q -m 'other lane merge' || fail "advanced: other commit failed"
  local other_head; other_head="$(g rev-parse HEAD)"
  g checkout -q main
  g update-ref refs/remotes/origin/main "$other_head"
  edit_lane 'WORKER=done'
  seam
  [ "$RC" -ne 0 ] || fail "advanced: expected MISSING for our own change"
  [ "$OUT" = "MUTANT_EVIDENCE_MISSING: rsi/runtime/lane.sh" ] \
    || fail "advanced: another lane's merge was charged to this lane: $OUT"
}

# A removed loop file cannot be mutated; demanding an entry for it would make a cleanup unlandable.
case_deleted_loop_file_needs_no_manifest() {
  new_repo deleted
  g rm -q rsi/runtime/other.sh || fail "deleted: cannot remove other.sh"
  seam
  [ "$RC" -eq 0 ] || fail "deleted: deleting a loop file demanded evidence (output: $OUT)"
  [ "$OUT" = "MUTANT_EVIDENCE_SKIP: no loop-code change" ] \
    || fail "deleted: unexpected output: $OUT"
}

# A standalone suite nothing runs is not a wiring (Watch 77).
case_check_sh_wires_the_suite() {
  local body
  body="$(awk '/^job_shell_test\(\)[[:space:]]*\{/ { on = 1 } on { print } on && /^\}/ { exit }' \
            "$REPO/scripts/check.sh" | sed -E 's/(^|[[:space:]])#.*$//')"
  [ -n "$body" ] || fail "wiring: scripts/check.sh has no job_shell_test()"
  grep -qF 'rsi/runtime/tests/test-lane-mutants.sh' <<<"$body" \
    || fail "wiring: job_shell_test() does not name test-lane-mutants.sh"
}

RAN=0
run() { # a case is named either test_x_... or its short form, x-...
  local short="${1#test_}"; short="${short//_/-}"
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || [ "$ONLY" = "$short" ] || return 0
  RAN=$((RAN + 1))
  "$1" || exit 1
  pass "$1"
}

run case_skip_when_no_loop_code_changed
run case_changed_loop_file_without_manifest_fails
run case_manifest_entry_for_another_file_does_not_count
run case_manifest_with_red_mutant_passes
run case_surviving_mutant_fails_and_restores
run case_invalid_manifest_fails_closed
run case_missing_runner_fails_closed
run case_worker_contract_names_the_rule
run case_lane_runs_check_before_push
run case_check_sh_wires_the_suite
run case_scripts_change_is_in_scope
run case_unresolvable_origin_main_fails_closed
run case_origin_main_advance_does_not_add_files
run case_deleted_loop_file_needs_no_manifest
[ -z "$ONLY" ] || [ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
