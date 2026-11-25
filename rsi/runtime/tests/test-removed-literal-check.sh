#!/bin/bash
# test-removed-literal-check.sh — a removed literal must not leave an untouched test asserting it.
#
# Measured basis: the loop's 7-day rework ledger puts `gate+review·rsi` at 34% of rounds, and a
# large share of those notes name a stale literal or a stale mutant anchor. Today a branch deletes
# a flag, a command fragment or a config value from loop code and leaves an untouched test file (or
# an untouched *.mutants.json anchor) still asserting it; nothing notices until a full gate and an
# independent review. `lane.sh --removed-literal-check <worktree>` derives the literals the branch
# removed, finds the untouched tests and manifests that still assert them, runs only those tests
# (bounded), and stops the push with one `REMOVED_LITERAL_RED:` line naming the literal, the file it
# was removed from and the path:line that still asserts it.
#
# The negative half matters as much as the red half: a static hit is a candidate, not a verdict
# (case 2), a file the branch touched is not a finding (case 3), a move is not a removal (case 4)
# and a sub-8-character value is noise (case 5). A branch that changed no loop code, or a fixture
# with no origin/main, is NA — never a green.
#
# Hermetic: throwaway git trees under mktemp -d, origin/main created with update-ref, RSI_CTRL
# redirected into the temp dir (common.sh derives STATE/RSI_DIR from it), a stubbed lane-pr.sh and
# a copy of the real checker at the deployed path. Booby-trapped npm/npx/node/go/curl in the temp
# HOME prove the seam never reaches for a build tool. No network. Prints "PASS <case>" per case and
# exits non-zero on the first failure. Set RSI_TEST_ONLY=<case name> to run one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$RUNTIME/../.." && pwd)"
LANE="$RUNTIME/lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
CTRL="$T/ctrl"; mkdir -p "$CTRL/rsi/state/lanes" "$CTRL/rsi/runtime"
# lane.sh sources $RSI_DIR/runtime/lane-pr.sh before any seam; the removed-literal seam reads its
# checker from the same deployed path, so a copy keeps the suite hermetic and proves the real rule.
printf '#!/bin/bash\n# stub: the seams never create a PR\n' > "$CTRL/rsi/runtime/lane-pr.sh"
cp "$REPO/rsi/runtime/removed_literal.py" "$CTRL/rsi/runtime/removed_literal.py" 2>/dev/null \
  || { echo "FAIL cannot copy removed_literal.py (write it before running this suite)" >&2; exit 1; }
mkdir -p "$T/home/.local/bin"
for _x in npm npx node go curl; do
  printf '#!/bin/bash\necho "BOOBY: %s must not run" >&2\nexit 99\n' "$_x" > "$T/home/.local/bin/$_x"
  chmod +x "$T/home/.local/bin/$_x"
done
unset _x

R=""       # the worktree the current case works on
OUT=""     # the seam's stdout
RC=0       # the seam's exit code
ONLY="${RSI_TEST_ONLY:-}"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# new_repo <name> [originless] — a throwaway repo on main. With no second arg, origin/main is
# pinned to the base commit so the branch's own commits are the PR diff.
new_repo() {
  local name="$1" originless="${2:-}"
  R="$T/$name"; rm -rf "$R"
  git init -q -b main "$R" || fail "$name: init failed"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  mkdir -p "$R/rsi/runtime/tests" "$R/scripts" "$R/ui/src"
  printf 'base\n' > "$R/README.md"
  printf 'export const x = 1;\n' > "$R/ui/src/x.ts"
  [ -n "$originless" ] || ORIGINLESS_ARMED=1
  ORIGINLESS="$originless"
}

# base_commit — commit the fixture's origin/main state, then pin origin/main there.
base_commit() {
  g add -A >/dev/null && g commit -q -m base || fail "base commit failed"
  [ -n "$ORIGINLESS" ] || g update-ref refs/remotes/origin/main HEAD
}

# commit_branch <msg> — commit the branch's own change on top of origin/main.
commit_branch() {
  g add -A >/dev/null && g commit -q -m "${1:-branch}" || fail "branch commit failed"
}

# seam — run the hidden check against the current worktree. Sets OUT and RC.
seam() {
  OUT="$(RSI_CTRL="$CTRL" HOME="$T/home" bash "$LANE" --removed-literal-check "$R" 2>"$T/seam.err")"
  RC=$?
}
seam_has() { grep -qF -- "$1" <<<"$OUT"; }

# A loop file on main with a long quoted literal the branch will delete.
seed_loop_literal() { # <literal>
  printf '#!/bin/bash\nFLAG="%s"\necho "$FLAG"\n' "$1" > "$R/rsi/runtime/loop.sh"
}

