#!/bin/bash
# test-claim-check.sh — the prose claim check must be executable, not a sentence in a prompt.
#
# Measured 2026-11-20: 10 of the last 21 first review findings were a doc sentence the tree
# contradicts (a GOAL line citing a walk that never ran, a DECISIONS claim the predicate does not
# implement, a PLAN count the registry disagrees with). The requirement existed only as prompt
# text pinned by two string tests: the gate never ran the command and never compared the output.
# This suite drives rsi/runtime/claim_check.py end to end on throwaway trees, through merge.sh's
# two hermetic seams (`--claim-check` = the script; `--claim-gate-check` = the same
# claim_check_gate() the verifier calls, mechanical sendback included). The last case is a wiring
# pin: it proves the call site sits between NEED_REV being decided and the reviewer being launched,
# which is the whole point (a false claim costs no model call). A string test proves a string; the
# rule itself is proven by the cases above it.
#
# Cases 9-15 prove the waiver is not a free pass: `Claim check: none: <reason>` used to return
# before the changed prose was read, and #546 shipped an ADR citing `rsi/GOAL.md:434` while its
# branch's GOAL.md was blank there. The scan reads only the changed prose files and resolves every
# `path:line` / `path:start-end` against the worktree; a real `Claim check:` command still owns its
# own proof and is never second-guessed.
#
# Hermetic: temp dirs, one throwaway `git init` tree, a stubbed PR state, no network, no gh, no
# model. Set RSI_TEST_ONLY=<case name> to run one case (used to show a red run per case); both the
# function name and the case name work, so `RSI_TEST_ONLY=citation-missing-line` is one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
GIT=/usr/bin/git
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SLUG="claim-check"
ITEM="R-latency-fix"
CASE=""; RC=0; OUT=""; RSI_CTRL=""

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# runs <counter-file> — how many times a claim command ran (0 when it never wrote the file).
runs() { if [ -e "$1" ]; then grep -c '' "$1"; else echo 0; fi; }

st() { echo "$RSI_CTRL/rsi/state"; }
sb() { echo "$(st)/sendback/$SLUG.md"; }
claimtxt() { echo "$(st)/merge/$SLUG.claim.txt"; }

# The worktree the check runs in: a real repo with one sentence a command can prove.
WT="$T/wt"
mkdir -p "$WT"
cat > "$WT/NOTES.md" <<'MD'
# Delivery notes
Prose claim check: the KIN-CONTINUE-001 story is signed.
MD
( cd "$WT" && "$GIT" init -q && "$GIT" add NOTES.md \
  && "$GIT" -c user.name=test -c user.email=test@example.com commit -qm "notes" ) \
  || fail "cannot build the throwaway worktree under $WT"

# RSI_PR_STATE_CMD replaces the gh state read; OPEN keeps sendback_mech() on today's path.
cat > "$T/pr-state-stub.sh" <<'SH'
#!/bin/bash
printf '%s\n' "${STUB_STATE_OUT:-OPEN}"
SH

# new_case <name> — fresh control tree, body and changed-files list. The control tree gets its own
# copy of claim_check.py at the deployed path, exactly as the merge lane resolves it, so a seam
# that read the script from anywhere else would go red.
new_case() {
  CASE="$1"
  WT="$T/wt"   # the shared worktree; a citation case opts into its own tree below
  RSI_CTRL="$T/ctrl-$CASE"
  rm -rf "$RSI_CTRL"
  mkdir -p "$RSI_CTRL/rsi/state/merge" "$RSI_CTRL/rsi/state/sendback" "$RSI_CTRL/rsi/runtime"
  cp "$ROOT/rsi/runtime/claim_check.py" "$RSI_CTRL/rsi/runtime/claim_check.py"
  BODY="$T/$CASE.body"; PATHS="$T/$CASE.paths"
  : > "$BODY"; : > "$PATHS"
}

body() { printf '%s\n' "$@" > "$BODY"; }
paths() { printf '%s\n' "$@" > "$PATHS"; }

