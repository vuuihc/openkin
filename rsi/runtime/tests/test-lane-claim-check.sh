#!/bin/bash
# test-lane-claim-check.sh — the lane refuses to push a prose PR whose claim check is absent,
# empty, invented or contradicted.
#
# Measured 11-20 13:43 → 11-21 13:43 (`mech-claim·rsi` ×6 of 51 rounds): every round was the same
# finding. merge.sh's claim_check_gate() refused a PR whose prose sentence had no `Claim check:`
# line, an empty `Claim output:` block or invented output — but the worker learned that only after
# a full gate and an independent review (sendback/done/gap-log-close-20261121-090510,
# walk-continue-005-134144, phone-list-deliver-193400, phone-shell-glass-ceo-claim-fix, …).
# The sibling seam (#523) proved the same lever for mutant evidence: run the gate's own check in
# the lane, before the push, and tell the worker to run it before it finishes.
#
# This suite drives `lane.sh --claim-check-check <worktree> <body-file>`, which reuses
# rsi/runtime/claim_check.py (the merge gate's single rule, never modified here) against the same
# changed-file list merge.sh computes. The seam rewrites the leading CLAIM_ to CLAIM_LANE_ so the
# lane verdict is distinguishable from the merge lane's, and passes the checker's exit code
# through. Hermetic: throwaway git trees under mktemp -d, a bare origin per case so origin/main
# resolves, RSI_CTRL redirected into the temp dir (common.sh derives STATE and RSI_DIR from it), a
# stubbed lane-pr.sh and a copy of the real claim_check.py at the deployed path. No network, no
# real gh, no npm, no model calls. Live-body cases use RSI_GH and run the production push/PR
# tail against the bare origin. Prints "PASS <case>" per case and exits non-zero on the first
# failure. Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$RUNTIME/../.." && pwd)"
LANE="$RUNTIME/lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
CTRL="$T/ctrl"; mkdir -p "$CTRL/rsi/state/lanes" "$CTRL/rsi/runtime"
# lane.sh sources $RSI_DIR/runtime/lane-pr.sh before any seam; the seam reads claim_check.py from
# the same deployed path, so a copy keeps the suite hermetic and proves the real rule runs.
printf '#!/bin/bash\n# stub: the seams never create a PR\n' > "$CTRL/rsi/runtime/lane-pr.sh"
cp "$REPO/rsi/runtime/claim_check.py" "$CTRL/rsi/runtime/claim_check.py" \
  || { echo "FAIL cannot copy claim_check.py" >&2; exit 1; }
R=""   # the worktree the current case works on
BODY=""  # the PR body the current case passes to the seam
ONLY="${RSI_TEST_ONLY:-}"
OUT=""; RC=0

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# new_repo <name> — bare origin inside the temp dir plus a worktree on main. Main seeds NOTES.md
# (one line a claim command can prove), a code path, a prose path and an ignored built bundle, so
# every case changes only what it names. origin/main is a real ref at the base commit.
new_repo() {
  local name="$1"
  R="$T/$name"; rm -rf "$R" "$T/$name.git"
  git init -q --bare "$T/$name.git" || fail "$name: bare init failed"
  git init -q -b main "$R" || fail "$name: git init failed"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  mkdir -p "$R/ui/src" "$R/docs/plans" "$R/docs/product"
  cat > "$R/NOTES.md" <<'MD'
# Delivery notes
Prose claim check: the KIN-CONTINUE-001 story is signed.
MD
  printf 'export const foo = 1\n' > "$R/ui/src/foo.ts"
  printf '# gap log\n' > "$R/docs/plans/gap-log.md"
  printf '# IA\n' > "$R/docs/product/IA.md"
  # A lane that ran the product's `npm run build` leaves built, ignored bundles behind; the seam
  # must read the tree as clean (STATUS Watch 76).
  printf 'web/dist/assets/\n' > "$R/.gitignore"
  g add -A >/dev/null && g commit -q -m base || fail "$name: base commit failed"
  g remote add origin "$T/$name.git" || fail "$name: remote add failed"
  g push -q -u origin main || fail "$name: push main failed"
  g update-ref refs/remotes/origin/main HEAD
}

# change <path> <line> — one committed change on the branch: the PR's own diff.
change() { printf '%s\n' "$2" >> "$R/$1" && g add -A >/dev/null && g commit -q -m "change $1" \
  || fail "cannot commit a change to $1"; }

