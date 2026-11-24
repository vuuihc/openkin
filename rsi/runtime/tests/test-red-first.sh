#!/bin/bash
# test-red-first.sh — a claimed test must be the test that goes red without the change.
#
# The 1d ledger ending 11-23 03:59 read 46 rounds / 44 merges = 1.05, and its top shape
# (`test-green·not-red`, x12, 26% of all rounds) was one finding: the Claims line named a test
# that was green on origin/main, or named the one test that stayed green. `activity-pill` shipped
# four new tests that all passed on origin/main; `local-main-only` named the test that stayed
# green while a different one went red. rsi/runtime/red_first.py turns the Claims block from a
# writing rule into a lane gate: it reverts each claimed file to origin/main and requires the
# command to exit non-zero with the claimed test's name in its output.
#
# Hermetic: a throwaway bare origin + branch repo per case, stubbed checks, no network, no model.
# `RSI_TEST_ONLY=<case>` selects one case (both the acceptance name and the function name work).
# Prints "PASS <case>" per case and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
LANE="$HERE/../lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
CTRL="$T/ctrl"; mkdir -p "$CTRL/rsi/state/lanes" "$CTRL/rsi/runtime"
# lane.sh sources $RSI_DIR/runtime/lane-pr.sh before any seam; the seam reads red_first.py from
# the same deployed path, so a copy proves the real checker runs and keeps the suite hermetic.
printf '#!/bin/bash\n# stub: the seams never create a PR\n' > "$CTRL/rsi/runtime/lane-pr.sh"
cp "$REPO/rsi/runtime/red_first.py" "$CTRL/rsi/runtime/red_first.py" \
  || { echo "FAIL cannot copy red_first.py" >&2; exit 1; }
R=""; BODY=""
ONLY="${RSI_TEST_ONLY:-}"
OUT=""; ERR=""; RC=0

pass() { echo "PASS $*"; }
CASE=""
# Prefix every failure with the case name: the red-first seam proves a claim by finding the
# claimed test's name in the red output, so this suite's own claims depend on that name.
fail() { echo "FAIL ${CASE:-bootstrap}: $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# sha <path> — sha256 of a file, so a restore claim is bytes, not "looks right".
sha() {
  python3 - "$1" <<'PY'
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
}

# new_repo <name> — a bare origin and a branch worktree. origin/main has target.mjs 'broken';
# check.sh passes only while target.mjs says 'fixed'. The branch commits the fix, so reverting
# the claimed file turns the branch's check red exactly as the real seam would.
new_repo() {
  local name="$1"
  R="$T/$name"; rm -rf "$R" "$T/$name.git"
  git init -q --bare "$T/$name.git" || fail "$name: bare init failed"
  git init -q -b main "$R" || fail "$name: git init failed"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  printf "export const value = 'broken'\n" > "$R/target.mjs"
  printf "export const other = 1\n" > "$R/unrelated.mjs"
  cat > "$R/check.sh" <<'SH'
#!/bin/bash
v="$(cat target.mjs)"
case "$v" in
  *fixed*) echo "PASS case_alpha"; exit 0 ;;
esac
echo "FAIL case_alpha: target.mjs is not fixed"
exit 1
SH
  printf '#!/bin/bash\necho "PASS case_alpha"\nexit 0\n' > "$R/always-pass.sh"
  g add -A >/dev/null && g commit -q -m base || fail "$name: base commit failed"
  g remote add origin "$T/$name.git" || fail "$name: remote add failed"
  g push -q -u origin main || fail "$name: push main failed"
  g update-ref refs/remotes/origin/main HEAD
}

# new_repo_no_origin <name> — a repo whose branch point does not resolve: fail closed, not NA.
new_repo_no_origin() {
  local name="$1"
  R="$T/$name"; rm -rf "$R"
  git init -q -b main "$R" || fail "$name: git init failed"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  printf "export const value = 'fixed'\n" > "$R/target.mjs"
  printf '#!/bin/bash\necho "FAIL case_alpha: boom"; exit 1\n' > "$R/check.sh"
  g add -A >/dev/null && g commit -q -m base || fail "$name: base commit failed"
}

# rewrite <path> <line> — one committed change on the branch, the PR's own diff.
rewrite() {
  printf '%s\n' "$2" > "$R/$1" && g add -A >/dev/null && g commit -q -m "change $1" \
    || fail "cannot commit a change to $1"
}
fix_target() { rewrite target.mjs "export const value = 'fixed'"; }