# new_prose_case <name> — the usual fresh control tree plus a fresh worktree. A citation fixture
# (a file with N lines, a path that must be absent) is only meaningful in the tree that declares
# it, so the citation cases never share the original `$WT`.
new_prose_case() {
  new_case "$1"
  WT="$T/wt-$CASE"
  rm -rf "$WT"; mkdir -p "$WT"
  printf '%s\n' "# Delivery notes" \
    "Prose claim check: the KIN-CONTINUE-001 story is signed." > "$WT/NOTES.md"
}

# run_check — the script seam: no state write, exit code is the check's own.
run_check() {
  RSI_CTRL="$RSI_CTRL" bash "$MERGE" --claim-check "$WT" "$BODY" "$PATHS" > "$T/$CASE.out" 2>&1
  RC=$?; OUT="$(cat "$T/$CASE.out")"
}

# run_gate — the verifier's path: claim_check_gate(), mechanical sendback included.
run_gate() {
  RSI_CTRL="$RSI_CTRL" RSI_PR_STATE_CMD="bash $T/pr-state-stub.sh \"\$1\"" STUB_STATE_OUT=OPEN \
    bash "$MERGE" --claim-gate-check 461 "$SLUG" "$ITEM" "$WT" "$BODY" "$PATHS" > "$T/$CASE.out" 2>&1
  RC=$?; OUT="$(cat "$T/$CASE.out")"
}

expect_sent_back() { # <case> <detail fragment>
  [ "$RC" -ne 0 ] || fail "$1: exit 0, want a failed check ($OUT)"
  [ -f "$(sb)" ] || fail "$1: no sendback at $(sb) ($OUT)"
  grep -qF -- 'kind: mechanical' "$(sb)" || fail "$1: sendback is not mechanical"
  grep -qF -- 'source: mech-claim' "$(sb)" || fail "$1: sendback source is not mech-claim"
  grep -qF -- 'cmd: python3 rsi/runtime/claim_check.py' "$(sb)" \
    || fail "$1: sendback does not name the command to re-run"
  [ -f "$(claimtxt)" ] || fail "$1: no claim detail at $(claimtxt)"
  grep -qF -- "$2" "$(claimtxt)" || fail "$1: claim detail lacks '$2': $(cat "$(claimtxt)")"
}

# --- 1. a prose PR whose body never claims anything is sent back --------------------------------
test_prose_pr_without_claim_check_is_sent_back() {
  new_case prose-no-claim
  paths "rsi/GOAL.md" "internal/runtime/foo.go"
  body "Just a sentence change." ""
  run_gate
  expect_sent_back "$CASE" "no 'Claim check:' line"
  pass "$CASE"
}

# --- 2. a claim command that exits non-zero is a failure even when its output matches ------------
# The command prints the claimed line BEFORE failing, so this case can only go red through the
# exit-code rule: a checker that ignored the exit status would accept it.
test_claim_check_command_that_fails_is_sent_back() {
  new_case failing-command
  paths "rsi/DECISIONS.md"
  body "Claim check: grep -n 'absent sentence' NOTES.md; echo CLAIM_CHECK_RAN; exit 7" \
       "Claim output:" \
       "CLAIM_CHECK_RAN"
  run_gate
  expect_sent_back "$CASE" "exited 7"
  pass "$CASE"
}

# --- 3. output the command never printed is a failure -------------------------------------------
test_claim_check_output_absent_from_real_output_is_sent_back() {
  new_case invented-output
  paths "docs/adr/0001-claim-check.md"
  body "Claim check: grep -n 'Prose claim check' NOTES.md" \
       "Claim output:" \
       "2:Prose claim check: an ending the command never printed"
  run_gate
  expect_sent_back "$CASE" "not in the command's real output"
  pass "$CASE"
}

# --- 3c. colour is presentation: a plain claim matches a colourised run --------------------------
# Measured 2026-11-23: 15 lane/merge claims of the shape `Test Files  2 passed (2) | Tests  49
# passed (49)` failed only because vitest wrote the summary with SGR codes inside the words, so
# the line a person sees could never appear in the bytes the command wrote. Each false FAIL
# discarded a finished delivery; this case pins the normalization that stops it.
test_claim_check_passes_when_the_output_is_coloured() {
  new_case claim-coloured-output
  paths "docs/plans/claim-check.md"
  body "Claim check: printf '\\033[2m Test Files \\033[22m \\033[1m\\033[32m2 passed\\033[39m\\033[22m \\033[90m(2)\\033[39m\\n'" \
       "Claim output:" \
       "Test Files  2 passed (2)"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 — colour is presentation ($OUT)"
  case "$OUT" in CLAIM_OK:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_OK" ;; esac
  pass "$CASE"
}

