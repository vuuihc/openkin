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
# lane.sh sources $RSI_DIR/runtime/lane-pr.sh before any seam; each seam reads its checker from
# the same deployed path, so a copy keeps the suite hermetic and proves the real rules run. The
# red-first seam sits in the same pre-push span this suite extracts, so it needs its checker too
# (a body with no Claims block is NA, which is what these claim-check cases exercise). The
# removed-literal seam sits in that span as well, and is NA on these docs-only fixtures.
printf '#!/bin/bash\n# stub: the seams never create a PR\n' > "$CTRL/rsi/runtime/lane-pr.sh"
printf '#!/bin/bash\n# stub: the seams never push\n' > "$CTRL/rsi/runtime/lane-push.sh"
cp "$REPO/rsi/runtime/claim_check.py" "$CTRL/rsi/runtime/claim_check.py" \
  || { echo "FAIL cannot copy claim_check.py" >&2; exit 1; }
cp "$REPO/rsi/runtime/red_first.py" "$CTRL/rsi/runtime/red_first.py" \
  || { echo "FAIL cannot copy red_first.py" >&2; exit 1; }
cp "$REPO/rsi/runtime/removed_literal.py" "$CTRL/rsi/runtime/removed_literal.py" \
  || { echo "FAIL cannot copy removed_literal.py" >&2; exit 1; }
# common.sh is the production environment; the retry's pause is wrapped in its `bounded_run`
# watchdog, and the clamp case needs the same watchdog around the whole hand-off so a missing
# clamp cannot hang the suite. RSI_CTRL points into the temp dir before the source, so STATE and
# RSI_DIR stay inside it (the +x restore touches only the copies).
mkdir -p "$T/home"
RSI_CTRL="$CTRL"; HOME="$T/home"; export RSI_CTRL HOME
source "$RUNTIME/common.sh"
R=""   # the worktree the current case works on
BODY=""  # the PR body the current case passes to the seam
ONLY="${RSI_TEST_ONLY:-}"
OUT=""; RC=0
CASE=""   # the case in flight, so a failure line names the test a claim can point at
ATTEMPTS="$CTRL/rsi/state/lanes/1.claim-attempts.txt"

# fixed_body <path> — the passing prose body the harness already proves: the claimed line is the
# command's real output. Written outside $BODY so a flipper can swap it in mid-hand-off.
fixed_body() {
  printf '%s\n' "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
    "2:Prose claim check: the KIN-CONTINUE-001 story is signed." > "$1"
}

# flip_body_on_attempt <body-file> <fixed-body-file> — background helper for the retry cases. The
# lane records attempt 1 before it pauses; a worker's late write lands in that pause. Polling is
# bounded (200 × 0.05 s) so a lane with no retry leaves no flipper behind for the next case.
flip_body_on_attempt() {
  local body="$1" fixed="$2" i
  for i in $(seq 1 200); do
    if [ -f "$ATTEMPTS" ]; then cp "$fixed" "$body"; return 0; fi
    sleep 0.05
  done
  return 1
}

pass() { echo "PASS $*"; }
fail() { echo "FAIL ${CASE:+$CASE: }$*" >&2; exit 1; }
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
  # must read the tree as clean (STATUS Watch 76). `.data/` is the top-level ignored shape (live
  # state, a build output dir) used to prove the merge-result carry.
  printf 'web/dist/assets/\n.data/\n' > "$R/.gitignore"
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
  grep -qF 'format-changed.sh --write --commit' <<<"$out" \
    || fail "contract: the worker contract does not tell the worker to format before writing the body"
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
  push="$(grep -nF 'git_push_retry "$GIT" "$WT" "$BR"' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$push" ] || fail "wiring: lane.sh has no git_push_retry call"
  [ "$inv" -gt "$mut" ] \
    || fail "wiring: the claim check (line $inv) does not run after mutant evidence (line $mut)"
  [ "$inv" -lt "$push" ] \
    || fail "wiring: the claim check (line $inv) runs after the push (line $push)"
  # The first claim-check failure branch: the pre-push body-identity guard is a later one, also
  # before the push, and must not stand in for the seam's own branch.
  fin="$(grep -nF 'finish failed "" "claim check:' "$LANE" | head -1 | cut -d: -f1)"
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

# claim_fail_handoff — run lane.sh's pre-push hand-off verbatim: the prose-delivery claim seam (the
# guarded --claim-check-check call plus its evidence write) and then the push + PR tail. awk lifts
# that span out of lane.sh so the case drives the production lines, not a copy. Only the variables
# the block reads before its own exit are supplied: a stubbed `finish` records the note, a stubbed
# `gh` keeps the PR path offline, and the worktree's own bare origin accepts the green re-run's
# push. Sets PH_RC (the exact status the lane's `exit 1` / `exit 0` produced).
# Named apart from the live-body pr_handoff() fixture below: both branches added a helper under
# that name, and the two drive different tails of lane.sh.
claim_fail_handoff() { # <body-file> [RSI_CLAIM_RETRY_SECS]
  local body="$1" retry="${2:-}" tail_file="$T/push-tail.sh"
  # Stop before the live-body check main added: it is driven by pr_handoff() and bounded_run,
  # neither of which belongs to the claim seam these cases assert.
  awk '/^# A prose delivery hands off only when/ { on = 1 } \
       on && /^# Only the body the merge lane will read/ { exit } on { print }' "$LANE" > "$tail_file"
  [ -s "$tail_file" ] || fail "handoff: cannot extract the claim/push tail from lane.sh"
  ! grep -q -- '--pr-body-check' "$tail_file" \
    || fail "handoff: the claim tail runs into the live-body check; adjust the extraction boundary"
  # The gh stub logs every call; the PR-create helper logs separately so a case can prove the
  # green re-read really continued the hand-off instead of stopping at the push.
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >> %q\nexit 0\n' "$T/ph-gh.calls" > "$T/gh"; chmod +x "$T/gh"
  mkdir -p "$CTRL/rsi/state/lanes" "$T/home" "$T/runs"
  # The tail pushes the lane's branch; a case that expects a push needs it checked out here.
  git -C "$R" rev-parse --verify -q refs/heads/rsi/handoff >/dev/null 2>&1 \
    || g checkout -q -b rsi/handoff || fail "handoff: cannot create the branch"
  cp "$body" "$CTRL/rsi/state/lanes/1.pr-body.md"
  : > "$T/ph-finish.log"; : > "$T/ph-gh.calls"; : > "$T/ph-pr.log"; rm -f "$ATTEMPTS"
  (
    RSI_CTRL="$CTRL"; HOME="$T/home"; export RSI_CTRL HOME
    source "$RUNTIME/common.sh"          # bounded_run: the retry pause's production watchdog; with_timeout backs the push
    source "$RUNTIME/lane-push.sh"       # git_push_retry: the tail's push, never a bare git push
    [ -n "$retry" ] && { RSI_CLAIM_RETRY_SECS="$retry"; export RSI_CLAIM_RETRY_SECS; }
    N=1
    SELF="$LANE"
    WT="$R"
    BR="rsi/handoff"
    ITEM="R-claim-fail-output"
    SLUG="handoff"
    STATE="$CTRL/rsi/state"
    RSI_DIR="$CTRL/rsi"
    RUNS="$T/runs"
    STATUS_NOTE_FILE="$STATE/lanes/1.pr-body.md"
    GIT="$(command -v git)"
    GH="$T/gh"
    GH_REPO="vuuihc/openkin"
    MODE=new; TIMEDOUT=0; W_MIN=1; COST=0; SWEPT_N=0; M_WORKER=worker
    WORKER_TITLE=""; HDR="$T/hdr"; LK="$T/lk"; PRN=""; PRURL=""
    # The span pins the hand-off to a private snapshot with the lane's own helpers; source their
    # production definitions (the function bodies have no column-0 close), never copies that could
    # drift.
    eval "$(awk '/^claim_body_sha\(\)/ { on = 1 } on { print } on && /^}/ { exit }' "$LANE")"
    eval "$(awk '/^claim_body_snapshot\(\)/ { on = 1 } on { print } on && /^}/ { exit }' "$LANE")"
    finish() { printf 'FINISH %s|%s|%s\n' "$1" "${2:-}" "${3:-}" >> "$T/ph-finish.log"; }
    count_fail() { :; }; count_ok() { :; }; count_timeout() { :; }; scorecard_row() { :; }
    gh_pr_create() { printf 'pr create %s %s\n' "$2" "$3" >> "$T/ph-pr.log"; printf 'https://github.com/%s/pull/77\n' "$GH_REPO"; }
    . "$tail_file"
    # The retry note rides into the lane's finish note; the span stops before `finish done`, so
    # the value the real record would carry is captured here.
    printf 'RETRY-NOTE %s\n' "${CLAIM_RETRY_NOTE:-}" >> "$T/ph-finish.log"
  )
  PH_RC=$?
  return "$PH_RC"
}