# body <line>... — the PR body the seam reads.
body() { BODY="$T/body.md"; printf '%s\n' "$@" > "$BODY"; }

# seam — run the lane's claim-check seam on the current worktree. Sets OUT (stdout) and RC.
seam() {
  OUT="$(RSI_CTRL="$CTRL" HOME="$T/home" bash "$LANE" --claim-check-check "$R" "$BODY" 2>"$T/seam.err")"
  RC=$?
}
seam_output_has() { grep -qF -- "$1" <<<"$OUT"; }

# --- cases -------------------------------------------------------------------------------------

# A code-only PR is never asked for a claim check: the checker returns NA before it reads the body,
# so a missing body file must not turn into a failure.
case_code_only_change_is_na() {
  new_repo codeonly
  change ui/src/foo.ts 'export const foo = 2'
  BODY="$T/codeonly-missing.body"; rm -f "$BODY"
  seam
  [ "$RC" -eq 0 ] || fail "codeonly: exit $RC, want 0 ($OUT; $(cat "$T/seam.err"))"
  [ "$OUT" = "CLAIM_LANE_NA: no prose-assertion path changed (code-only PR)" ] \
    || fail "codeonly: unexpected output: $OUT"
}

# The gap-log round: a prose path changed and the body never claims anything.
case_prose_change_without_claim_check_fails() {
  new_repo prose
  change docs/plans/gap-log.md '- a sentence the tree contradicts'
  body "Just a sentence change." ""
  seam
  [ "$RC" -eq 1 ] || fail "prose: exit $RC, want 1 ($OUT)"
  seam_output_has 'CLAIM_LANE_FAIL:' || fail "prose: no FAIL verdict: $OUT"
  seam_output_has 'docs/plans/gap-log.md' || fail "prose: the changed path is not named: $OUT"
}

# The 13:41 #527 round: a `Claim output:` block with no claimed line was never compared.
case_empty_claim_output_fails() {
  new_repo emptyout
  change docs/product/IA.md '- a surface sentence'
  body "Claim check: grep -n 'x' NOTES.md" "Claim output:"
  seam
  [ "$RC" -eq 1 ] || fail "emptyout: exit $RC, want 1 ($OUT)"
  seam_output_has 'CLAIM_LANE_FAIL:' || fail "emptyout: no FAIL verdict: $OUT"
  seam_output_has 'block is empty' || fail "emptyout: the empty block is not named: $OUT"
}

# A claimed line the command never printed is an invented proof.
case_invented_output_fails() {
  new_repo invented
  change docs/plans/gap-log.md '- another sentence'
  body "Claim check: grep -n 'Prose claim check' NOTES.md" \
       "Claim output:" \
       "99:Prose claim check: an ending the command never printed"
  seam
  [ "$RC" -eq 1 ] || fail "invented: exit $RC, want 1 ($OUT)"
  seam_output_has 'CLAIM_LANE_FAIL:' || fail "invented: no FAIL verdict: $OUT"
  seam_output_has "not in the command's real output" \
    || fail "invented: the mismatch is not named: $OUT"
}

# The real output of the command is the claimed line: the hand-off is proven.
case_true_claim_passes() {
  new_repo trueclaim
  change docs/plans/gap-log.md '- a sentence the tree supports'
  body "Claim check: grep -n 'Prose claim check' NOTES.md" \
       "Claim output:" \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  seam
  [ "$RC" -eq 0 ] || fail "trueclaim: exit $RC, want 0 ($OUT)"
  case "$OUT" in
    "CLAIM_LANE_OK: "*) ;;
    *) fail "trueclaim: unexpected output: $OUT" ;;
  esac
}

# A reasoned waiver is the escape hatch; the reason length rule is claim_check.py's.
case_waiver_passes() {
  new_repo waiver
  change docs/product/IA.md '- a heading rename'
  body "Claim check: none: this PR only renames a heading; no command can prove a rename"
  seam
  [ "$RC" -eq 0 ] || fail "waiver: exit $RC, want 0 ($OUT)"
  case "$OUT" in
    "CLAIM_LANE_WAIVED: "*) ;;
    *) fail "waiver: unexpected output: $OUT" ;;
  esac
}