# --- 3d. joining two printed lines with ` | ` is formatting, not an invention -------------------
test_claim_check_passes_when_two_printed_lines_are_joined() {
  new_case claim-joined-output
  paths "docs/plans/claim-check.md"
  body "Claim check: printf 'Test Files  2 passed (2)\\n      Tests  49 passed (49)\\n'" \
       "Claim output:" \
       "Test Files  2 passed (2) | Tests  49 passed (49)"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 — a join of two real lines is not a lie ($OUT)"
  case "$OUT" in CLAIM_OK:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_OK" ;; esac
  pass "$CASE"
}

# --- 3e. the join is not a loophole: one invented fragment still fails --------------------------
test_claim_check_fails_when_a_joined_fragment_was_never_printed() {
  new_case claim-invented-fragment
  paths "docs/plans/claim-check.md"
  body "Claim check: printf 'Test Files  2 passed (2)\\n      Tests  49 passed (49)\\n'" \
       "Claim output:" \
       "Test Files  2 passed (2) | Tests  99 passed (99)"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 — an invented fragment is still invented ($OUT)"
  case "$OUT" in *"not in the command's real output"*) ;; *) fail "$CASE: wrong verdict: $OUT" ;; esac
  pass "$CASE"
}

# --- 3b. a claim with no `Claim output:` block was never compared, so it is not delivered -------
test_claim_check_without_claim_output_is_sent_back() {
  new_case no-output
  paths "docs/product/IA.md"
  body "Claim check: grep -n 'Prose claim check' NOTES.md"
  run_gate
  expect_sent_back "$CASE" "no 'Claim output:' line"
  pass "$CASE"
}

# --- 4. real output may carry noise around the claimed line, and a fenced block is formatting ---
# A green claim must not pay twice: the run counter below proves the single-run path stayed single.
test_claim_check_passes_when_the_command_output_matches() {
  new_case matching-output
  local cnt="$T/matching-output.count"
  paths "docs/plans/claim-check.md"
  body "Claim check: grep -n 'Prose claim check' NOTES.md; echo x >> '$cnt'; printf 'noise before and after\\n'" \
       "Claim output:" \
       '```text' \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed." \
       '```'
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 ($OUT)"
  case "$OUT" in CLAIM_OK:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_OK" ;; esac
  [ "$(runs "$cnt")" -eq 1 ] \
    || fail "$CASE: the command ran $(runs "$cnt") times, want exactly 1"
  [ ! -e "$(sb)" ] || fail "$CASE: a passing check must not write a sendback"
  pass "$CASE"
}

# --- 4a. a silent non-zero run is not a verdict: it is retried, and the retry can pass ----------
# An OOM kill or a signal prints nothing and exits non-zero. Reporting that as a red claim cost a
# full rework round on a branch with nothing to fix, so the first silent result buys one retry.
test_claim_check_retries_a_command_that_prints_nothing() {
  new_case claim-check-retries-silence
  local cnt="$T/claim-check-retries-silence.count"
  paths "docs/plans/claim-check.md"
  body "Claim check: if [ -e '$cnt' ]; then echo CLAIM_CHECK_SECOND_RUN; else : > '$cnt'; exit 1; fi" \
       "Claim output:" \
       "CLAIM_CHECK_SECOND_RUN"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want the retried command to pass ($OUT)"
  case "$OUT" in CLAIM_OK:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_OK" ;; esac
  [ -e "$cnt" ] || fail "$CASE: the command ran only once; a silent failure must be retried"
  pass "$CASE"
}