# R-claim-fail-output: a red claim verdict used to survive only as a flattened one-line note, so
# the reader could not tell a genuine red from a slow or truncated run. The lane must keep the
# verdict plus the command's own tail — including its exit code — on disk, next to the other lane
# artefacts, exactly as merge.sh already does for its claim gate.
case_claim_fail_keeps_real_output() {
  local claim="$CTRL/rsi/state/lanes/1.claim.txt"
  new_repo claimfail
  change docs/plans/gap-log.md '- a sentence the claim cannot prove'
  body "Claim check: printf 'REAL-OUTPUT-42\n'" \
       "Claim output:" \
       "a line the command never prints"
  rm -f "$claim"
  claim_fail_handoff "$BODY"
  [ "$PH_RC" -eq 1 ] || fail "claimfail: claim_fail_handoff exit $PH_RC, want 1"
  [ -f "$claim" ] || fail "claimfail: $claim was not written"
  grep -qF "claimed output is not in the command's real output" "$claim" \
    || fail "claimfail: the verdict is not in the evidence: $(cat "$claim")"
  grep -qF 'REAL-OUTPUT-42' "$claim" \
    || fail "claimfail: the command's real output is not in the evidence: $(cat "$claim")"
  grep -qF 'exit 0' "$claim" \
    || fail "claimfail: the command's exit code is not in the evidence: $(cat "$claim")"
  grep -qF "$claim" "$T/ph-finish.log" \
    || fail "claimfail: the failure note does not point at the evidence: $(cat "$T/ph-finish.log")"
}

# The evidence is the bounded tail (tail(actual)), never a dump: a command that floods output must
# still leave a small, readable file.
case_claim_fail_real_output_is_bounded() {
  local claim="$CTRL/rsi/state/lanes/1.claim.txt" size
  new_repo bounded
  change docs/plans/gap-log.md '- a command with a long output'
  body "Claim check: seq 1 5000" "Claim output:" "999999"
  rm -f "$claim"
  claim_fail_handoff "$BODY"
  [ "$PH_RC" -eq 1 ] || fail "bounded: claim_fail_handoff exit $PH_RC, want 1"
  [ -f "$claim" ] || fail "bounded: $claim was not written"
  size="$(wc -c < "$claim")"
  [ "$size" -lt 16384 ] || fail "bounded: evidence is $size bytes, want < 16384"
  grep -qF '5000' "$claim" || fail "bounded: the tail of the real output is missing"
}

# A green hand-off for the same lane must not rewrite or delete the first run's evidence: the red
# is the durable record a person reads after the fact.
case_claim_fail_evidence_keeps_the_first_run() {
  local claim="$CTRL/rsi/state/lanes/1.claim.txt"
  new_repo evidence
  change docs/plans/gap-log.md '- one sentence'
  g checkout -q -b rsi/handoff || fail "evidence: cannot create the branch"
  body "Claim check: printf 'REAL-OUTPUT-42\n'" "Claim output:" "never printed"
  rm -f "$claim"
  claim_fail_handoff "$BODY"
  [ "$PH_RC" -eq 1 ] || fail "evidence: first run exit $PH_RC, want 1"
  [ -f "$claim" ] || fail "evidence: the first run wrote no evidence"
  cp "$claim" "$T/claim.first"
  body "Claim check: printf 'REAL-OUTPUT-42\n'" "Claim output:" "REAL-OUTPUT-42"
  claim_fail_handoff "$BODY"
  [ "$PH_RC" -eq 0 ] || fail "evidence: green re-run exit $PH_RC, want 0 ($(cat "$T/ph-finish.log"))"
  cmp -s "$T/claim.first" "$claim" \
    || fail "evidence: the green run rewrote or deleted the first run's evidence"
}

# A prose diff with no column-0 `Claim check:` line must stop the hand-off in the lane's own
# pre-push span, not only in the bare seam: the branch stays unpushed, no PR is opened, and the
# evidence names the missing line. This is the shape that reached the merge gate 18 times in the
# 11-20 → 11-27 window (sendback/done: gap-log-close-20261121, phone-list-deliver, lessons-*).
case_prose_diff_without_claim_line_never_leaves_the_lane() {
  local claim="$CTRL/rsi/state/lanes/1.claim.txt"
  new_repo noline
  change docs/product/IA.md '- a surface sentence the body never claims'
  body "A delivery summary with no claim line." ""
  rm -f "$claim" "$T/ph-finish.log"
  claim_fail_handoff "$BODY"
  [ "$PH_RC" -eq 1 ] || fail "noline: hand-off exit $PH_RC, want 1 ($(cat "$T/ph-finish.log"))"
  ! git -C "$T/noline.git" rev-parse --verify -q refs/heads/rsi/handoff >/dev/null \
    || fail "noline: a prose diff with no claim line was pushed"
  [ -f "$claim" ] || fail "noline: no claim evidence at $claim"
  grep -qF "no 'Claim check:' line at column 0" "$claim" \
    || fail "noline: the evidence does not name the missing line: $(cat "$claim")"
  grep -q '^FINISH failed|.*claim check:' "$T/ph-finish.log" || fail "noline: the lane did not record failed"
  [ ! -s "$T/ph-pr.log" ] || fail "noline: a PR was opened for a body with no claim line"
}

# The lane checks one file and uploads that same file: the hand-off snapshots the worker's body
# before the claim seam and never reopens the original. A write to the snapshot after that read (a
# stray generator, a truncated copy, the claim command itself) must fail closed before the push
# instead of publishing bytes the rule never saw.
case_lane_checks_the_body_it_uploads() {
  local body_file="$CTRL/rsi/state/lanes/1.pr-body.snapshot.md" claim="$CTRL/rsi/state/lanes/1.claim.txt"
  new_repo uploadbytes
  change docs/plans/gap-log.md '- a sentence the claim can prove'
  body "Claim check: printf 'REAL-OUTPUT-42\\n'; printf 'late edit\\n' >> '$body_file'" \
       "Claim output:" "REAL-OUTPUT-42"
  rm -f "$claim" "$T/ph-finish.log"
  claim_fail_handoff "$BODY"
  [ "$PH_RC" -eq 1 ] || fail "upload: hand-off exit $PH_RC, want 1 ($(cat "$T/ph-finish.log"))"
  ! git -C "$T/uploadbytes.git" rev-parse --verify -q refs/heads/rsi/handoff >/dev/null \
    || fail "upload: a body that changed after the seam was pushed"
  [ -f "$claim" ] || fail "upload: no claim evidence at $claim"
  grep -qF 'changed after the claim seam' "$claim" \
    || fail "upload: the evidence does not name the changed body: $(cat "$claim")"
}