# A missing body is only a failure when a prose path changed: NA for code, FAIL naming the body
# for prose. This is the pass-through contract, not a special case in the seam.
case_missing_body_fails_only_for_prose() {
  new_repo nobody-code
  change ui/src/foo.ts 'export const foo = 3'
  BODY="$T/nobody-code.body"; rm -f "$BODY"
  seam
  [ "$RC" -eq 0 ] || fail "nobody-code: exit $RC, want 0 ($OUT)"
  seam_output_has 'CLAIM_LANE_NA:' || fail "nobody-code: want NA, got: $OUT"

  new_repo nobody-prose
  change docs/plans/gap-log.md '- a sentence with no body'
  BODY="$T/nobody-prose.body"; rm -f "$BODY"
  seam
  [ "$RC" -eq 1 ] || fail "nobody-prose: exit $RC, want 1 ($OUT)"
  seam_output_has 'CLAIM_LANE_FAIL:' || fail "nobody-prose: no FAIL verdict: $OUT"
  seam_output_has 'cannot read the PR body' || fail "nobody-prose: the body is not named: $OUT"
}

# Without origin/main the seam cannot compute the PR's diff. Reading that as "no prose changed"
# would hand off exactly the PR the gate is about to send back, so it fails closed.
case_unresolvable_origin_main_fails_closed() {
  new_repo nobase
  change docs/plans/gap-log.md '- a sentence with no branch point'
  body "Claim check: none: this reason is long enough to waive the check"
  g update-ref -d refs/remotes/origin/main || fail "nobase: cannot drop origin/main"
  seam
  [ "$RC" -eq 1 ] || fail "nobase: exit $RC, want 1 ($OUT)"
  seam_output_has 'CLAIM_LANE_FAIL:' || fail "nobase: no FAIL verdict: $OUT"
  seam_output_has 'origin/main' || fail "nobase: origin/main is not named: $OUT"
}

# The lever is the contract every worker reads first: it must name the command and the verdicts.
case_worker_contract_names_the_seam() {
  local out
  out="$(RSI_CTRL="$CTRL" HOME="$T/home" bash "$LANE" --worker-contract-check R-x new "$T/wt" rsi/x 2>"$T/seam.err")" \
    || fail "contract: the seam exited non-zero ($(cat "$T/seam.err"))"
  grep -qF -- '--claim-check-check' <<<"$out" \
    || fail "contract: the worker contract does not name --claim-check-check"
  grep -qF 'CLAIM_LANE_OK' <<<"$out" \
    || fail "contract: the worker contract does not name the OK verdict"
  grep -qF '.pr-body.md' <<<"$out" \
    || fail "contract: the worker contract does not name the body file"
}

# The lane must run the seam itself under a guard that fails the lane, after the mutant-evidence
# check and before the push. A `|| true` (or a dropped exit) is the regression: the call still
# runs, the lane still pushes, and the reviewer is the first reader again.
case_lane_runs_seam_before_push() {
  local call='if ! CLAIM_EV="$(bash "$SELF" --claim-check-check "$WT" "$STATUS_NOTE_FILE" 2>&1)"; then'
  local mut inv push fin
  [ -f "$LANE" ] || fail "wiring: $LANE missing"
  [ "$(grep -cF "$call" "$LANE")" -eq 1 ] \
    || fail "wiring: the guarded call occurs $(grep -cF "$call" "$LANE") time(s), want 1"
  inv="$(grep -nF "$call" "$LANE" | cut -d: -f1)"
  mut="$(grep -nF 'if ! MUT_EV="$(bash "$SELF" --mutant-evidence-check "$WT" 2>&1)"; then' "$LANE" | cut -d: -f1)"
  [ -n "$mut" ] || fail "wiring: lane.sh has no mutant-evidence call"
  push="$(grep -n 'push -q -u' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$push" ] || fail "wiring: lane.sh has no 'push -q -u' line"
  [ "$inv" -gt "$mut" ] \
    || fail "wiring: the claim check (line $inv) does not run after mutant evidence (line $mut)"
  [ "$inv" -lt "$push" ] \
    || fail "wiring: the claim check (line $inv) runs after the push (line $push)"
  fin="$(grep -nF 'finish failed "" "claim check:' "$LANE" | cut -d: -f1)"
  [ -n "$fin" ] || fail "wiring: no failure branch records the claim-check verdict"
  [ "$fin" -gt "$inv" ] && [ "$fin" -lt "$push" ] \
    || fail "wiring: the failure branch (line $fin) is not between the check and the push"
  awk -v a="$inv" -v b="$push" 'NR > a && NR < b && /^[[:space:]]*exit 1[[:space:]]*$/ { found = 1 } END { exit !found }' "$LANE" \
    || fail "wiring: no exit 1 between the check and the push"
}