# An untouched test that still asserts the literal and fails when run. The literal lives in the
# grep's own pattern, which is exactly how a real test pins a removed value.
seed_failing_test() { # <literal>
  cat > "$R/rsi/runtime/tests/test-flag.sh" <<EOF
#!/bin/bash
here="\$(cd "\$(dirname "\$0")" && pwd)"
grep -qF 'FLAG="$1"' "\$here/../loop.sh" || { echo "FAIL: FLAG literal gone from loop.sh"; exit 1; }
EOF
  chmod +x "$R/rsi/runtime/tests/test-flag.sh"
}

# --- cases -------------------------------------------------------------------------------------

# 1. The hole: a removed literal still asserted by an untouched test stops the hand-off.
test_removed_literal_in_untouched_test_is_red() {
  local lit='removed-literal-demo-value'
  new_repo red
  seed_loop_literal "$lit"; seed_failing_test "$lit"; base_commit
  # The branch deletes the literal from loop code and leaves the test untouched.
  printf '#!/bin/bash\necho "$FLAG"\n' > "$R/rsi/runtime/loop.sh"
  commit_branch drop-literal
  seam
  [ "$RC" -eq 1 ] || fail "red: expected exit 1, got $RC: $OUT"
  case "$(head -1 <<<"$OUT")" in REMOVED_LITERAL_RED:*) ;; *) fail "red: first line is not RED: $OUT" ;; esac
  seam_has "$lit" || fail "red: verdict does not name the literal: $OUT"
  seam_has 'rsi/runtime/loop.sh' || fail "red: verdict does not name the removed-from file: $OUT"
  seam_has 'rsi/runtime/tests/test-flag.sh:' || fail "red: verdict does not name the asserting path:line: $OUT"
  pass test_removed_literal_in_untouched_test_is_red
}

# 2. A static hit is a candidate, not a verdict: the untouched test asserts the literal's absence
#    and passes, so the seam is green.
test_passing_untouched_test_is_ok() {
  local lit='removed-literal-demo-value'
  new_repo passing
  seed_loop_literal "$lit"; base_commit
  cat > "$R/rsi/runtime/tests/test-flag.sh" <<'EOF'
#!/bin/bash
here="$(cd "$(dirname "$0")" && pwd)"
if grep -qF 'removed-literal-demo-value' "$here/../loop.sh"; then echo "FAIL: literal still there"; exit 1; fi
echo "PASS: literal is gone"
EOF
  chmod +x "$R/rsi/runtime/tests/test-flag.sh"
  printf '#!/bin/bash\necho "$FLAG"\n' > "$R/rsi/runtime/loop.sh"
  commit_branch drop-literal
  seam
  [ "$RC" -eq 0 ] || fail "passing: expected exit 0, got $RC: $OUT"
  seam_has 'REMOVED_LITERAL_OK' || fail "passing: expected OK, got: $OUT"
  pass test_passing_untouched_test_is_ok
}

# 3. A file the branch touched is not a finding: the worker had it in hand (and this fixture leaves
#    the literal in a comment so only the touched-file rule can keep it quiet).
test_modified_test_is_not_a_finding() {
  local lit='removed-literal-demo-value'
  new_repo modified
  seed_loop_literal "$lit"; seed_failing_test "$lit"; base_commit
  printf '#!/bin/bash\necho "$FLAG"\n' > "$R/rsi/runtime/loop.sh"
  cat > "$R/rsi/runtime/tests/test-flag.sh" <<'EOF'
#!/bin/bash
# the removed-literal-demo-value assertion moved to the new behaviour test
exit 1
EOF
  chmod +x "$R/rsi/runtime/tests/test-flag.sh"
  commit_branch drop-literal-and-update-test
  seam
  [ "$RC" -eq 0 ] || fail "modified: expected exit 0, got $RC: $OUT"
  seam_has 'REMOVED_LITERAL_OK' || fail "modified: expected OK, got: $OUT"
  pass test_modified_test_is_not_a_finding
}

# 4. A move is not a removal: the literal still exists in current loop production code.
test_literal_still_used_in_loop_code_is_ok() {
  local lit='removed-literal-demo-value'
  new_repo moved
  seed_loop_literal "$lit"; seed_failing_test "$lit"; base_commit
  printf '#!/bin/bash\necho "$FLAG"\n' > "$R/rsi/runtime/loop.sh"
  printf '#!/bin/bash\nFLAG="%s"\n' "$lit" > "$R/rsi/runtime/loop2.sh"
  commit_branch move-literal
  seam
  [ "$RC" -eq 0 ] || fail "moved: expected exit 0, got $RC: $OUT"
  seam_has 'REMOVED_LITERAL_OK' || fail "moved: expected OK, got: $OUT"
  pass test_literal_still_used_in_loop_code_is_ok
}