# The lane seam and the merge gate are one rule: for a good body and every bad shape (missing line,
# indented line, empty output, drifted output, bare waiver) both call sites must reach the same
# verdict. A seam that passes a body the gate rejects is the round this row removes.
parity_case() { # <label> <want-rc> <body line>...
  local label="$1" want="$2" lane_rc gate_rc slug paths
  shift 2
  body "$@"
  seam; lane_rc=$RC
  mkdir -p "$CTRL/rsi/state/merge" "$CTRL/rsi/state/sendback"
  paths="$T/parity.paths"; printf '%s\n' 'docs/plans/gap-log.md' > "$paths"
  slug="parity-${label//[^a-zA-Z0-9]/-}"
  RSI_CTRL="$CTRL" RSI_PR_STATE_CMD="bash $T/pr-state-stub.sh \"\$1\"" STUB_STATE_OUT=OPEN \
    bash "$REPO/rsi/runtime/merge.sh" --claim-gate-check 461 "$slug" R-parity "$R" "$BODY" "$paths" \
    >"$T/parity.out" 2>&1
  gate_rc=$?
  [ "$lane_rc" -eq "$want" ] || fail "parity/$label: lane seam exit $lane_rc, want $want ($OUT)"
  [ "$gate_rc" -eq "$want" ] \
    || fail "parity/$label: merge gate exit $gate_rc, want $want ($(cat "$T/parity.out"))"
}

case_lane_seam_and_merge_gate_agree() {
  new_repo parity
  change docs/plans/gap-log.md '- a sentence the claim proves'
  printf '#!/bin/bash\nprintf "%%s\\n" "${STUB_STATE_OUT:-OPEN}"\n' > "$T/pr-state-stub.sh"
  chmod +x "$T/pr-state-stub.sh"
  parity_case good 0 \
    "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
    "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  parity_case missing-line 1 "A delivery summary with no claim line." ""
  parity_case indented-line 1 \
    "  Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
    "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  parity_case empty-output 1 "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:"
  parity_case drifted-output 1 \
    "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
    "99:Prose claim check: a line the command never printed"
  parity_case bare-waiver 1 "Claim check: none" "Claim output:" "-"
}

# A claim is proven on the tree the merge gate reads: the PR merged with origin/main. merge.sh's
# sync_main merges main into the branch before its claim gate, so a claim that is true on the
# branch tip can be false after that sync. Measured 2026-11-27: 12 `mech-claim` rounds of this
# shape (rn-design-pass #812: lane CLAIM_LANE_OK + PR_BODY_OK at 14:08 and 14:26, merge gate
# `stories: 25 (approved 5, blocked 1, covered 18, draft 1)` vs `approved 4, covered 19`;
# rn-empty-hint #766: claimed `193:` vs real `194:`). The lane must catch the drift before the
# push, and a claim the merge does not move must still pass on the same tree.
case_claimed_output_must_match_the_merge_tree() {
  local base pr claim="$CTRL/rsi/state/lanes/1.claim.txt"
  new_repo mergetree
  change docs/plans/gap-log.md '- the sentence this PR delivers'
  pr="$(g rev-parse HEAD)"
  base="$(g rev-parse origin/main)"
  # origin/main advances after this branch was cut: one heading inserted above the claimed line.
  g checkout -q --detach "$base" || fail "mergetree: cannot detach at the branch point"
  { printf '# An extra heading\n'; cat "$R/NOTES.md"; } > "$T/notes.merged" && mv "$T/notes.merged" "$R/NOTES.md"
  g add NOTES.md && g commit -q -m 'main advance' || fail "mergetree: cannot advance main"
  g update-ref refs/remotes/origin/main "$(g rev-parse HEAD)"
  g checkout -q -B rsi/handoff "$pr" || fail "mergetree: cannot return to the branch"
  # The merge gate runs the claim in the lane worktree, where ignored build artifacts exist. A
  # claim reading one is legitimate and must stay green on the merge result; the merge worktree
  # carries every ignored path the lane holds. `.data/` is ignored at the top level, so no
  # untracked parent directory masks a missing carry.
  mkdir -p "$R/.data"
  printf 'IGNORED-ARTIFACT-42\n' > "$R/.data/out.txt"
  body "Claim check: cat .data/out.txt" "Claim output:" "IGNORED-ARTIFACT-42"
  seam
  [ "$RC" -eq 0 ] \
    || fail "mergetree: an ignored artifact the lane holds is missing on the merge result ($OUT)"
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  seam
  [ "$RC" -eq 1 ] || fail "mergetree: exit $RC, want 1 — the claimed line moved on the merge result ($OUT)"
  seam_output_has "not in the command's real output" \
    || fail "mergetree: the drift is not named: $OUT"
  # The same merge, a claim it does not move: the merge-result check is not a blanket red.
  body "Claim check: grep -o 'KIN-CONTINUE-001' NOTES.md" "Claim output:" "KIN-CONTINUE-001"
  seam
  [ "$RC" -eq 0 ] || fail "mergetree: a claim the merge does not move failed ($OUT)"
  # The real pre-push span must stop the drifted claim before the push, with evidence.
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  rm -f "$claim" "$T/ph-finish.log"
  claim_fail_handoff "$BODY"
  [ "$PH_RC" -eq 1 ] || fail "mergetree: hand-off exit $PH_RC, want 1"
  ! git -C "$T/mergetree.git" rev-parse --verify -q refs/heads/rsi/handoff >/dev/null \
    || fail "mergetree: a drifted claim was pushed"
  grep -qF "not in the command's real output" "$claim" 2>/dev/null \
    || fail "mergetree: the evidence does not name the drift: $(cat "$claim" 2>/dev/null)"
}

# The carry must not follow a symlink out of the merge worktree: main can commit `leak -> <external
# dir>` while the lane holds an ignored file under `leak/`, and `mkdir -p` / `ln -s` would then
# create that file's parent and the link outside the temporary worktree, writing beside the lane
# where it has no business. A path whose existing ancestors are not real directories of the merge
# worktree is skipped; the claim still runs and passes. The same main advance moves the claimed
# line, so the case is red on any seam that reads the branch tip instead of the merge result.
case_ignored_carry_cannot_escape_the_merge_worktree() {
  local out="$T/outside-symlink" base pr blob notes_blob main_commit
  new_repo symlinkcarry
  # Ignore the carried file, not its directory: `--directory` would collapse an ignored directory
  # to `leak/deep/`, whose dirname is the symlink itself, and the escape needs a path below it.
  printf 'leak/deep/out.txt\n' >> "$R/.gitignore"
  g add .gitignore && g commit -q -m 'ignore the carried path' \
    || fail "symlinkcarry: cannot commit .gitignore"
  change docs/plans/gap-log.md '- a sentence the claim proves'
  mkdir -p "$R/leak/deep" "$out"
  printf 'CARRIED-42\n' > "$R/leak/deep/out.txt"
  pr="$(g rev-parse HEAD)"
  base="$(g rev-parse origin/main)"
  # Advance main without checking it out: the worktree's `leak/` directory must stay in place for
  # the ignored listing, and a checkout through the symlink commit would not. The heading moves the
  # claimed line from 2 to 3, so the claim below is true only on the merge result.
  blob="$(printf '%s' "$out" | g hash-object -w --stdin)" \
    || fail "symlinkcarry: cannot hash the symlink target"
  notes_blob="$({ printf '# An extra heading\n'; cat "$R/NOTES.md"; } | g hash-object -w --stdin)" \
    || fail "symlinkcarry: cannot hash the advanced notes"
  main_commit="$(
    export GIT_INDEX_FILE="$T/symlinkcarry.index"
    g read-tree "$base" \
      && g update-index --add --cacheinfo "100644,$notes_blob,NOTES.md" \
      && g update-index --add --cacheinfo "120000,$blob,leak" \
      && g commit-tree "$(g write-tree)" -p "$base" -m 'main advances with a symlink'
  )" || fail "symlinkcarry: cannot advance main"
  g update-ref refs/remotes/origin/main "$main_commit"
  g checkout -q -B rsi/handoff "$pr" || fail "symlinkcarry: cannot return to the branch"
  g ls-files --others --ignored --exclude-standard --directory | grep -qx 'leak/deep/out.txt' \
    || fail "symlinkcarry: the fixture does not expose the ignored path"
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "3:Prose claim check: the KIN-CONTINUE-001 story is signed."
  seam
  [ "$RC" -eq 0 ] || fail "symlinkcarry: the seam did not read the merge result ($OUT)"
  [ -z "$(ls -A "$out")" ] \
    || fail "symlinkcarry: the carry wrote outside the merge worktree: $(ls -A "$out")"
}