# A standalone suite nothing runs is not a wiring (Watch 77).
case_check_sh_wires_the_suite() {
  local body_text
  body_text="$(awk '/^job_shell_test\(\)[[:space:]]*\{/ { on = 1 } on { print } on && /^\}/ { exit }' \
                "$REPO/scripts/check.sh" | sed -E 's/(^|[[:space:]])#.*$//')"
  [ -n "$body_text" ] || fail "wiring: scripts/check.sh has no job_shell_test()"
  grep -qF 'rsi/runtime/tests/test-lane-claim-check.sh' <<<"$body_text" \
    || fail "wiring: job_shell_test() does not name test-lane-claim-check.sh"
}

# Watch 76: a clean tree that ran the product build leaves ignored bundles, and the seam must read
# that as no change, not as an unreadable diff.
case_clean_tree_with_built_assets_is_na() {
  new_repo clean
  mkdir -p "$R/web/dist/assets"
  printf 'bundle\n' > "$R/web/dist/assets/index-abc.js"
  [ -z "$(g status --porcelain)" ] || fail "clean: the fixture is not a clean tree"
  BODY="$T/clean.body"; rm -f "$BODY"
  seam
  [ "$RC" -eq 0 ] || fail "clean: exit $RC, want 0 ($OUT; $(cat "$T/seam.err"))"
  seam_output_has 'CLAIM_LANE_NA:' || fail "clean: want NA, got: $OUT"
}

# A fake GitHub retains its old body even when edit reports success: only a read-back can prove
# what the merge lane will read. All commands are logged, so code-only can prove zero reads.
live_fixture() {
  new_repo "$1"
  g checkout -qb rsi/live-body || fail "cannot create fixture branch"
  change "${2:-docs/plans/gap-log.md}" 'a delivery change'
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  LIVE_BODY="$T/live.body"; cp "$BODY" "$LIVE_BODY"
  GH_STUB="$T/gh-stub"; GH_CALLS="$T/gh.calls"; : > "$GH_CALLS"
  VIEW_MODE=body; EDIT_RC=0; LIST_MODE=existing
  HANDOFF_GIT=/usr/bin/git; HANDOFF_CHECK_SECS=180
  cat > "$GH_STUB" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$STUB_CALLS"
case "$1 $2" in
  'pr list') [ "$STUB_LIST_MODE" != existing ] || echo 123 ;;
  'pr create') echo 'https://github.com/example/repo/pull/123' ;;
  'pr edit') echo 'stub edit rejected' >&2; exit "$STUB_EDIT_RC" ;;
  'pr comment') : ;;
  'pr view')
    case "$STUB_VIEW_MODE" in
      error) echo 'stub read rejected' >&2; exit 1 ;;
      empty) exit 0 ;;
      whitespace) printf ' \n\t\n'; exit 0 ;;
      retry) [ "$(grep -c '^pr view ' "$STUB_CALLS")" -gt 1 ] || exit 1 ;;
      timeout) sleep 20 & wait; exit 1 ;;
    esac
    cat "$STUB_BODY" ;;
  *) echo "unexpected gh command: $*" >&2; exit 1 ;;
esac
SH
  chmod +x "$GH_STUB"
}

live_seam() {
  OUT="$(RSI_CTRL="$CTRL" HOME="$T/home" RSI_GH="$GH_STUB" \
    STUB_CALLS="$GH_CALLS" STUB_BODY="$LIVE_BODY" STUB_VIEW_MODE="$VIEW_MODE" \
    STUB_EDIT_RC="$EDIT_RC" STUB_LIST_MODE="$LIST_MODE" \
    bash "$LANE" --pr-body-check "$R" 123 "$BODY" 2>&1)"; RC=$?
}

