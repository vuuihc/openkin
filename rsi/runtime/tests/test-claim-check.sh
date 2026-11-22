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
# Hermetic: temp dirs, one throwaway `git init` tree, a stubbed PR state, no network, no gh, no
# model. Set RSI_TEST_ONLY=<case name> to run one case (used to show a red run per case).
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
  RSI_CTRL="$T/ctrl-$CASE"
  rm -rf "$RSI_CTRL"
  mkdir -p "$RSI_CTRL/rsi/state/merge" "$RSI_CTRL/rsi/state/sendback" "$RSI_CTRL/rsi/runtime"
  cp "$ROOT/rsi/runtime/claim_check.py" "$RSI_CTRL/rsi/runtime/claim_check.py"
  BODY="$T/$CASE.body"; PATHS="$T/$CASE.paths"
  : > "$BODY"; : > "$PATHS"
}

body() { printf '%s\n' "$@" > "$BODY"; }
paths() { printf '%s\n' "$@" > "$PATHS"; }

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

# case_name_for <function> — the `new_case` name a function uses, so RSI_TEST_ONLY accepts either.
case_name_for() {
  case "$1" in
    test_claim_check_passes_when_the_command_output_matches) echo matching-output ;;
    test_claim_check_retries_a_command_that_prints_nothing) echo claim-check-retries-silence ;;
    test_claim_check_fails_when_the_retry_also_prints_nothing) echo claim-check-retry-also-silent ;;
    test_claim_check_does_not_retry_a_command_with_output) echo claim-check-no-retry-with-output ;;
    *) echo "" ;;
  esac
}

run() {
  if [ -n "${RSI_TEST_ONLY:-}" ]; then
    local match=0
    [ "$1" = "$RSI_TEST_ONLY" ] && match=1
    [ "$(case_name_for "$1")" = "$RSI_TEST_ONLY" ] && match=1
    [ "$match" -eq 1 ] || return 0
  fi
  "$1" || exit 1
}
run test_prose_pr_without_claim_check_is_sent_back
run test_claim_check_command_that_fails_is_sent_back
run test_claim_check_output_absent_from_real_output_is_sent_back
run test_claim_check_without_claim_output_is_sent_back
run test_claim_check_passes_when_the_command_output_matches
run test_claim_check_retries_a_command_that_prints_nothing
run test_claim_check_fails_when_the_retry_also_prints_nothing
run test_claim_check_does_not_retry_a_command_with_output
run test_code_only_pr_is_not_applicable
run test_waiver_with_a_reason_is_accepted_and_a_bare_none_is_not
run test_last_claim_check_line_wins_over_a_quoted_one
run test_claim_check_runs_before_the_reviewer_is_launched
echo "test-claim-check: ALL-PASS"