# body <line>... — the PR body the seam reads.
body() { BODY="$T/body.md"; printf '%s\n' "$@" > "$BODY"; }

# seam [secs] — run the lane's red-first seam on the current worktree. Sets OUT/ERR/RC.
seam() {
  local secs="${1:-180}"
  OUT="$(RSI_CTRL="$CTRL" HOME="$T/home" RSI_RED_FIRST_SECS="$secs" \
    bash "$LANE" --red-first-check "$R" "$BODY" 2>"$T/seam.err")"; RC=$?
  ERR="$(cat "$T/seam.err")"
}
checker() { # the checker alone, without the lane seam's own origin/main guard
  OUT="$(RSI_RED_FIRST_SECS="${1:-180}" python3 "$CTRL/rsi/runtime/red_first.py" "$R" "$BODY" 2>"$T/seam.err")"
  RC=$?; ERR="$(cat "$T/seam.err")"
}
has() { grep -qF -- "$1" <<<"$OUT"; }

# claims_body <path:line> <test> <check> — the contract's one-line-per-claim shape.
claims_body() {
  body "# Symptom" "" "## Claims" "" "- \`$1\` · \`$2\` · $3" "" "## Screenshots" "none: not visible"
}

# --- cases -------------------------------------------------------------------------------------

# The activity-pill shape: all four new tests were green on origin/main, so the claim proved
# nothing. The command exits 0 with the claimed file reverted; that is a lane failure.
case_red_first_green_when_the_test_passes_on_the_reverted_file() {
  new_repo green
  fix_target
  printf '#!/bin/bash\necho "PASS case_alpha"\nexit 0\n' > "$R/check.sh"
  g add -A >/dev/null && g commit -q -m "a test that is green on origin/main"
  claims_body "target.mjs:1" "case_alpha" "\`bash check.sh\`"
  seam
  [ "$RC" -eq 1 ] || fail "green: exit $RC, want 1 ($OUT; $ERR)"
  has 'RED_FIRST_GREEN: target.mjs:1 · case_alpha' || fail "green: no GREEN verdict naming the claim: $OUT"
  ! has 'RED_FIRST_OK' || fail "green: a green run was accepted as proof: $OUT"
}

# The fix works: the branch's check names case_alpha and goes red once the file is reverted.
case_red_first_ok_when_the_named_test_goes_red() {
  new_repo ok
  fix_target
  claims_body "target.mjs:1" "case_alpha" "\`bash check.sh\`"
  seam
  [ "$RC" -eq 0 ] || fail "ok: exit $RC, want 0 ($OUT; $ERR)"
  has 'RED_FIRST_OK: 1 claim(s) checked; every command went red' || fail "ok: no OK verdict: $OUT"
  has 'RED_FIRST_TIME:' || fail "ok: the command's wall time was not printed: $OUT"
}

# The local-main-only shape: red output names a different case, so the claimed test is not proven.
case_red_first_other_when_a_different_test_goes_red() {
  new_repo other
  fix_target
  printf '#!/bin/bash\necho "FAIL case_beta: boom"\nexit 1\n' > "$R/check.sh"
  g add -A >/dev/null && g commit -q -m "a different test is the red one"
  claims_body "target.mjs:1" "case_alpha" "\`bash check.sh\`"
  seam
  [ "$RC" -eq 1 ] || fail "other: exit $RC, want 1 ($OUT; $ERR)"
  has 'RED_FIRST_OTHER: target.mjs:1 · case_alpha · red without it did not name that test' \
    || fail "other: no OTHER verdict naming the claim: $OUT"
}

# A command that cannot name its own test (a crash, a fixture-only run) still proves the claim
# when the worker says so explicitly.
case_red_first_any_accepts_a_red_without_a_test_name() {
  new_repo any
  fix_target
  printf '#!/bin/bash\necho boom\nexit 3\n' > "$R/check.sh"
  g add -A >/dev/null && g commit -q -m "a crash, not a named case"
  body "# Symptom" "" "## Claims" "" \
    "- \`target.mjs:1\` · a red without a test name · \`bash check.sh\` red-first: any"
  seam
  [ "$RC" -eq 0 ] || fail "any: exit $RC, want 0 ($OUT; $ERR)"
  has 'RED_FIRST_OK:' || fail "any: no OK verdict: $OUT"
}