# A main advance that conflicts with the branch cannot be turned into a merge tree. The seam must
# then check the branch tip — a conflict is merge.sh's verdict — instead of inventing a red the
# worker cannot fix.
case_a_conflicting_main_advance_falls_back_to_the_branch_tip() {
  local base pr
  new_repo conflictfallback
  change docs/plans/gap-log.md '- the branch sentence'
  pr="$(g rev-parse HEAD)"
  base="$(g rev-parse origin/main)"
  g checkout -q --detach "$base" || fail "conflict: cannot detach at the branch point"
  printf '# main says something else\n' >> "$R/docs/plans/gap-log.md"
  g add -A && g commit -q -m 'main advance' || fail "conflict: cannot advance main"
  g update-ref refs/remotes/origin/main "$(g rev-parse HEAD)"
  g checkout -q -B rsi/handoff "$pr" || fail "conflict: cannot return to the branch"
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  seam
  [ "$RC" -eq 0 ] || fail "conflict: exit $RC, want 0 — a conflict is merge.sh's verdict ($OUT)"
  case "$OUT" in
    "CLAIM_LANE_OK: "*"branch tip was checked"*) ;;
    *) fail "conflict: the fallback did not say which tree was checked: $OUT" ;;
  esac
}

# Source pin, the same shape as case_lane_runs_seam_before_push: the pre-push claim seam must write
# the evidence file before it calls finish failed, so deleting the write is a red.
case_claim_fail_evidence_wiring() {
  local inv claim fin
  inv="$(grep -nF 'if ! CLAIM_EV="$(bash "$SELF" --claim-check-check' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$inv" ] || fail "wiring: lane.sh has no guarded claim check"
  # The first evidence write after the check belongs to the seam's own failure branch; the
  # snapshot failure before the check writes the same file and must not stand in for it.
  claim="$(grep -nF '$STATE/lanes/$N.claim.txt' "$LANE" | cut -d: -f1 | awk -v inv="$inv" '$1 > inv { print; exit }')"
  [ -n "$claim" ] || fail "wiring: lane.sh never writes the claim evidence file"
  fin="$(grep -nF 'finish failed "" "claim check:' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$fin" ] || fail "wiring: no claim-check failure branch"
  [ "$claim" -gt "$inv" ] \
    || fail "wiring: the evidence write (line $claim) does not follow the check (line $inv)"
  [ "$claim" -lt "$fin" ] \
    || fail "wiring: the evidence write (line $claim) does not precede finish failed (line $fin)"
}

# R-claim-seam-retry: 2026-11-23, lane 1 recorded `failed` with CLAIM_LANE_FAIL (claimed
# 240/256/277 vs real 235/251/272). The body was written at 12:21:48 and the worker exited at
# 12:23:32; the lane's own format commit 786e847d (12:23:35) then rewrote AgentSessionSheet.tsx
# by net -5 lines, moving exactly those claims, so the body was stale before the seam read it at
# 12:23:36 and a re-read of the same tree could not help. The real fix is the worker contract's
# format-before-body step; the retry below is a general guard for a body rewritten between the
# seam's read and the record, proven here with a write after the first read. A genuine failure
# still fails.
case_claim_check_retry_body_fixed_mid_handoff() {
  new_repo retryfixed
  change docs/plans/gap-log.md '- a sentence the claim can prove'
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "99:Prose claim check: a line the command never printed"
  rm -f "$CTRL/rsi/state/lanes/1.claim.txt"   # a sibling case's red must not stand in for this one
  fixed_body "$T/retryfixed.fixed"
  rm -f "$ATTEMPTS"   # the flipper must see the lane's new record, never a sibling case's
  flip_body_on_attempt "$CTRL/rsi/state/lanes/1.pr-body.md" "$T/retryfixed.fixed" & local flipper=$!
  # 3 s, not the 1 s production default: the flipper polls at 50 ms but is a separate process, and
  # a descheduled flipper under the parallel gate would make attempt 2 read the old body (a false
  # red). The default pause is still covered by the still-failing case.
  claim_fail_handoff "$BODY" 3
  wait "$flipper" 2>/dev/null || true
  [ "$PH_RC" -eq 0 ] \
    || fail "retryfixed: hand-off exit $PH_RC, want 0 (the late body fix must continue the hand-off): $(cat "$T/ph-finish.log")"
  git -C "$T/retryfixed.git" rev-parse --verify -q refs/heads/rsi/handoff >/dev/null \
    || fail "retryfixed: the branch was not pushed to the bare origin"
  grep -q '^pr create ' "$T/ph-pr.log" || fail "retryfixed: the PR stub was not called"
  [ -f "$ATTEMPTS" ] || fail "retryfixed: no attempt record at $ATTEMPTS"
  [ "$(grep -c '^attempt ' "$ATTEMPTS")" -eq 2 ] \
    || fail "retryfixed: want exactly two attempts: $(cat "$ATTEMPTS")"
  grep -q '^attempt 1: CLAIM_LANE_FAIL' "$ATTEMPTS" \
    || fail "retryfixed: attempt 1 is not the first FAIL: $(cat "$ATTEMPTS")"
  grep -q '^attempt 2: CLAIM_LANE_OK' "$ATTEMPTS" \
    || fail "retryfixed: attempt 2 is not the re-read OK: $(cat "$ATTEMPTS")"
  [ ! -f "$CTRL/rsi/state/lanes/1.claim.txt" ] \
    || fail "retryfixed: a passing re-read wrote the failure record: $(cat "$CTRL/rsi/state/lanes/1.claim.txt")"
  grep -q '^RETRY-NOTE claim check passed on re-read' "$T/ph-finish.log" \
    || fail "retryfixed: the finish note does not record the re-read: $(cat "$T/ph-finish.log")"
}

# The no-regression pin: a body that is still failing after the re-read keeps today's failure
# path exactly — final verdict in .claim.txt, status failed, no push — and the retry is bounded
# to one extra read, not a loop.
case_claim_check_retry_still_failing_stays_failed() {
  local claim="$CTRL/rsi/state/lanes/1.claim.txt"
  new_repo retrystill
  change docs/plans/gap-log.md '- a sentence the claim cannot prove'
  body "Claim check: printf 'REAL-OUTPUT-42\n'" "Claim output:" "a line the command never prints"
  rm -f "$claim"
  claim_fail_handoff "$BODY"
  [ "$PH_RC" -eq 1 ] || fail "retrystill: hand-off exit $PH_RC, want 1"
  [ -f "$claim" ] || fail "retrystill: the final FAIL was not recorded in .claim.txt"
  grep -q 'CLAIM_LANE_FAIL' "$claim" || fail "retrystill: .claim.txt does not hold the FAIL"
  [ -f "$ATTEMPTS" ] || fail "retrystill: no attempt record at $ATTEMPTS"
  [ "$(grep -c '^attempt ' "$ATTEMPTS")" -eq 2 ] \
    || fail "retrystill: want exactly two attempts (a bounded retry, not a loop): $(cat "$ATTEMPTS")"
  ! git -C "$T/retrystill.git" rev-parse --verify -q refs/heads/rsi/handoff >/dev/null \
    || fail "retrystill: a still-failing body was pushed"
}

# RSI_CLAIM_RETRY_SECS=0 is the escape hatch: no pause, no second read, today's failure path.
case_claim_check_retry_zero_disables() {
  new_repo retryzero
  change docs/plans/gap-log.md '- a sentence the claim can prove'
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "99:Prose claim check: a line the command never printed"
  fixed_body "$T/retryzero.fixed"
  rm -f "$ATTEMPTS" "$CTRL/rsi/state/lanes/1.claim.txt"  # a sibling case's record must not stand in
  flip_body_on_attempt "$CTRL/rsi/state/lanes/1.pr-body.md" "$T/retryzero.fixed" & local flipper=$!
  claim_fail_handoff "$BODY" 0
  wait "$flipper" 2>/dev/null || true
  [ "$PH_RC" -eq 1 ] || fail "retryzero: hand-off exit $PH_RC, want 1 (retry disabled)"
  [ -f "$ATTEMPTS" ] || fail "retryzero: no attempt record at $ATTEMPTS"
  [ "$(grep -c '^attempt ' "$ATTEMPTS")" -eq 1 ] \
    || fail "retryzero: want exactly one seam run with the retry disabled: $(cat "$ATTEMPTS")"
  grep -qx 'retry pause: requested=0s used=0s' "$ATTEMPTS" \
    || fail "retryzero: the escape hatch did not record a zero pause: $(cat "$ATTEMPTS")"
  grep -q '^attempt 1: CLAIM_LANE_FAIL' "$ATTEMPTS" \
    || fail "retryzero: the single attempt is not the FAIL: $(cat "$ATTEMPTS")"
  [ -f "$CTRL/rsi/state/lanes/1.claim.txt" ] \
    || fail "retryzero: the disabled retry lost the failure record"
  grep -q 'CLAIM_LANE_FAIL' "$CTRL/rsi/state/lanes/1.claim.txt" \
    || fail "retryzero: .claim.txt does not hold this case's FAIL: $(cat "$CTRL/rsi/state/lanes/1.claim.txt")"
  ! git -C "$T/retryzero.git" rev-parse --verify -q refs/heads/rsi/handoff >/dev/null \
    || fail "retryzero: the disabled retry still pushed"
}

# AGENTS.md 13: the pause is bounded. RSI_CLAIM_RETRY_SECS=999 must clamp to 5 s, so the case
# still makes both attempts. The verdict is the lane's own record — requested seconds and used
# seconds — not elapsed wall time: a loaded host can honestly spend well over 20 s on the same
# hand-off, and a stopwatch would turn this green guard red for a reason that has nothing to do
# with the clamp. The 60 s bounded_run is a ceiling far above that nominal — only a hand-off it
# killed fails as a watchdog timeout — and it is never the verdict.
case_claim_check_retry_clock_is_clamped() {
  new_repo retryclamp
  change docs/plans/gap-log.md '- a sentence the claim can prove'
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "99:Prose claim check: a line the command never printed"
  fixed_body "$T/retryclamp.fixed"
  rm -f "$ATTEMPTS"
  flip_body_on_attempt "$CTRL/rsi/state/lanes/1.pr-body.md" "$T/retryclamp.fixed" & local flipper=$!
  # The hand-off writes to its own log, not the suite's stdout: with the clamp broken the inner
  # pause is the only thing bounded_run must reap, and a host without ps/pgrep leaves that child
  # holding whatever the case inherited. The verdict then stays the record's, and the log is
  # quoted on failure.
  bounded_run 60 claim_fail_handoff "$BODY" 999 > "$T/retryclamp.handoff.log" 2>&1; PH_RC=$?
  wait "$flipper" 2>/dev/null || true
  local log; log="$(cat "$T/retryclamp.handoff.log")"
  [ -f "$ATTEMPTS" ] || fail "retryclamp: no attempt record at $ATTEMPTS (hand-off exit $PH_RC): $log"
  grep -qx 'retry pause: requested=999s used=5s' "$ATTEMPTS" \
    || fail "retryclamp: the record does not prove the clamp: $(cat "$ATTEMPTS")"
  if [ "$PH_RC" -eq 124 ]; then
    fail "retryclamp: the hand-off did not finish inside the 60 s watchdog; a hung lane must still fail: $log"
  fi
  [ "$PH_RC" -eq 0 ] || fail "retryclamp: hand-off exit $PH_RC, want 0: $log"
  [ "$(grep -c '^attempt ' "$ATTEMPTS")" -eq 2 ] \
    || fail "retryclamp: the clamped retry did not make both attempts: $(cat "$ATTEMPTS")"
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
  VIEW_MODE=body; EDIT_RC=0; LIST_MODE=existing; EDIT_PUBLISHES=0; ON_LIST=""
  HANDOFF_GIT=/usr/bin/git; HANDOFF_CHECK_SECS=180
  cat > "$GH_STUB" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$STUB_CALLS"
# Opt-in: a successful create/edit publishes the bytes the lane actually handed gh (the file named
# by --body-file), so a case can prove what GitHub keeps. The default stub is the lying GitHub the
# read-back cases need: it reports success while keeping its old body.
publish_body() { # <gh args...>
  [ "${STUB_EDIT_PUBLISHES:-0}" = 1 ] || return 0
  local f="" a prev=""
  for a in "$@"; do [ "$prev" = --body-file ] && f="$a"; prev="$a"; done
  [ -n "$f" ] && cp "$f" "$STUB_BODY"
  return 0
}
case "$1 $2" in
  # STUB_ON_LIST names a file to append to while `pr list` runs: the window between the push and
  # the upload guards, so a case can rewrite the hand-off body exactly where a late worker would.
  'pr list')
    [ -z "${STUB_ON_LIST:-}" ] || printf 'rewritten after the push\n' >> "$STUB_ON_LIST"
    [ "$STUB_LIST_MODE" != existing ] || echo 123 ;;
  'pr create') publish_body "$@"; echo 'https://github.com/example/repo/pull/123' ;;
  'pr edit')
    [ "$STUB_EDIT_RC" -eq 0 ] && publish_body "$@"
    echo 'stub edit rejected' >&2; exit "$STUB_EDIT_RC" ;;
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
    printf 'CLAIM_BODY_SNAPSHOT=%q\n' "$CTRL/rsi/state/lanes/1.pr-body.snapshot.md"
    printf 'source %q\n' "$RUNTIME/lane-pr.sh"
    printf 'source %q\n' "$RUNTIME/lane-push.sh"
    cat <<'SH'