# --- 4b. only a SECOND silent run is a failure, and it must say the command never answered ------
test_claim_check_fails_when_the_retry_also_prints_nothing() {
  new_case claim-check-retry-also-silent
  local cnt="$T/claim-check-retry-also-silent.count"
  paths "docs/plans/claim-check.md"
  body "Claim check: echo x >> '$cnt'; exit 1" \
       "Claim output:" \
       "CLAIM_CHECK_SECOND_RUN"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 after two silent runs ($OUT)"
  case "$OUT" in CLAIM_FAIL:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_FAIL" ;; esac
  case "$OUT" in *"no output on two runs"*) ;; *) fail "$CASE: detail lacks 'no output on two runs': $OUT" ;; esac
  case "$OUT" in *"did not reach a verdict"*) ;; *) fail "$CASE: detail lacks 'did not reach a verdict': $OUT" ;; esac
  case "$OUT" in *"want 0"*) fail "$CASE: the old ambiguous text survived: $OUT" ;; esac
  [ "$(runs "$cnt")" -eq 2 ] \
    || fail "$CASE: the command ran $(runs "$cnt") times, want exactly 2"
  pass "$CASE"
}

# --- 4c. a command that printed anything keeps today's single run, so a red claim is never retried
test_claim_check_does_not_retry_a_command_with_output() {
  new_case claim-check-no-retry-with-output
  local cnt="$T/claim-check-no-retry-with-output.count"
  paths "docs/plans/claim-check.md"
  body "Claim check: echo x >> '$cnt'; echo CLAIM_CHECK_RAN; exit 7" \
       "Claim output:" \
       "CLAIM_CHECK_RAN"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 ($OUT)"
  case "$OUT" in *"exited 7"*) ;; *) fail "$CASE: detail lacks 'exited 7': $OUT" ;; esac
  [ "$(runs "$cnt")" -eq 1 ] \
    || fail "$CASE: the command ran $(runs "$cnt") times; output must not be retried"
  pass "$CASE"
}

# --- 4d. a silent ZERO-exit run is not a verdict either: it is retried, and the retry can pass ---
# A command wrapped in `exit $rc` can print no summary and still exit 0 (#574's 13:44 round: the
# merge commit landed, then a shared node_modules run was silent and green). That silent zero-exit
# used to skip the retry and report the claimed lines as missing, a red with nothing to fix.
test_claim_check_retries_a_command_that_exits_zero_with_no_output() {
  new_case claim-check-retries-zero-silence
  local cnt="$T/claim-check-retries-zero-silence.count"
  paths "docs/plans/claim-check.md"
  body "Claim check: if [ -e '$cnt' ]; then echo x >> '$cnt'; echo CLAIM_CHECK_ZERO_SECOND_RUN; else echo x >> '$cnt'; exit 0; fi" \
       "Claim output:" \
       "CLAIM_CHECK_ZERO_SECOND_RUN"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want the retried command to pass ($OUT)"
  case "$OUT" in CLAIM_OK:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_OK" ;; esac
  [ "$(runs "$cnt")" -eq 2 ] \
    || fail "$CASE: the command ran $(runs "$cnt") times, want exactly 2 (a silent zero-exit must be retried)"
  pass "$CASE"
}

# --- 4e. two silent zero-exit runs say the command never answered, not that the claim is false ---
test_claim_check_fails_when_both_zero_exit_runs_are_silent() {
  new_case claim-check-zero-retry-also-silent
  local cnt="$T/claim-check-zero-retry-also-silent.count"
  paths "docs/plans/claim-check.md"
  body "Claim check: echo x >> '$cnt'; exit 0" \
       "Claim output:" \
       "CLAIM_CHECK_RAN"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 after two silent runs ($OUT)"
  case "$OUT" in CLAIM_FAIL:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_FAIL" ;; esac
  case "$OUT" in *"no output on two runs"*) ;; *) fail "$CASE: detail lacks 'no output on two runs': $OUT" ;; esac
  case "$OUT" in *"did not reach a verdict"*) ;; *) fail "$CASE: detail lacks 'did not reach a verdict': $OUT" ;; esac
  case "$OUT" in *"claimed output is not in the command's real output"*) \
    fail "$CASE: a silent zero-exit was reported as a false claim: $OUT" ;; esac
  [ "$(runs "$cnt")" -eq 2 ] \
    || fail "$CASE: the command ran $(runs "$cnt") times, want exactly 2"
  pass "$CASE"
}