# A code-only body has nothing to prove; NA is honest and cheap.
case_red_first_na_without_a_claims_block() {
  new_repo noclaims
  fix_target
  body "# Symptom" "" "## Change" "" "No behaviour claim here." "" "## Screenshots" "none: not visible"
  seam
  [ "$RC" -eq 0 ] || fail "noclaims: exit $RC, want 0 ($OUT; $ERR)"
  has 'RED_FIRST_NA: the PR body has no Claims block' || fail "noclaims: no NA verdict: $OUT"
}

# A claim on a file the branch did not change is never a false GREEN: there is nothing to revert.
case_red_first_na_for_a_claim_the_branch_did_not_change() {
  new_repo unchanged
  fix_target
  claims_body "unrelated.mjs:1" "case_alpha" "\`bash always-pass.sh\`"
  seam
  [ "$RC" -eq 0 ] || fail "unchanged: exit $RC, want 0 ($OUT; $ERR)"
  has 'RED_FIRST_NA: no claim cites a file this branch changed' || fail "unchanged: no NA verdict: $OUT"
  ! has 'RED_FIRST_GREEN' || fail "unchanged: an unchanged file was treated as a revert: $OUT"
}

# No branch point means nothing can be reverted; fail closed rather than wave the PR through.
case_red_first_fail_when_origin_main_does_not_resolve() {
  new_repo_no_origin nomain
  claims_body "target.mjs:1" "case_alpha" "\`bash check.sh\`"
  seam
  [ "$RC" -eq 1 ] || fail "nomain seam: exit $RC, want 1 ($OUT; $ERR)"
  has 'RED_FIRST_FAIL:' || fail "nomain seam: no FAIL verdict: $OUT"
  ! has 'RED_FIRST_NA' || fail "nomain seam: an unresolvable branch point became NA: $OUT"
  checker
  [ "$RC" -eq 1 ] || fail "nomain checker: exit $RC, want 1 ($OUT; $ERR)"
  has 'RED_FIRST_FAIL: origin/main is not resolvable' || fail "nomain checker: no FAIL verdict: $OUT"
}

# A command that hangs must not leave the tree reverted, and its whole process group must die:
# a grandchild that survives can write the "restored" file back to origin/main's bytes. The
# verdict is NO_VERDICT -- never a fabricated red -- and the claimed file comes back byte for byte.
case_red_first_restores_the_file_after_a_timeout() {
  new_repo timeout
  fix_target
  cat > "$R/slow.sh" <<'SH'
#!/bin/bash
sleep 30 & echo $! > child.pid
wait
SH
  g add -A >/dev/null && g commit -q -m "a command with a detached grandchild"
  claims_body "target.mjs:1" "sleep_five" "\`bash slow.sh\`"
  local before; before="$(sha "$R/target.mjs")"
  rm -f "$R/child.pid"
  local start end child alive
  start="$(date +%s)"
  seam 1
  end="$(date +%s)"
  [ "$RC" -eq 1 ] || fail "timeout: exit $RC, want 1 ($OUT; $ERR)"
  has 'RED_FIRST_NO_VERDICT: target.mjs:1 · command exceeded 1s' || fail "timeout: no NO_VERDICT verdict: $OUT"
  [ "$(sha "$R/target.mjs")" = "$before" ] || fail "timeout: target.mjs was left reverted"
  child="$(cat "$R/child.pid" 2>/dev/null || true)"
  alive=0
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then alive=1; kill -9 "$child" 2>/dev/null; fi
  [ "$alive" -eq 0 ] || fail "timeout: the command's grandchild survived the timeout"
  [ $((end - start)) -le 10 ] || fail "timeout: took $((end - start))s; the process group was not killed"
}

# The success path restores every reverted file: sha256 equal and a clean status afterwards.
case_red_first_restores_byte_for_byte_on_success() {
  new_repo restore
  fix_target
  claims_body "target.mjs:1" "case_alpha" "\`bash check.sh\`"
  local before; before="$(sha "$R/target.mjs")"
  seam
  [ "$RC" -eq 0 ] || fail "restore: exit $RC, want 0 ($OUT; $ERR)"
  [ "$(sha "$R/target.mjs")" = "$before" ] || fail "restore: target.mjs bytes changed"
  [ -z "$(g status --porcelain)" ] || fail "restore: the worktree is dirty: $(g status --porcelain)"
}