N=1; ITEM=R-fixture; SLUG=fixture; MODE=new; WORKER_TITLE='fix: fixture'
TIMEDOUT=0; W_MIN=0; COST=0; SWEPT_N=0
finish() { printf '%s\n' "$*" >> "$FINISH_FILE"; }
count_fail() { :; }; count_ok() { :; }; scorecard_row() { :; }
# The production span starts after the seams, so pin the body the way lane.sh does: one private
# snapshot the lane owns, hashed, with the worker's mutable file kept as the source a case can
# rewrite mid-upload. Source the lane's own helpers, so the upload guards are live in this fixture
# instead of seeing an unset CLAIM_BODY_SHA.
eval "$(awk '/^claim_body_sha\(\)/ { on = 1 } on { print } on && /^}/ { exit }' "$SELF")"
eval "$(awk '/^claim_body_snapshot\(\)/ { on = 1 } on { print } on && /^}/ { exit }' "$SELF")"
CLAIM_BODY_SOURCE="$STATUS_NOTE_FILE"
claim_body_snapshot "$CLAIM_BODY_SOURCE" "$CLAIM_BODY_SNAPSHOT" || exit 1
STATUS_NOTE_FILE="$CLAIM_BODY_SNAPSHOT"
CLAIM_BODY_SHA="$(claim_body_sha "$STATUS_NOTE_FILE")"
SH
    awk '/^# push \+ PR / { on = 1 } on { print } on && /^finish done / { exit }' "$LANE"
  } > "$T/handoff.sh"
  rm -f "$T/finish"
  OUT="$(RSI_CTRL="$CTRL" HOME="$T/home" RSI_GH="$GH_STUB" \
    STUB_CALLS="$GH_CALLS" STUB_BODY="$LIVE_BODY" STUB_VIEW_MODE="$VIEW_MODE" \
    STUB_EDIT_RC="$EDIT_RC" STUB_LIST_MODE="$LIST_MODE" \
    STUB_EDIT_PUBLISHES="${EDIT_PUBLISHES:-0}" \
    STUB_ON_LIST="${ON_LIST:-}" \
    STUB_SLOW_GIT="$T/slow-git-started" \
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