# 5. The noise floor: a sub-8-character removed value is not a needle, even when a failing test
#    quotes it.
test_short_literal_is_ignored() {
  local lit='tiny'
  new_repo short
  seed_loop_literal "$lit"; seed_failing_test "$lit"; base_commit
  printf '#!/bin/bash\necho "$FLAG"\n' > "$R/rsi/runtime/loop.sh"
  commit_branch drop-short
  seam
  [ "$RC" -eq 0 ] || fail "short: expected exit 0, got $RC: $OUT"
  seam_has 'REMOVED_LITERAL_OK' || fail "short: expected OK, got: $OUT"
  pass test_short_literal_is_ignored
}

# 6. A stale mutant anchor is mechanically fatal (`pattern occurs 0 times`), so it is RED without
#    running the entry's test.
test_stale_mutant_anchor_is_red() {
  local line='if [ "$x" = "--stale-anchor-demo" ]; then'
  new_repo stale
  printf '#!/bin/bash\n%s\n  echo guarded\nfi\n' "$line" > "$R/rsi/runtime/loop.sh"
  mkdir -p "$R/rsi/runtime/tests"
  python3 - "$line" > "$R/rsi/runtime/tests/demo.mutants.json" <<'PY'
import json, sys
line = sys.argv[1]
json.dump([{
    "label": "the guard is skipped",
    "file": "rsi/runtime/loop.sh",
    "test": "bash rsi/runtime/tests/sentinel.sh",
    "old": line,
    "new": "if false; then",
}], sys.stdout)
PY
  cat > "$R/rsi/runtime/tests/sentinel.sh" <<'EOF'
#!/bin/bash
touch "$(dirname "$0")/sentinel-ran"
EOF
  chmod +x "$R/rsi/runtime/tests/sentinel.sh"
  base_commit
  printf '#!/bin/bash\necho guarded\n' > "$R/rsi/runtime/loop.sh"
  commit_branch drop-guard-line
  seam
  [ "$RC" -eq 1 ] || fail "stale: expected exit 1, got $RC: $OUT"
  case "$(head -1 <<<"$OUT")" in REMOVED_LITERAL_RED:*) ;; *) fail "stale: first line is not RED: $OUT" ;; esac
  seam_has 'rsi/runtime/tests/demo.mutants.json' || fail "stale: verdict does not name the manifest: $OUT"
  seam_has 'the guard is skipped' || fail "stale: verdict does not name the entry label: $OUT"
  [ ! -e "$R/rsi/runtime/tests/sentinel-ran" ] \
    || fail "stale: the manifest entry's test was run; a stale anchor must be decided statically"
  pass test_stale_mutant_anchor_is_red
}

# 7. A branch that changed no loop code is NA, never a green.
test_no_loop_change_is_na() {
  new_repo noloop
  base_commit
  printf 'export const x = 2;\n' > "$R/ui/src/x.ts"
  commit_branch ui-only
  seam
  [ "$RC" -eq 0 ] || fail "noloop: expected exit 0, got $RC: $OUT"
  seam_has 'REMOVED_LITERAL_NA:' || fail "noloop: expected NA, got: $OUT"
  seam_has 'no loop-code change' || fail "noloop: NA does not name the reason: $OUT"
  pass test_no_loop_change_is_na
}

# 8. A fixture with no origin/main cannot be measured: NA naming the reason, not a green.
test_unresolvable_origin_main_is_na() {
  new_repo noorigin originless
  seed_loop_literal 'removed-literal-demo-value'
  printf '#!/bin/bash\necho "$FLAG"\n' > "$R/rsi/runtime/loop.sh"
  g add -A >/dev/null && g commit -q -m base-no-origin || fail "noorigin: commit failed"
  seam
  [ "$RC" -eq 0 ] || fail "noorigin: expected exit 0, got $RC: $OUT"
  seam_has 'REMOVED_LITERAL_NA:' || fail "noorigin: expected NA, got: $OUT"
  seam_has 'origin/main' || fail "noorigin: NA does not name the unresolvable ref: $OUT"
  pass test_unresolvable_origin_main_is_na
}