# --- 4f. a zero-exit run that PRINTED a mismatch is a real red and keeps its single run -----------
test_claim_check_does_not_retry_a_zero_exit_mismatch_with_output() {
  new_case claim-check-zero-no-retry-with-output
  local cnt="$T/claim-check-zero-no-retry-with-output.count"
  paths "docs/plans/claim-check.md"
  body "Claim check: echo x >> '$cnt'; echo CLAIM_CHECK_OTHER; exit 0" \
       "Claim output:" \
       "CLAIM_CHECK_RAN"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 ($OUT)"
  case "$OUT" in *"claimed output is not in the command's real output"*) ;; \
    *) fail "$CASE: detail lacks the printed-mismatch sentence: $OUT" ;; esac
  [ "$(runs "$cnt")" -eq 1 ] \
    || fail "$CASE: the command ran $(runs "$cnt") times; a printed mismatch must not be retried"
  pass "$CASE"
}

# --- 5. a code-only PR is not asked for a claim check at all ------------------------------------
test_code_only_pr_is_not_applicable() {
  new_case code-only
  paths "internal/runtime/foo.go" "ui/src/App.tsx" "rsi/runtime/merge.sh" "scripts/check.sh"
  body "No prose changed."
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 ($OUT)"
  case "$OUT" in CLAIM_NA:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_NA" ;; esac
  [ ! -e "$(sb)" ] || fail "$CASE: a code-only PR must not write a sendback"
  pass "$CASE"
}

# --- 6. a reasoned waiver passes and is logged; a bare `none` fails -----------------------------
test_waiver_with_a_reason_is_accepted_and_a_bare_none_is_not() {
  new_case waiver
  paths "docs/product/TASTE.md"
  body "Claim check: none: this PR only renames a heading; no command can prove a rename"
  run_gate
  [ "$RC" -eq 0 ] || fail "$CASE: a reasoned waiver exited $RC, want 0 ($OUT)"
  [ ! -e "$(sb)" ] || fail "$CASE: a reasoned waiver must not write a sendback"
  grep -qF -- "#461 $SLUG claim_check=waived" "$(st)/merge/cycles.log" \
    || fail "$CASE: cycles.log lacks the claim_check=waived line"

  # Fresh state: the bare waiver must fail on its own, not inherit the accepted one's files.
  rm -rf "$(st)"; mkdir -p "$(st)/merge" "$(st)/sendback"
  body "Claim check: none"
  run_gate
  expect_sent_back "$CASE" "a waiver needs a reason"
  pass "$CASE"
}

# --- 7. the last column-0 claim check wins, not a brief quoted earlier --------------------------
test_last_claim_check_line_wins_over_a_quoted_one() {
  new_case last-line
  paths "rsi/ASTRYX-PLAN.md"
  body "The brief I was handed said:" \
       "" \
       "Claim check: grep -n 'never in this tree' NOTES.md" \
       "" \
       "Claim output:" \
       "1:never in this tree" \
       "" \
       "What the branch actually delivers:" \
       "" \
       "Claim check: grep -n 'Prose claim check' NOTES.md" \
       "" \
       "Claim output:" \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want the last claim check to pass ($OUT)"
  case "$OUT" in *"Prose claim check"*) ;; *) fail "$CASE: the quoted command won: $OUT" ;; esac
  pass "$CASE"
}

# --- 8. wiring pin: the check runs after NEED_REV is final and before the reviewer launch --------
# Not evidence for the rule (cases 1-7 are): this only fails when the call site is deleted or
# moved behind the review launch, which would silently restore the defect the row names.
test_claim_check_runs_before_the_reviewer_is_launched() {
  local name="test_claim_check_runs_before_the_reviewer_is_launched" call guards review
  call="$(grep -nF 'claim_check_gate "$N" "$SLUG"' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$call" ] || fail "$name: merge.sh has no claim_check_gate call at the verifier"
  guards="$(grep -nF 'if [ $NEED_REV -eq 1 ]; then' "$MERGE" | cut -d: -f1 | tr '\n' ' ')"
  review="$(echo "$guards" | awk '{print $2}')"
  [ -n "$review" ] || fail "$name: cannot locate the reviewer-launch block"
  [ "$call" -gt "$(echo "$guards" | awk '{print $1}')" ] \
    || fail "$name: the claim check runs before NEED_REV is final (call $call)"
  [ "$call" -lt "$review" ] \
    || fail "$name: the claim check runs after the reviewer is launched (call $call, review $review)"
  grep -qF -- '--claim-check <worktree>' "$MERGE" || fail "$name: no --claim-check seam"
  grep -qF -- '--claim-gate-check <pr-number>' "$MERGE" || fail "$name: no --claim-gate-check seam"
  pass "$name"
}