# The seam proves a local file; the merge lane reads GitHub. A lane whose body file is older than
# the lane header (a rework carrying an earlier round's body, a local clock skew) used to skip the
# edit, leaving an unchecked live body in place while the seam had passed — the body-it-uploads
# gap. The upload must always publish the file the seam read.
case_live_body_is_always_uploaded_from_the_checked_file() {
  live_fixture live-upload
  printf 'An older live body with no claim line.\n' > "$LIVE_BODY"
  touch -t 199901010000 "$BODY"
  EDIT_PUBLISHES=1
  pr_handoff
  [ "$RC" -eq 0 ] || fail "live upload: hand-off exit $RC, want 0 ($OUT)"
  seam_output_has 'PR_BODY_OK' || fail "live upload: no OK verdict ($OUT)"
  grep -q '^pr edit ' "$GH_CALLS" || fail "live upload: an older checked body skipped the upload"
  grep -q '^done 123 ' "$T/finish" || fail "live upload: the checked body was not published"
}

# The hand-off pins the body before the seams and uploads that private snapshot, so a source
# rewrite during the push — the window between the push and the upload — must not change what
# GitHub keeps. The published body is the bytes the seam proved, not the rewritten source, and the
# read-back still passes because it compares the live body to the same snapshot.
case_source_change_during_upload_publishes_the_snapshot() {
  live_fixture live-rewrite-edit
  ON_LIST="$BODY"   # the pr list stub runs between the push and both uploads
  EDIT_PUBLISHES=1
  pr_handoff
  [ "$RC" -eq 0 ] || fail "rewrite/edit: hand-off exit $RC, want 0 ($OUT)"
  seam_output_has 'PR_BODY_OK' || fail "rewrite/edit: no OK verdict ($OUT)"
  grep -q '^pr edit ' "$GH_CALLS" || fail "rewrite/edit: the snapshot was not uploaded"
  grep -q '^done 123 ' "$T/finish" || fail "rewrite/edit: the snapshot was not published"
  ! grep -qF 'rewritten after the push' "$LIVE_BODY" \
    || fail "rewrite/edit: the source rewrite reached GitHub: $(cat "$LIVE_BODY")"
  grep -qF "Claim check: grep -n 'Prose claim check' NOTES.md" "$LIVE_BODY" \
    || fail "rewrite/edit: the uploaded body is not the snapshot the seam proved: $(cat "$LIVE_BODY")"

  live_fixture live-rewrite-create
  LIST_MODE=new; ON_LIST="$BODY"; EDIT_PUBLISHES=1
  pr_handoff
  [ "$RC" -eq 0 ] || fail "rewrite/create: hand-off exit $RC, want 0 ($OUT)"
  seam_output_has 'PR_BODY_OK' || fail "rewrite/create: no OK verdict ($OUT)"
  grep -q '^pr create ' "$GH_CALLS" || fail "rewrite/create: the snapshot was not uploaded"
  grep -q '^done 123 ' "$T/finish" || fail "rewrite/create: the snapshot was not published"
  ! grep -qF 'rewritten after the push' "$LIVE_BODY" \
    || fail "rewrite/create: the source rewrite reached GitHub: $(cat "$LIVE_BODY")"
  grep -qF "Claim check: grep -n 'Prose claim check' NOTES.md" "$LIVE_BODY" \
    || fail "rewrite/create: the uploaded body is not the snapshot the seam proved: $(cat "$LIVE_BODY")"
}

# The upload guards still matter: the file gh is about to keep is the snapshot the seam proved, and
# a snapshot changed under the lane (a stray writer, a truncated copy) must fail closed rather than
# publish bytes the rule never saw.
case_upload_guards_refuse_a_snapshot_changed_after_the_push() {
  local claim="$CTRL/rsi/state/lanes/1.claim.txt"
  local snap="$CTRL/rsi/state/lanes/1.pr-body.snapshot.md"
  live_fixture live-snapshot-edit
  ON_LIST="$snap"   # the pr list stub runs between the push and both upload guards
  rm -f "$claim"
  pr_handoff
  [ "$RC" -eq 1 ] || fail "snapshot/edit: hand-off exit $RC, want 1 ($OUT)"
  grep -q '^failed .*hand-off body changed' "$T/finish" \
    || fail "snapshot/edit: the changed snapshot was not recorded failed ($OUT)"
  grep -qF 'live body not replaced' "$claim" 2>/dev/null \
    || fail "snapshot/edit: the evidence does not name the refused upload: $(cat "$claim" 2>/dev/null)"
  ! grep -q '^pr edit ' "$GH_CALLS" || fail "snapshot/edit: a changed snapshot was uploaded"
  ! grep -q '^done ' "$T/finish" || fail "snapshot/edit: a changed snapshot finished done"

  live_fixture live-snapshot-create
  LIST_MODE=new; ON_LIST="$snap"
  rm -f "$claim"
  pr_handoff
  [ "$RC" -eq 1 ] || fail "snapshot/create: hand-off exit $RC, want 1 ($OUT)"
  grep -q '^failed .*body uploaded differs' "$T/finish" \
    || fail "snapshot/create: the changed snapshot was not recorded failed ($OUT)"
  grep -qF 'PR not opened' "$claim" 2>/dev/null \
    || fail "snapshot/create: the evidence does not name the refused upload: $(cat "$claim" 2>/dev/null)"
  ! grep -q '^pr create ' "$GH_CALLS" || fail "snapshot/create: a changed snapshot opened a PR"
  ! grep -q '^done ' "$T/finish" || fail "snapshot/create: a changed snapshot finished done"
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

# --- producer PR: a PR opened outside a lane runs the same claim rule before it exists -----------
# Measured 2026-11-27: the nightly DREAM consolidation (#828) and a CEO docs PR (#819) reached
# `gh pr create` with no lane record; #828's body had no column-0 `Claim check:` line, so the merge
# gate sent it back after a full gate and an independent review (rework 20:35 → 20:51). The lane has
# run this rule before its push since #833; rsi/runtime/producer-pr.sh is the producer's half. These
# cases drive the CLI the producers call, with a stub gh that records every argv and publishes the
# --body-file bytes, so "no PR exists" and "these exact bytes were uploaded" are both observable.
PRODUCER="$RUNTIME/producer-pr.sh"

# producer_stub <dir> — a stub gh that logs every argv, publishes the --body-file bytes, and can
# fail its first create with the transient GitHub error #329 saw before returning a URL.
producer_stub() { # <dir>
  local dir="$1"
  rm -rf "$dir"; mkdir -p "$dir"
  PSTUB="$dir"; PCALLS="$dir/gh.calls"; PBODY="$dir/uploaded.body"; PFAIL="$dir/fail-once"
  : > "$PCALLS"; rm -f "$PBODY" "$PFAIL"
  cat > "$dir/gh" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$STUB_CALLS"
case "$1 $2" in
  'pr create')
    f=""; prev=""
    for a in "$@"; do [ "$prev" = --body-file ] && f="$a"; prev="$a"; done
    if [ -n "${STUB_FAIL_ONCE:-}" ] && [ ! -f "$STUB_FAIL_ONCE" ]; then
      : > "$STUB_FAIL_ONCE"
      echo 'Post "https://api.github.com/graphql": EOF' >&2
      exit 1
    fi
    [ -n "$f" ] && cp "$f" "$STUB_BODY"
    printf 'https://github.com/owner/repo/pull/4242\n'
    ;;
  'pr list') : ;;
  *) echo "unexpected gh command: $*" >&2; exit 1 ;;