# Execute the actual push/create/edit/check/finish block, with no worker/model/bookkeeping. The
# real push targets this case's bare origin. Stopping at finish done prevents merge/pulse launches.
# Set GH explicitly too: the pre-fix common.sh ignores RSI_GH and RED must never reach the network.
pr_handoff() {
  local hdr="$T/brief.md"
  : > "$hdr"; touch -t 200001010000 "$hdr"
  {
    printf '#!/bin/bash\nset -u\nsource %q\n' "$RUNTIME/common.sh"
    printf 'SELF=%q\nWT=%q\nBR=rsi/live-body\nSTATUS_NOTE_FILE=%q\nHDR=%q\n' \
      "$LANE" "$R" "$BODY" "$hdr"
    printf 'FINISH_FILE=%q\nGH=%q\n' "$T/finish" "$GH_STUB"
    printf 'source %q\n' "$RUNTIME/lane-pr.sh"
    cat <<'SH'
N=1; ITEM=R-fixture; SLUG=fixture; MODE=new; WORKER_TITLE='fix: fixture'
TIMEDOUT=0; W_MIN=0; COST=0; SWEPT_N=0
finish() { printf '%s\n' "$*" >> "$FINISH_FILE"; }
count_fail() { :; }; count_ok() { :; }; scorecard_row() { :; }
SH
    awk '/^# push \+ PR / { on = 1 } on { print } on && /^finish done / { exit }' "$LANE"
  } > "$T/handoff.sh"
  rm -f "$T/finish"
  OUT="$(RSI_CTRL="$CTRL" HOME="$T/home" RSI_GH="$GH_STUB" \
    STUB_CALLS="$GH_CALLS" STUB_BODY="$LIVE_BODY" STUB_VIEW_MODE="$VIEW_MODE" \
    STUB_EDIT_RC="$EDIT_RC" STUB_LIST_MODE="$LIST_MODE" STUB_SLOW_GIT="$T/slow-git-started" \
    GIT="$HANDOFF_GIT" RSI_PR_BODY_CHECK_SECS="$HANDOFF_CHECK_SECS" \
    bash "$T/handoff.sh" 2>&1)"; RC=$?
}

assert_live_fail() {
  [ "$RC" -eq 1 ] || fail "live body: exit $RC, want 1 ($OUT)"
  seam_output_has 'PR_BODY_FAIL:' || fail "live body: no FAIL verdict ($OUT)"
  ! seam_output_has 'PR_BODY_OK' || fail "live body: FAIL also reported OK ($OUT)"
}

case_live_body_missing_claim_fails() {
  live_fixture live-missing
  printf 'An old summary without the claim line.\n' > "$LIVE_BODY"
  live_seam; assert_live_fail
  seam_output_has "no 'Claim check:' line" || fail "missing live claim is not named ($OUT)"
  pr_handoff; assert_live_fail
  grep -q '^failed .*pr body:' "$T/finish" || fail "handoff did not record failed ($OUT)"
  ! grep -q '^done ' "$T/finish" || fail "handoff recorded done before checking the live body"
}

case_live_body_matching_passes() {
  live_fixture live-matching
  live_seam
  [ "$RC" -eq 0 ] && seam_output_has 'PR_BODY_OK' || fail "matching: exit $RC ($OUT)"
  pr_handoff
  [ "$RC" -eq 0 ] && seam_output_has 'PR_BODY_OK' || fail "edit handoff: exit $RC ($OUT)"
  grep -q '^done 123 ' "$T/finish" || fail "matching edit did not finish done"
  LIST_MODE=new
  pr_handoff
  [ "$RC" -eq 0 ] && seam_output_has 'PR_BODY_OK' || fail "create handoff: exit $RC ($OUT)"
  grep -q '^pr create ' "$GH_CALLS" || fail "create path was not exercised"
}

case_failed_body_edit_is_not_swallowed() {
  live_fixture live-edit-failed
  EDIT_RC=1
  printf 'The old PR body without a claim.\n' > "$LIVE_BODY"
  rm -f "$CTRL/rsi/state/lanes/1.pr-edit.log"
  pr_handoff; assert_live_fail
  seam_output_has 'edit failed (rc=1)' || fail "edit failure and rc are not logged ($OUT)"
  grep -q 'stub edit rejected' "$CTRL/rsi/state/lanes/1.pr-edit.log" \
    || fail "edit stderr was not saved"
  grep -q '^failed .*pr body:' "$T/finish" || fail "failed edit finished done ($OUT)"
  grep -q '^pr view ' "$GH_CALLS" || fail "failed edit skipped read-back"
}