# --- 9. a waiver does not exempt a citation the branch's own tree cannot resolve -----------------
# #546's shape: the ADR cited rsi/GOAL.md:434 while the branch's GOAL.md had no line 434, and the
# PR body waived the check. The waiver is accepted only after the changed prose's citations resolve.
test_citation_missing_line() {
  new_prose_case citation-missing-line
  mkdir -p "$WT/rsi"
  printf '%s\n' "# Goal" "" 'The walk at `rsi/GOAL.md:434` proves the sentence.' > "$WT/rsi/GOAL.md"
  paths "rsi/GOAL.md"
  body "Claim check: none: no citation changes in this PR"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 ($OUT)"
  case "$OUT" in CLAIM_FAIL:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_FAIL" ;; esac
  case "$OUT" in *"rsi/GOAL.md:434"*) ;; *) fail "$CASE: does not name rsi/GOAL.md:434: $OUT" ;; esac
  pass "$CASE"
}

# --- 10. a citation to a file that is not in the worktree is not proven --------------------------
test_citation_missing_file() {
  new_prose_case citation-missing-file
  mkdir -p "$WT/docs/plans"
  printf '%s\n' 'The rule lives at `docs/adr/9999-nope.md:3`.' > "$WT/docs/plans/patrol.md"
  paths "docs/plans/patrol.md"
  body "Claim check: none: the plan only quotes an ADR that already landed"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 ($OUT)"
  case "$OUT" in CLAIM_FAIL:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_FAIL" ;; esac
  case "$OUT" in *"docs/adr/9999-nope.md"*) ;; *) fail "$CASE: does not name the path: $OUT" ;; esac
  pass "$CASE"
}

# --- 11. a range must fit the file: 10-20 fails on 15 lines and resolves on 30 ------------------
test_citation_range() {
  new_prose_case citation-range
  mkdir -p "$WT/docs/plans" "$WT/ui/src"
  printf '%s\n' 'The card lives at `ui/src/x.tsx:10-20`.' > "$WT/docs/plans/patrol.md"
  paths "docs/plans/patrol.md"
  body "Claim check: none: the plan moves no citation target in this PR"
  awk 'BEGIN { for (i = 1; i <= 15; i++) print "line " i }' > "$WT/ui/src/x.tsx"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: 15 lines: exit $RC, want 1 ($OUT)"
  case "$OUT" in CLAIM_FAIL:*) ;; *) fail "$CASE: 15 lines: output is '$OUT', want CLAIM_FAIL" ;; esac
  case "$OUT" in *"ui/src/x.tsx:10-20"*) ;; *) fail "$CASE: does not name the range: $OUT" ;; esac

  # The same citation against a 30-line file resolves, so the waiver is unchanged (exit 0).
  awk 'BEGIN { for (i = 1; i <= 30; i++) print "line " i }' > "$WT/ui/src/x.tsx"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: 30 lines: exit $RC, want 0 ($OUT)"
  case "$OUT" in CLAIM_WAIVED:*) ;; *) fail "$CASE: 30 lines: output is '$OUT', want CLAIM_WAIVED" ;; esac
  pass "$CASE"
}