# The seam must run after the claim check and before the push; a claim proven after the push
# costs the same review round it is meant to save.
case_lane_runs_the_seam_before_the_push() {
  local claim_at red_at push_at ev_at fin_at rc
  claim_at="$(grep -nF -- 'if ! CLAIM_EV="$(bash "$SELF" --claim-check-check' "$LANE" | head -1 | cut -d: -f1)"
  red_at="$(grep -nF -- 'if ! RED_EV="$(bash "$SELF" --red-first-check' "$LANE" | head -1 | cut -d: -f1)"
  push_at="$(grep -nF -- 'git_push_retry "$GIT" "$WT" "$BR"' "$LANE" | head -1 | cut -d: -f1)"
  ev_at="$(grep -nF -- '"$STATE/lanes/$N.red-first.txt"' "$LANE" | head -1 | cut -d: -f1)"
  fin_at="$(grep -nF -- 'finish failed "" "red first:' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$claim_at" ] || fail "wiring: no claim-check call site"
  [ -n "$red_at" ] || fail "wiring: no red-first call site"
  [ -n "$push_at" ] || fail "wiring: no push line"
  [ "$claim_at" -lt "$red_at" ] || fail "wiring: the red-first seam ($red_at) does not follow the claim check ($claim_at)"
  [ "$red_at" -lt "$push_at" ] || fail "wiring: the red-first seam ($red_at) does not precede the push ($push_at)"
  [ -n "$ev_at" ] && [ "$red_at" -lt "$ev_at" ] && [ "$ev_at" -lt "$push_at" ] \
    || fail "wiring: the red-first evidence write is not between the seam and the push"
  [ -n "$fin_at" ] && [ "$red_at" -lt "$fin_at" ] && [ "$fin_at" -lt "$push_at" ] \
    || fail "wiring: the failure branch is not between the seam and the push"
  grep -qF -- 'if [ "$CMD" = --red-first-check ]' "$LANE" || fail "wiring: no --red-first-check dispatch"
  RSI_CTRL="$CTRL" HOME="$T/home" bash "$LANE" --red-first-check >/dev/null 2>&1; rc=$?
  [ "$rc" -eq 2 ] || fail "wiring: wrong argument count exited $rc, want 2"
}

# The suite is only a gate if the gate runs it.
case_check_sh_names_the_red_first_suite() {
  local body_text
  body_text="$(awk '/^job_shell_test\(\)[[:space:]]*\{/ { on = 1 } on { print } on && /^\}/ { exit }' \
    "$REPO/scripts/check.sh" | sed -E 's/(^|[[:space:]])#.*$//')"
  [ -n "$body_text" ] || fail "wiring: check.sh has no job_shell_test()"
  grep -qF -- 'rsi/runtime/tests/test-red-first.sh' <<<"$body_text" \
    || fail "wiring: job_shell_test() does not run test-red-first.sh"
}

# A `mutant "<label>"` third field resolves through this branch's *.mutants.json to that entry's
# own test command -- the shape most real Claims lines use.
case_red_first_ok_when_a_mutant_label_resolves() {
  new_repo mutant
  fix_target
  cat > "$R/red.mutants.json" <<'JSON'
[{"label": "the fix is reverted", "file": "target.mjs", "test": "bash check.sh"}]
JSON
  g add -A >/dev/null && g commit -q -m "a mutant manifest"
  claims_body "target.mjs:1" "case_alpha" 'mutant "the fix is reverted"'
  seam
  [ "$RC" -eq 0 ] || fail "mutant: exit $RC, want 0 ($OUT; $ERR)"
  has 'RED_FIRST_OK: 1 claim(s) checked; every command went red' || fail "mutant: no OK verdict: $OUT"
}

# A reasoned waiver is respected; a bare one is not a free pass.
case_red_first_waived_by_a_reasoned_red_first_none() {
  new_repo waived
  fix_target
  body "# Symptom" "" "## Claims" "" \
    "- \`target.mjs:1\` · \`case_alpha\` · none: the fixture needs a real browser. red-first: none: a real browser leg needs the daemon's fake-agent verdict and this fixture has none" ""
  seam
  [ "$RC" -eq 0 ] || fail "waived: exit $RC, want 0 ($OUT; $ERR)"
  has 'RED_FIRST_WAIVED:' || fail "waived: no WAIVED verdict: $OUT"
}

# A file the branch adds has no origin/main version to revert to; that is unprovable (NA),
# never a FAIL that sends an honest new-feature PR back.
case_red_first_na_for_a_file_the_branch_added() {
  new_repo added
  fix_target
  printf "export const extra = 1\n" > "$R/added.mjs"
  g add -A >/dev/null && g commit -q -m "add a file"
  claims_body "added.mjs:1" "case_alpha" "\`bash check.sh\`"
  seam
  [ "$RC" -eq 0 ] || fail "added: exit $RC, want 0 ($OUT; $ERR)"
  has 'RED_FIRST_NA: no claim names a resolvable check (added.mjs:1 · the branch adds this file)' \
    || fail "added: no NA verdict for the added file: $OUT"
}

# A run costs one command per claim group; beyond four the checker says NA with the count
# instead of paying an unbounded number of suite runs inside the lane.
case_red_first_na_with_more_than_four_commands() {
  new_repo many
  fix_target
  body "# Symptom" "" "## Claims" ""
  local i
  for i in 1 2 3 4 5; do
    printf -- '- `target.mjs:1` · `case_alpha` · `true %s`\n' "$i" >> "$BODY"
  done
  seam
  [ "$RC" -eq 0 ] || fail "many: exit $RC, want 0 ($OUT; $ERR)"
  has 'RED_FIRST_NA: 5 unique commands (at most 4 per run)' || fail "many: no NA verdict with the count: $OUT"
}

# A fixture file name in field 2 is not a test name: the red never prints a filename, so the
# claim is NA rather than an OTHER that would fail an honest fixture-based claim.
case_red_first_na_when_field_two_names_only_a_fixture_file() {
  new_repo fixture
  fix_target
  body "# Symptom" "" "## Claims" "" \
    "- \`target.mjs:1\` · \`optional-grace.fixture.mjs\` green run above · \`bash check.sh\`" "" \
    "## Screenshots" "none: not visible"
  seam
  [ "$RC" -eq 0 ] || fail "fixture: exit $RC, want 0 ($OUT; $ERR)"
  has 'RED_FIRST_NA: no claim names a resolvable check (target.mjs:1 · field 2 names no test)' \
    || fail "fixture: a filename was treated as a test name: $OUT"
}

# A waiver without a reason is not a free pass; it fails closed with a fixable message.
case_red_first_fail_on_a_waiver_without_a_reason() {
  new_repo badwaiver
  fix_target
  body "# Symptom" "" "## Claims" "" \
    "- \`target.mjs:1\` · \`case_alpha\` · red-first: none: too short" ""
  seam
  [ "$RC" -eq 1 ] || fail "badwaiver: exit $RC, want 1 ($OUT; $ERR)"
  has 'RED_FIRST_FAIL: target.mjs:1 · a red-first waiver needs a reason of at least 20 characters' \
    || fail "badwaiver: no FAIL naming the short waiver: $OUT"
}

# The local-main-only hole: `go test -v` prints `=== RUN case_alpha` for a test that then
# passes, alongside another test's `--- FAIL`, and exits non-zero. The claimed test did not go
# red, so the claim is not proven.
case_red_first_other_when_the_name_appears_only_on_a_passing_line() {
  new_repo passline
  fix_target
  cat > "$R/check.sh" <<'SH'
#!/bin/bash
echo "=== RUN   case_alpha"
echo "--- PASS: case_alpha (0.00s)"
echo "--- FAIL: case_beta (0.00s)"
exit 1
SH
  g add -A >/dev/null && g commit -q -m "a verbose runner names both tests"
  claims_body "target.mjs:1" "case_alpha" "\`bash check.sh\`"
  seam
  [ "$RC" -eq 1 ] || fail "passline: exit $RC, want 1 ($OUT; $ERR)"
  has 'RED_FIRST_OTHER: target.mjs:1 · case_alpha' || fail "passline: a run/pass mention was accepted as red: $OUT"
}

# An exit 0 that never ran the named test is still GREEN, but the message must not say the test
# passed on origin/main: reverting a test file deletes its cases and the runner matches nothing.
case_red_first_green_reports_a_green_run_that_never_named_the_test() {
  new_repo greenunnamed
  fix_target
  printf '#!/bin/bash\necho "no matching test"\nexit 0\n' > "$R/check.sh"
  g add -A >/dev/null && g commit -q -m "a runner that matches nothing"
  claims_body "target.mjs:1" "case_alpha" "\`bash check.sh\`"
  seam
  [ "$RC" -eq 1 ] || fail "greenunnamed: exit $RC, want 1 ($OUT; $ERR)"
  has 'RED_FIRST_GREEN: target.mjs:1 · case_alpha · the command exited 0 without naming it' \
    || fail "greenunnamed: a green run that never named the test reads as a pass: $OUT"
}

# A reaped lane (SIGTERM) must kill the command's process group before restoring, and must state
# that the restore was verified -- not claim it.
case_red_first_kills_the_command_and_restores_on_sigterm() {
  new_repo sigterm
  fix_target
  cat > "$R/slow.sh" <<'SH'
#!/bin/bash
sleep 30 & echo $! > child.pid
wait
SH
  g add -A >/dev/null && g commit -q -m "a long command"
  claims_body "target.mjs:1" "sleep_five" "\`bash slow.sh\`"
  local before; before="$(sha "$R/target.mjs")"
  rm -f "$R/child.pid"
  RSI_RED_FIRST_SECS=60 python3 "$CTRL/rsi/runtime/red_first.py" "$R" "$BODY" \
    > "$T/sigterm.out" 2> "$T/sigterm.err" &
  local pid=$! i child
  for i in $(seq 1 100); do [ -s "$R/child.pid" ] && break; sleep 0.1; done
  [ -s "$R/child.pid" ] || { kill -9 "$pid" 2>/dev/null; fail "sigterm: the command never started"; }
  child="$(cat "$R/child.pid")"
  kill -TERM "$pid"
  wait "$pid"; RC=$?
  OUT="$(cat "$T/sigterm.out")"; ERR="$(cat "$T/sigterm.err")"
  [ "$RC" -eq 1 ] || fail "sigterm: exit $RC, want 1 ($OUT; $ERR)"
  has 'RED_FIRST_FAIL: terminated by signal 15' || fail "sigterm: no signal verdict: $OUT"
  has 'sha256 verified' || fail "sigterm: the verdict does not state the restore was verified: $OUT"
  [ "$(sha "$R/target.mjs")" = "$before" ] || fail "sigterm: target.mjs was left reverted"
  if kill -0 "$child" 2>/dev/null; then kill -9 "$child" 2>/dev/null; fail "sigterm: the command's child survived"; fi
}

# --- runner ------------------------------------------------------------------------------------

RAN=0
run() { # <acceptance name> <function>; the function name is accepted too
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || [ "$ONLY" = "${2#case_}" ] || return 0
  RAN=$((RAN + 1))
  CASE="$1"
  "$2" || exit 1
  pass "$1"
}

run red_first_green_when_the_test_passes_on_the_reverted_file case_red_first_green_when_the_test_passes_on_the_reverted_file
run red_first_ok_when_the_named_test_goes_red case_red_first_ok_when_the_named_test_goes_red
run red_first_other_when_a_different_test_goes_red case_red_first_other_when_a_different_test_goes_red
run red_first_any_accepts_a_red_without_a_test_name case_red_first_any_accepts_a_red_without_a_test_name
run red_first_na_without_a_claims_block case_red_first_na_without_a_claims_block
run red_first_na_for_a_claim_the_branch_did_not_change case_red_first_na_for_a_claim_the_branch_did_not_change
run red_first_fail_when_origin_main_does_not_resolve case_red_first_fail_when_origin_main_does_not_resolve
run red_first_restores_the_file_after_a_timeout case_red_first_restores_the_file_after_a_timeout
run red_first_restores_byte_for_byte_on_success case_red_first_restores_byte_for_byte_on_success
run lane_runs_the_seam_before_the_push case_lane_runs_the_seam_before_the_push
run check_sh_names_the_red_first_suite case_check_sh_names_the_red_first_suite
run red_first_ok_when_a_mutant_label_resolves case_red_first_ok_when_a_mutant_label_resolves
run red_first_waived_by_a_reasoned_red_first_none case_red_first_waived_by_a_reasoned_red_first_none
run red_first_na_for_a_file_the_branch_added case_red_first_na_for_a_file_the_branch_added
run red_first_na_with_more_than_four_commands case_red_first_na_with_more_than_four_commands
run red_first_na_when_field_two_names_only_a_fixture_file case_red_first_na_when_field_two_names_only_a_fixture_file
run red_first_other_when_the_name_appears_only_on_a_passing_line case_red_first_other_when_the_name_appears_only_on_a_passing_line
run red_first_green_reports_a_green_run_that_never_named_the_test case_red_first_green_reports_a_green_run_that_never_named_the_test
run red_first_kills_the_command_and_restores_on_sigterm case_red_first_kills_the_command_and_restores_on_sigterm
run red_first_fail_on_a_waiver_without_a_reason case_red_first_fail_on_a_waiver_without_a_reason
[ -z "$ONLY" ] || [ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