# 9. The lane pipeline actually calls the seam: dispatcher, usage, pre-push position and evidence.
test_lane_pipeline_calls_the_seam() {
  local lane="$LANE" fmt rem push
  grep -qF 'if [ "$CMD" = --removed-literal-check ]; then' "$lane" \
    || fail "pipeline: no --removed-literal-check dispatcher"
  grep -qF 'usage: lane.sh --removed-literal-check <worktree>' "$lane" \
    || fail "pipeline: dispatcher has no usage line"
  grep -qF 'REMOVED_EV="$(bash "$SELF" --removed-literal-check "$WT" 2>&1)"' "$lane" \
    || fail "pipeline: lane does not run the seam before pushing"
  grep -qF 'lanes/$N.removed-literal.txt' "$lane" \
    || fail "pipeline: a RED writes no lanes/<n>.removed-literal.txt evidence"
  grep -qF 'finish failed "" "removed literal:' "$lane" \
    || fail "pipeline: a RED does not call finish failed"
  fmt="$(grep -nF 'format-changed.sh" --write --commit --check' "$lane" | head -1 | cut -d: -f1)"
  rem="$(grep -nF 'REMOVED_EV="$(bash "$SELF" --removed-literal-check' "$lane" | head -1 | cut -d: -f1)"
  push="$(grep -nF 'push -q -u origin' "$lane" | head -1 | cut -d: -f1)"
  # main moved the push into the git_push_retry helper; the seam must still precede it.
  [ -n "$push" ] || push="$(grep -nF 'git_push_retry "$GIT" "$WT" "$BR"' "$lane" | head -1 | cut -d: -f1)"
  [ -n "$fmt" ] && [ -n "$rem" ] && [ -n "$push" ] || fail "pipeline: cannot locate format/removed/push lines"
  [ "$fmt" -lt "$rem" ] || fail "pipeline: removed-literal call is not after the format commit"
  [ "$rem" -lt "$push" ] || fail "pipeline: removed-literal call is not before the push block"
  pass test_lane_pipeline_calls_the_seam
}

# 10. The dispatcher rejects a missing worktree with usage and exit 2.
test_dispatcher_usage() {
  local out rc
  out="$(RSI_CTRL="$CTRL" HOME="$T/home" bash "$LANE" --removed-literal-check 2>&1)"; rc=$?
  [ "$rc" -eq 2 ] || fail "usage: expected exit 2, got $rc: $out"
  grep -qF 'usage:' <<<"$out" || fail "usage: no usage line: $out"
  grep -qF -- '--removed-literal-check' <<<"$out" || fail "usage: usage does not name the seam: $out"
  pass test_dispatcher_usage
}

# 11. An anchor is stale only when its `old` is really gone from the target: a branch that deletes
#    a common line (here a bare `return 0`) elsewhere in the same file is not a reason to flag an
#    untouched manifest entry whose `old` block still exists in the target.
test_anchor_old_text_still_in_target_is_not_stale() {
  new_repo anchor-kept
  cat > "$R/rsi/runtime/loop.sh" <<'EOF'
#!/bin/bash
guard() {
  return 0
}
other() {
  return 0
}
EOF
  cat > "$R/rsi/runtime/tests/demo.mutants.json" <<'EOF'
[
  {
    "label": "the guard is skipped",
    "file": "rsi/runtime/loop.sh",
    "test": "bash rsi/runtime/tests/sentinel.sh",
    "old": "guard() {\n  return 0\n}",
    "new": "guard() {\n  return 1\n}"
  }
]
EOF
  cat > "$R/rsi/runtime/tests/sentinel.sh" <<'EOF'
#!/bin/bash
touch "$(dirname "$0")/sentinel-ran"
EOF
  chmod +x "$R/rsi/runtime/tests/sentinel.sh"
  base_commit
  # The branch deletes the second copy of the common line; the anchor's block is untouched.
  cat > "$R/rsi/runtime/loop.sh" <<'EOF'
#!/bin/bash
guard() {
  return 0
}
other() {
}
EOF
  commit_branch drop-common-line
  seam
  [ "$RC" -eq 0 ] || fail "anchor-kept: expected exit 0, got $RC: $OUT"
  seam_has 'REMOVED_LITERAL_OK' || fail "anchor-kept: expected OK, got: $OUT"
  pass test_anchor_old_text_still_in_target_is_not_stale
}

# --- runner ------------------------------------------------------------------------------------
ALL_CASES="test_removed_literal_in_untouched_test_is_red
test_passing_untouched_test_is_ok
test_modified_test_is_not_a_finding
test_literal_still_used_in_loop_code_is_ok
test_short_literal_is_ignored
test_stale_mutant_anchor_is_red
test_no_loop_change_is_na
test_unresolvable_origin_main_is_na
test_lane_pipeline_calls_the_seam
test_dispatcher_usage
test_anchor_old_text_still_in_target_is_not_stale"

if [ -n "$ONLY" ]; then
  grep -qxF "$ONLY" <<<"$ALL_CASES" || fail "unknown RSI_TEST_ONLY case: $ONLY"
  "$ONLY"
  exit 0
fi
while IFS= read -r _case; do
  [ -n "$_case" ] || continue
  "$_case"
done <<<"$ALL_CASES"