# --- 12. when every citation resolves the waiver is printed exactly as before --------------------
# The stale citations outside the changed list (rsi/GOAL.md, ui/src/App.tsx) are deliberate: the
# scan reads only changed prose, so a repo walk or an unfiltered path list would turn this red.
test_citation_resolves_waives() {
  new_prose_case citation-resolves-waives
  mkdir -p "$WT/docs/plans" "$WT/rsi" "$WT/ui/src"
  printf '%s\n' 'The notes at `NOTES.md:2` and this line at `docs/plans/patrol.md:1` agree.' \
    'A URL is not a citation: https://example.com/notes.md:12 is just a link.' \
    > "$WT/docs/plans/patrol.md"
  printf '%s\n' 'An unrelated stale citation `rsi/GOAL.md:434` is not in the changed list.' \
    > "$WT/rsi/GOAL.md"
  printf '%s\n' 'const x = 1; // ui/src/App.tsx:999 is a code file, not prose.' > "$WT/ui/src/App.tsx"
  paths "docs/plans/patrol.md" "ui/src/App.tsx"
  body "Claim check: none: every citation in the plan already resolves on this branch"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 ($OUT)"
  case "$OUT" in "CLAIM_WAIVED: every citation in the plan already resolves on this branch") ;;
    *) fail "$CASE: output is '$OUT', want the unchanged CLAIM_WAIVED line" ;;
  esac
  pass "$CASE"
}

# --- 13. a code-only PR is still not applicable, waiver or not ----------------------------------
test_citation_code_only_na() {
  new_prose_case citation-code-only-na
  paths "internal/runtime/foo.go" "ui/src/App.tsx" "rsi/runtime/merge.sh"
  body "Claim check: none: this PR only touches the runtime and the console"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 ($OUT)"
  case "$OUT" in CLAIM_NA:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_NA" ;; esac
  pass "$CASE"
}

# --- 14. a real Claim check: command is its own proof and is never second-guessed ---------------
# The changed prose deliberately cites a line that does not exist: only the command's own output
# decides here, so a scan that ran anyway would turn this CLAIM_OK red.
test_citation_real_command_unchanged() {
  new_prose_case citation-real-command-unchanged
  mkdir -p "$WT/docs/plans"
  printf '%s\n' 'A stale citation `rsi/GOAL.md:434` that the command does not claim.' \
    > "$WT/docs/plans/patrol.md"
  paths "docs/plans/patrol.md"
  body "Claim check: grep -n 'Prose claim check' NOTES.md" \
       "Claim output:" \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 ($OUT)"
  case "$OUT" in CLAIM_OK:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_OK" ;; esac
  pass "$CASE"
}

# --- 15. a changed prose file that cannot be read fails closed ----------------------------------
# A citation set that cannot be read is not proven. A directory at the prose path is the
# deterministic unreadable case (it fails even for a user who could read a mode-000 file).
test_citation_unreadable_fails() {
  new_prose_case citation-unreadable-fails
  mkdir -p "$WT/docs/plans/locked.md"
  paths "docs/plans/locked.md"
  body "Claim check: none: no citation changes in this PR"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 ($OUT)"
  case "$OUT" in CLAIM_FAIL:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_FAIL" ;; esac
  case "$OUT" in *"docs/plans/locked.md"*) ;; *) fail "$CASE: does not name the path: $OUT" ;; esac
  pass "$CASE"
}