esac
SH
  chmod +x "$dir/gh"
}

# pseam <worktree> <body-file> — run the producer CLI against the current fixture. Sets POUT
# (stdout), PERR (stderr) and PRC. The retry pause is zero so the transient-failure case is quick.
pseam() {
  PERR="$T/producer.err"; rm -f "$PERR"
  POUT="$(RSI_CTRL="$CTRL" HOME="$T/home" GH="$PSTUB/gh" STUB_CALLS="$PCALLS" \
    STUB_BODY="$PBODY" STUB_FAIL_ONCE="${PFAIL_ONCE:-}" RSI_GH_PR_RETRY_SLEEP=0 \
    bash "$PRODUCER" "$1" "$2" owner/repo main rsi/dream-2026-01-01 'dream consolidation' \
    2>"$PERR")"
  PRC=$?
}

# A false prose claim is refused before any gh call: the body the merge gate would reject never
# becomes a PR, so no rework round is spent on it.
case_a_false_prose_claim_never_opens_the_pr() {
  new_repo producer-false
  change docs/plans/gap-log.md '- a sentence the claim cannot prove'
  producer_stub "$T/producer-false-stub"
  body "Claim check: printf 'REAL-OUTPUT-42\n'" "Claim output:" "a line the command never printed"
  pseam "$R" "$BODY"
  [ "$PRC" -eq 1 ] || fail "pfalse: exit $PRC, want 1 ($POUT; $(cat "$PERR"))"
  grep -qF 'PRODUCER_PR_REFUSED: CLAIM_LANE_FAIL:' <<<"$POUT" \
    || fail "pfalse: the refusal does not name the claim FAIL: $POUT"
  [ "$(grep -c '^pr create' "$PCALLS")" -eq 0 ] \
    || fail "pfalse: a false claim still called gh pr create: $(cat "$PCALLS")"
}

# A proven claim opens the PR with the bytes the seam read: one create, one OK line.
case_a_passing_prose_claim_opens_the_pr_with_the_body_the_seam_read() {
  new_repo producer-pass
  change docs/plans/gap-log.md '- a sentence the tree supports'
  producer_stub "$T/producer-pass-stub"
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  pseam "$R" "$BODY"
  [ "$PRC" -eq 0 ] || fail "ppass: exit $PRC, want 0 ($POUT; $(cat "$PERR"))"
  [ "$POUT" = 'PRODUCER_PR_OK: https://github.com/owner/repo/pull/4242' ] \
    || fail "ppass: the producer must print exactly one OK line on stdout: $POUT"
  [ "$(grep -c '^pr create' "$PCALLS")" -eq 1 ] \
    || fail "ppass: want exactly one gh pr create: $(cat "$PCALLS")"
  cmp -s "$BODY" "$PBODY" || fail "ppass: the uploaded body is not the source body"
}

# A code-only diff is never asked for a claim check, and the NA path still creates one PR.
case_a_code_only_diff_opens_the_pr_with_no_body_read() {
  new_repo producer-code
  change ui/src/foo.ts 'export const foo = 4'
  producer_stub "$T/producer-code-stub"
  body "A code-only delivery with no claim line."
  pseam "$R" "$BODY"
  [ "$PRC" -eq 0 ] || fail "pcode: exit $PRC, want 0 ($POUT; $(cat "$PERR"))"
  grep -qF 'PRODUCER_PR_SEAM: CLAIM_LANE_NA:' "$PERR" \
    || fail "pcode: the producer did not take the NA path: $(cat "$PERR")"
  [ "$(grep -c '^pr create' "$PCALLS")" -eq 1 ] \
    || fail "pcode: want exactly one gh pr create: $(cat "$PCALLS")"
  cmp -s "$BODY" "$PBODY" || fail "pcode: the uploaded body is not the source body"
}

# The reasoned waiver is the escape hatch, and it opens the PR like any other passing verdict.
case_a_reasoned_waiver_opens_the_pr() {
  new_repo producer-waiver
  change docs/product/IA.md '- a heading rename'
  producer_stub "$T/producer-waiver-stub"
  body "Claim check: none: this PR only renames a heading; no command can prove a rename"
  pseam "$R" "$BODY"
  [ "$PRC" -eq 0 ] || fail "pwaiver: exit $PRC, want 0 ($POUT; $(cat "$PERR"))"
  grep -qF 'PRODUCER_PR_SEAM: CLAIM_LANE_WAIVED:' "$PERR" \
    || fail "pwaiver: the producer did not take the waiver path: $(cat "$PERR")"
  [ "$(grep -c '^pr create' "$PCALLS")" -eq 1 ] \
    || fail "pwaiver: want exactly one gh pr create: $(cat "$PCALLS")"
}