case_unreadable_live_body_fails_closed() {
  local mode
  live_fixture live-unreadable
  for mode in error empty whitespace; do
    VIEW_MODE="$mode"; : > "$GH_CALLS"
    live_seam; assert_live_fail
    [ "$(grep -c '^pr view ' "$GH_CALLS")" -eq 2 ] \
      || fail "$mode: read-back must stop after exactly two attempts ($OUT)"
  done
}

case_code_only_diff_is_na() {
  live_fixture live-code ui/src/foo.ts
  VIEW_MODE=error
  live_seam
  [ "$RC" -eq 0 ] && seam_output_has 'PR_BODY_OK' && seam_output_has 'NA' \
    || fail "code-only: exit $RC, want OK/NA ($OUT)"
  [ ! -s "$GH_CALLS" ] || fail "code-only seam called gh"
  pr_handoff
  [ "$RC" -eq 0 ] && seam_output_has 'PR_BODY_OK' || fail "code-only handoff: exit $RC ($OUT)"
  ! grep -q '^pr view ' "$GH_CALLS" || fail "code-only handoff read the body"
}

case_live_body_read_retries_once() {
  live_fixture live-retry
  VIEW_MODE=retry
  live_seam
  [ "$RC" -eq 0 ] && seam_output_has 'PR_BODY_OK' || fail "retry: exit $RC ($OUT)"
  [ "$(grep -c '^pr view ' "$GH_CALLS")" -eq 2 ] || fail "retry: want exactly two reads"
}

case_live_body_stale_valid_claim_fails() {
  live_fixture live-stale
  printf '\nAn older but valid delivery summary.\n' >> "$LIVE_BODY"
  live_seam; assert_live_fail
  seam_output_has 'differs' || fail "stale valid body mismatch is not named ($OUT)"
}

case_live_body_timeout_fails_closed() {
  live_fixture live-timeout
  VIEW_MODE=timeout
  live_seam; assert_live_fail
  seam_output_has '124' || fail "timeout has no bounded-run verdict ($OUT)"
}

case_live_body_check_timeout_fails_closed() {
  live_fixture live-check-timeout
  HANDOFF_GIT="$T/slow-git"; HANDOFF_CHECK_SECS=1
  cat > "$HANDOFF_GIT" <<'SH'
#!/bin/bash
if [[ "$*" = *' rev-parse '* ]] && mkdir "$STUB_SLOW_GIT" 2>/dev/null; then
  sleep 20 & wait
fi
exec /usr/bin/git "$@"
SH
  chmod +x "$HANDOFF_GIT"
  pr_handoff; assert_live_fail
  seam_output_has 'no verdict' || fail "whole-check timeout did not report no verdict ($OUT)"
  ! grep -q '^done ' "$T/finish" || fail "timed-out handoff recorded done"
}

case_gh_override_is_honoured() {
  local actual
  actual="$(RSI_CTRL="$CTRL" HOME="$T/home" RSI_GH="$T/test-gh" \
    bash -c 'source "$1"; printf "%s" "$GH"' bash "$RUNTIME/common.sh")"
  [ "$actual" = "$T/test-gh" ] || fail "RSI_GH override ignored"
}

RAN=0
run() { # a case is named either case_... or its short form, x-...
  local short="${1#case_}"; short="${short//_/-}"
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || [ "$ONLY" = "$short" ] || return 0
  RAN=$((RAN + 1))
  "$1" || exit 1
  pass "$1"
}

run case_code_only_change_is_na
run case_prose_change_without_claim_check_fails
run case_empty_claim_output_fails
run case_invented_output_fails
run case_true_claim_passes
run case_waiver_passes
run case_missing_body_fails_only_for_prose
run case_unresolvable_origin_main_fails_closed
run case_worker_contract_names_the_seam
run case_lane_runs_seam_before_push
run case_check_sh_wires_the_suite
run case_clean_tree_with_built_assets_is_na
run case_live_body_missing_claim_fails
run case_live_body_matching_passes
run case_failed_body_edit_is_not_swallowed
run case_unreadable_live_body_fails_closed
run case_code_only_diff_is_na
run case_live_body_read_retries_once
run case_live_body_stale_valid_claim_fails
run case_live_body_timeout_fails_closed
run case_live_body_check_timeout_fails_closed
run case_gh_override_is_honoured
[ -z "$ONLY" ] || [ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