# --- 16. only the lines this branch added are scanned -------------------------------------------
# rsi/GOAL.md:547 `J2.json:68`, DECISIONS.md:64 `tokens.test.ts:1562` and LESSONS.md:1185
# `TaskDetailPage.tsx:1286` are pre-existing stale citations in living files. Scanning a whole
# living file would reject every future waiver that touches one of them, so a git worktree with a
# resolvable origin/main scans only the branch's added lines. The same repo still rejects a bad
# citation this branch adds, so the narrowing is not a skip.
test_citation_historical_lines_are_not_rescanned() {
  new_prose_case citation-historical-lines
  mkdir -p "$WT/rsi" "$WT/docs/plans"
  printf '%s\n' "# Goal" "" 'A historical citation `rsi/GOAL.md:434` that main already carried.' \
    > "$WT/rsi/GOAL.md"
  printf '%s\n' "# Patrol" "" 'The notes at `NOTES.md:2` agree.' > "$WT/docs/plans/patrol.md"
  ( cd "$WT" && "$GIT" init -q && "$GIT" add -A \
    && "$GIT" -c user.name=test -c user.email=test@example.com commit -qm "main" \
    && "$GIT" update-ref refs/remotes/origin/main HEAD ) \
    || fail "$CASE: cannot build the branch fixture"
  paths "rsi/GOAL.md" "docs/plans/patrol.md"
  body "Claim check: none: the historical line is not part of this PR"
  printf '%s\n' 'The sentence at `docs/plans/patrol.md:1` is this PR only.' >> "$WT/rsi/GOAL.md"
  ( cd "$WT" && "$GIT" add -A \
    && "$GIT" -c user.name=test -c user.email=test@example.com commit -qm "branch" ) \
    || fail "$CASE: cannot commit this branch's change"
  run_check
  [ "$RC" -eq 0 ] || fail "$CASE: exit $RC, want 0 for an untouched historical citation ($OUT)"
  case "$OUT" in CLAIM_WAIVED:*) ;; *) fail "$CASE: output is '$OUT', want CLAIM_WAIVED" ;; esac

  # A citation the branch itself adds is still the branch's claim, so it must still fail. The
  # line's own text starts with `++`, so the diff marks it `+++...`: a parser that skips every
  # `+++` line as a header would silently drop it.
  printf '%s\n' '++ `ui/src/gone.tsx:9` this branch adds.' \
    >> "$WT/docs/plans/patrol.md"
  ( cd "$WT" && "$GIT" add -A \
    && "$GIT" -c user.name=test -c user.email=test@example.com commit -qm "branch line" ) \
    || fail "$CASE: cannot commit the added citation"
  run_check
  [ "$RC" -eq 1 ] || fail "$CASE: exit $RC, want 1 for a citation this branch added ($OUT)"
  case "$OUT" in *"ui/src/gone.tsx:9"*) ;; *) fail "$CASE: does not name the added citation: $OUT" ;; esac
  pass "$CASE"
}

run() { # <function> [<case name>] — RSI_TEST_ONLY accepts either spelling
  local fn="$1" name="${2:-$1}"
  [ -n "${RSI_TEST_ONLY:-}" ] && [ "$fn" != "$RSI_TEST_ONLY" ] && [ "$name" != "$RSI_TEST_ONLY" ] \
    && return 0
  "$fn" || exit 1
}
run test_prose_pr_without_claim_check_is_sent_back
run test_claim_check_command_that_fails_is_sent_back
run test_claim_check_output_absent_from_real_output_is_sent_back
run test_claim_check_passes_when_the_output_is_coloured claim-coloured-output
run test_claim_check_passes_when_two_printed_lines_are_joined claim-joined-output
run test_claim_check_fails_when_a_joined_fragment_was_never_printed claim-invented-fragment
run test_claim_check_without_claim_output_is_sent_back
run test_claim_check_passes_when_the_command_output_matches
run test_code_only_pr_is_not_applicable
run test_waiver_with_a_reason_is_accepted_and_a_bare_none_is_not
run test_last_claim_check_line_wins_over_a_quoted_one
run test_citation_missing_line citation-missing-line
run test_citation_missing_file citation-missing-file
run test_citation_range citation-range
run test_citation_resolves_waives citation-resolves-waives
run test_citation_code_only_na citation-code-only-na
run test_citation_real_command_unchanged citation-real-command-unchanged
run test_citation_unreadable_fails citation-unreadable-fails
run test_citation_historical_lines_are_not_rescanned citation-historical-lines
run test_claim_check_runs_before_the_reviewer_is_launched
run test_claim_check_retries_a_command_that_prints_nothing claim-check-retries-silence
run test_claim_check_fails_when_the_retry_also_prints_nothing claim-check-retry-also-silent
run test_claim_check_does_not_retry_a_command_with_output claim-check-no-retry-with-output
run test_claim_check_retries_a_command_that_exits_zero_with_no_output claim-check-retries-zero-silence
run test_claim_check_fails_when_both_zero_exit_runs_are_silent claim-check-zero-retry-also-silent
run test_claim_check_does_not_retry_a_zero_exit_mismatch_with_output claim-check-zero-no-retry-with-output
echo "test-claim-check: ALL-PASS"