# The producer snapshots the body before the seam and uploads that snapshot: a rewrite during the
# seam (a stray generator, the claim command itself) must not be the body GitHub keeps.
case_a_body_rewritten_during_the_seam_is_not_the_one_uploaded() {
  local dir="$T/producer-rewrite" src="$T/producer-rewrite-source.body"
  rm -rf "$dir"; mkdir -p "$dir/runtime"
  cp "$PRODUCER" "$dir/runtime/producer-pr.sh" || fail "rewrite: cannot copy the producer"
  cp "$RUNTIME/lane-pr.sh" "$dir/runtime/lane-pr.sh" || fail "rewrite: cannot copy lane-pr.sh"
  cat > "$dir/runtime/lane.sh" <<'SH'
#!/bin/bash
printf 'CLAIM_LANE_OK: stub seam\n'
printf 'rewritten by the seam\n' > "$STUB_SOURCE_BODY"
exit 0
SH
  chmod +x "$dir/runtime/lane.sh"
  producer_stub "$T/producer-rewrite-stub"
  printf 'the body the seam read\n' > "$src"
  PERR="$T/producer.err"; rm -f "$PERR"
  POUT="$(RSI_CTRL="$CTRL" HOME="$T/home" GH="$PSTUB/gh" STUB_CALLS="$PCALLS" \
    STUB_BODY="$PBODY" STUB_SOURCE_BODY="$src" RSI_GH_PR_RETRY_SLEEP=0 \
    bash "$dir/runtime/producer-pr.sh" "$T" "$src" owner/repo main rsi/dream-x 'dream' \
    2>"$PERR")"
  PRC=$?
  [ "$PRC" -eq 0 ] || fail "rewrite: exit $PRC, want 0 ($POUT; $(cat "$PERR"))"
  grep -qxF 'rewritten by the seam' "$src" || fail "rewrite: the stub seam did not rewrite the source"
  grep -qxF 'the body the seam read' "$PBODY" \
    || fail "rewrite: the pre-seam bytes were not uploaded: $(cat "$PBODY" 2>/dev/null)"
  ! grep -qF 'rewritten by the seam' "$PBODY" 2>/dev/null \
    || fail "rewrite: a rewrite during the seam reached GitHub: $(cat "$PBODY")"
}

# #329's shape: gh reports `Post …: EOF` after GitHub may already have created the PR. The helper
# must retry, look before creating, and still report one PR.
case_a_transient_gh_create_failure_is_retried_without_duplicating() {
  new_repo producer-retry
  change docs/plans/gap-log.md '- a sentence the claim proves'
  producer_stub "$T/producer-retry-stub"
  PFAIL_ONCE="$PFAIL"
  body "Claim check: grep -n 'Prose claim check' NOTES.md" "Claim output:" \
       "2:Prose claim check: the KIN-CONTINUE-001 story is signed."
  pseam "$R" "$BODY"
  PFAIL_ONCE=""
  [ "$PRC" -eq 0 ] || fail "pretry: exit $PRC, want 0 ($POUT; $(cat "$PERR"))"
  [ "$(grep -c '^pr create' "$PCALLS")" -eq 2 ] \
    || fail "pretry: want two create attempts: $(cat "$PCALLS")"
  [ "$(grep -c '^PRODUCER_PR_OK: ' <<<"$POUT")" -eq 1 ] \
    || fail "pretry: want exactly one PRODUCER_PR_OK line: $POUT"
}

# A seam that prints a passing verdict and then dies non-zero is not a pass: the exit code is an
# independent signal, and a checker that crashed after printing must not open the PR.
case_a_nonzero_exit_is_a_refusal_even_with_an_ok_verdict() {
  local dir="$T/producer-exit" src="$T/producer-exit.body"
  rm -rf "$dir"; mkdir -p "$dir/runtime"
  cp "$PRODUCER" "$dir/runtime/producer-pr.sh" || fail "pexit: cannot copy the producer"
  cp "$RUNTIME/lane-pr.sh" "$dir/runtime/lane-pr.sh" || fail "pexit: cannot copy lane-pr.sh"
  cat > "$dir/runtime/lane.sh" <<'SH'
#!/bin/bash
printf 'CLAIM_LANE_OK: stub seam\n'
exit 1
SH
  chmod +x "$dir/runtime/lane.sh"
  producer_stub "$T/producer-exit-stub"
  printf 'the body the seam read\n' > "$src"
  PERR="$T/producer.err"; rm -f "$PERR"
  POUT="$(RSI_CTRL="$CTRL" HOME="$T/home" GH="$PSTUB/gh" STUB_CALLS="$PCALLS" \
    STUB_BODY="$PBODY" RSI_GH_PR_RETRY_SLEEP=0 \
    bash "$dir/runtime/producer-pr.sh" "$T" "$src" owner/repo main rsi/dream-x 'dream' \
    2>"$PERR")"
  PRC=$?
  [ "$PRC" -eq 1 ] || fail "pexit: exit $PRC, want 1 ($POUT; $(cat "$PERR"))"
  grep -qF 'PRODUCER_PR_REFUSED: CLAIM_LANE_OK:' <<<"$POUT" \
    || fail "pexit: the refusal does not name the OK verdict it rejected: $POUT"
  [ "$(grep -c '^pr create' "$PCALLS")" -eq 0 ] \
    || fail "pexit: a non-zero seam exit still opened a PR: $(cat "$PCALLS")"
}

# Static wiring: the in-repo producer reads its prompt, role card and README, not this test, so all
# three must name the seam. A later edit that silently drops it turns this red.
case_the_dream_producer_is_wired_to_the_seam() {
  grep -qF 'producer-pr.sh' "$REPO/rsi/runtime/prompts/dream.md" \
    || fail "wiring: rsi/runtime/prompts/dream.md does not name producer-pr.sh"
  grep -qF 'producer-pr.sh' "$REPO/rsi/roles/dream.md" \
    || fail "wiring: rsi/roles/dream.md does not name producer-pr.sh"
  grep -qF 'producer-pr.sh' "$REPO/rsi/README.md" \
    || fail "wiring: rsi/README.md does not name producer-pr.sh"
  grep -qF 'PRODUCER_PR_REFUSED' "$REPO/rsi/runtime/prompts/dream.md" \
    || fail "wiring: the dream prompt does not say a refusal means fixing the body"
}

RAN=0
run() { # a case is named either case_... or its short form, x-...
  local short="${1#case_}"; short="${short//_/-}"
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || [ "$ONLY" = "$short" ] || return 0
  RAN=$((RAN + 1))
  CASE="$1"
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
run case_claim_fail_keeps_real_output
run case_claim_fail_real_output_is_bounded
run case_claim_fail_evidence_keeps_the_first_run
run case_claim_fail_evidence_wiring
run case_prose_diff_without_claim_line_never_leaves_the_lane
run case_lane_checks_the_body_it_uploads
run case_lane_seam_and_merge_gate_agree
run case_claimed_output_must_match_the_merge_tree
run case_ignored_carry_cannot_escape_the_merge_worktree
run case_a_conflicting_main_advance_falls_back_to_the_branch_tip
run case_claim_check_retry_body_fixed_mid_handoff
run case_claim_check_retry_still_failing_stays_failed
run case_claim_check_retry_zero_disables
run case_claim_check_retry_clock_is_clamped
run case_live_body_missing_claim_fails
run case_live_body_matching_passes
run case_failed_body_edit_is_not_swallowed
run case_unreadable_live_body_fails_closed
run case_code_only_diff_is_na
run case_live_body_read_retries_once
run case_live_body_stale_valid_claim_fails
run case_live_body_is_always_uploaded_from_the_checked_file
run case_source_change_during_upload_publishes_the_snapshot
run case_upload_guards_refuse_a_snapshot_changed_after_the_push
run case_live_body_timeout_fails_closed
run case_live_body_check_timeout_fails_closed
run case_gh_override_is_honoured
run case_a_false_prose_claim_never_opens_the_pr
run case_a_passing_prose_claim_opens_the_pr_with_the_body_the_seam_read
run case_a_code_only_diff_opens_the_pr_with_no_body_read
run case_a_reasoned_waiver_opens_the_pr
run case_a_body_rewritten_during_the_seam_is_not_the_one_uploaded
run case_a_transient_gh_create_failure_is_retried_without_duplicating
run case_a_nonzero_exit_is_a_refusal_even_with_an_ok_verdict
run case_the_dream_producer_is_wired_to_the_seam
[ -z "$ONLY" ] || [ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
