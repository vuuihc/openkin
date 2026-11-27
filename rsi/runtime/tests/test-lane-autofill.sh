#!/bin/bash
# test-lane-autofill.sh — autofill must not open a rework lane for a PR that no longer exists.
#
# Two guards share this suite, both about sending a lane after work that does not need one:
#
# 1. A size-only sendback whose cap was waived must not open a rework lane. merge.sh bounces a PR
#    for size alone with `source: hold-size`. The CEO can then grant a waiver
#    (`state/merge/<slug>.size-ok`) because the diff is signed and must not be trimmed. merge.sh
#    honours it, but lane.sh autofill used to claim the sendback anyway: the lane then spent its
#    round cutting real content to fit a cap that no longer exists (2026-11-18: #296's rework
#    deleted 879 lines of a signed story before it was killed; #299 was waived before a lane
#    claimed it). The guard skips exactly that pair — `source: hold-size` plus a standing
#    `.size-ok` — and says why in one line. Every other sendback source must still reach a lane.
#
# 2. A sendback for a squash-merged (or closed) PR must be archived, not reworked. The branch
#    commits are not in main after a squash merge, so the fetch/diff sees a diff and autofill used
#    to claim a phantom rework round for a PR that was already handled (2026-11-19, lane 3:
#    "cancelled: stale sendback (fixed at 576fa8c5)"). The PR state comes through RSI_PR_STATE_CMD;
#    MERGED/CLOSED archive the file under sendback/done/ and continue, OPEN keeps today's path,
#    and an unreadable state fails open with one log line (a gh outage must not stall real rework).
#
# 3. Autofill walks the sendback queue oldest first. The glob sorted by name, and one idle slot is
#    filled per pass, so a newer rework whose slug sorted earlier took every free lane: 2026-11-19
#    `panel-topmost` (18:32) was claimed at 18:44 while `stale-console` (15:21) had waited 3 hours.
#    Age order keeps every rework inside the 3-attempt circuit breaker; the loop still continues
#    past a skipped sendback so the same pass can reach the newer one.
#
# 4. A sendback whose fix is already on a newer head must not open a rework lane. A rework that
#    pushed and died before the merge lane archived the sendback (or a person pushing the fix by
#    hand) leaves a branch head newer than the sendback; claiming it re-edits work that is already
#    done and burns the loop's scarcest slot (2026-11-23 12:23: a sendback written 12:05 opened a
#    lane although 1bd56a7d was already pushed; the CEO stopped it at 49 s). This is merge.sh's own
#    rule (merge.sh:93-101) on the autofill side: archive the sendback, say which head superseded
#    it, and `continue` so the pass still reaches the next one. Every unreadable input fails open
#    (a git outage must not stall a real rework) and a tie is not stale (%ct is whole seconds).
#
# Hermetic: temp RSI_CTRL (common.sh derives STATE from it), stubbed lanes.py/volc-budget.py and
# PR state, no network, no model calls, no real gh. npm/go/node/curl are booby traps: autofill must
# not need them. The claim cases use a local bare origin so the real fetch/diff finds a diff.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LANE="$(cd "$HERE/.." && pwd)/lane.sh"
RUN="$(cd "$HERE/.." && pwd)/run.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SLUG="waiver-guard"
# Written after waiver-guard, so it is the newer sendback when both exist (autofill walks the
# queue oldest first). Used to pin that a waiver `continue`s the loop instead of stopping autofill
# for every other rework.
SLUG2="waiver-two"
CASE=""; RC=0
ONLY="${RSI_TEST_ONLY:-}"
# The running case's name, so a red run names the test on its FAIL line: the lane's red-first
# seam requires the claimed test's name to appear on a line that itself marks a failure.
TEST_NAME=""

ok() { echo "PASS $1"; }
fail() { echo "FAIL ${TEST_NAME:+$TEST_NAME: }$*" >&2; exit 1; }
st() { echo "$RSI_CTRL/rsi/state"; }
claim_log() { echo "$T/claim-$CASE.log"; }
out() { tr '\n' ' ' < "$T/$CASE.out"; }

# Booby traps: autofill is loop plumbing, it must run without package managers, Go, Node or curl.
npm() { exit 97; }; go() { exit 97; }; node() { exit 97; }; curl() { exit 97; }
export -f npm go node curl

# RSI_PR_STATE_CMD replaces the `gh pr view rsi/<slug> --json state` lookup. STUB_PR_STATE is
# what it prints (default OPEN, set per case); STUB_PR_STATE_FAIL=1 exits non-zero before
# printing, the gh-failure shape; STUB_PR_STATE_ARG_FILE records the slug the seam receives.
cat > "$T/pr-state-stub.sh" <<'SH'
#!/bin/bash
set -u
[ -n "${STUB_PR_STATE_ARG_FILE:-}" ] && printf '%s' "${1:-UNSET}" > "$STUB_PR_STATE_ARG_FILE"
[ "${STUB_PR_STATE_FAIL:-0}" = 1 ] && exit 1
[ -n "${STUB_PR_STATE:-}" ] || exit 0
printf '%s\n' "$STUB_PR_STATE"
SH
# The ambient shell exports a real commit identity; these temp repos stay placeholders.
export GIT_AUTHOR_NAME="waiver guard test" GIT_AUTHOR_EMAIL=owner@example.com
export GIT_COMMITTER_NAME="waiver guard test" GIT_COMMITTER_EMAIL=owner@example.com

# new_case <name> [repo] — fresh control tree. `repo` adds a real main + rsi/<slug> branch on a
# local bare origin (no network), needed only by cases that must pass the fetch/diff and claim.
new_case() {
  CASE="$1"; RSI_CTRL="$T/ctrl-$CASE"
  rm -rf "$RSI_CTRL"
  mkdir -p "$(st)/sendback" "$(st)/merge" "$RSI_CTRL/rsi/runtime"
  printf '{"slices": []}\n' > "$RSI_CTRL/rsi/astryx-slices.json"
  # lanes.py stub: no active slugs, lane 1 idle, claim records its argv and fails. The non-zero
  # claim makes `claim ... && launch ...` short-circuit, so no worker process is ever spawned.
  cat > "$RSI_CTRL/rsi/runtime/lanes.py" <<'PY'
import os, sys
args = sys.argv[1:]
if args[:1] == ["slugs"]:
    sys.exit(0)
if args[:1] == ["idle"]:
    print("1"); sys.exit(0)
if args[:1] == ["claim"]:
    with open(os.environ["CLAIM_LOG"], "a") as f:
        f.write(" ".join(args) + "\n")
    sys.exit(9)
sys.exit(0)
PY
  printf 'import sys\nsys.exit(0)\n' > "$RSI_CTRL/rsi/runtime/volc-budget.py"
  # lane.sh sources lane-pr.sh (PR creation, never reached by autofill); without it the failed
  # source prints a stderr line that lands in $CASE.out and hides autofill's own output.
  printf '#!/bin/bash\n# stub: autofill never creates a PR\n' > "$RSI_CTRL/rsi/runtime/lane-pr.sh"
  printf '#!/bin/bash\n# stub: autofill never pushes\n' > "$RSI_CTRL/rsi/runtime/lane-push.sh"
  # Default PR state OPEN so the waiver cases keep reaching the claim, as they did before the
  # terminal-PR guard; each terminal case overrides it.
  STUB_PR_STATE=OPEN; STUB_PR_STATE_FAIL=0; STUB_PR_STATE_ARG_FILE=""
  if [ "${2:-}" = repo ]; then make_repo || fail "$CASE: repo setup failed"; fi
  return 0
}

make_repo() {
  git init -q -b main "$RSI_CTRL" || fail "$CASE: git init failed"
  # Branch heads carry a fixed old committer date. Autofill's stale-head guard compares a head's
  # %ct with the sendback's mtime, and in production a sendback is written after the push it
  # reviews; every sendback here is written after this fixture, so the default shape is "live".
  # Clocks are not involved: a case that needs a newer head sets GIT_COMMITTER_DATE explicitly.
  local d="@1767225600 +0000"
  echo one > "$RSI_CTRL/file.txt"
  git -C "$RSI_CTRL" add file.txt
  GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git -C "$RSI_CTRL" commit -qm init
  git init -q --bare "$T/origin-$CASE.git"
  git -C "$RSI_CTRL" remote add origin "$T/origin-$CASE.git"
  git -C "$RSI_CTRL" push -q origin main
  git -C "$RSI_CTRL" checkout -qb "rsi/$SLUG"
  echo two >> "$RSI_CTRL/file.txt"
  GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git -C "$RSI_CTRL" commit -qam change
  git -C "$RSI_CTRL" push -q origin "rsi/$SLUG"
  # A second, independent rework branch: only test_waiver_continues_to_next_sendback writes its
  # sendback, but every repo case may carry it harmlessly.
  git -C "$RSI_CTRL" checkout -q main
  git -C "$RSI_CTRL" checkout -q -b "rsi/$SLUG2"
  echo three > "$RSI_CTRL/other.txt"
  git -C "$RSI_CTRL" add other.txt
  GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git -C "$RSI_CTRL" commit -qm change-two
  git -C "$RSI_CTRL" push -q origin "rsi/$SLUG2"
}

# push_newer_head <slug> — commit on rsi/<slug> with a %ct strictly after the sendback's mtime and
# push it, so autofill sees a head that already carries the fix.
push_newer_head() {
  local slug="$1" sb_ct
  sb_ct="$(python3 -c 'import os,sys;print(int(os.stat(sys.argv[1]).st_mtime))' "$(st)/sendback/$slug.md")"
  git -C "$RSI_CTRL" checkout -q "rsi/$slug"
  echo "fix for $slug" >> "$RSI_CTRL/file.txt"
  git -C "$RSI_CTRL" add file.txt
  GIT_AUTHOR_DATE="@$((sb_ct + 5)) +0000" GIT_COMMITTER_DATE="@$((sb_ct + 5)) +0000" \
    git -C "$RSI_CTRL" commit -qm "already-fixed: $slug"
  git -C "$RSI_CTRL" push -q origin "rsi/$slug"
  git -C "$RSI_CTRL" rev-parse "rsi/$slug"
}

write_sb() { write_sb_for "$SLUG" "$1"; }

write_sb_for() { # slug source
  {
    echo "item: R-$1"; echo "attempt: 1"; echo "kind: targeted"
    echo "source: $2"; echo "spec: -"; echo "cmd: -"
    echo "# Sent back by the merge lane: diff is 1201 changed lines (>1000): split it"
  } > "$(st)/sendback/$1.md"
}

run_autofill() {
  CLAIM_LOG="$(claim_log)" RSI_CTRL="$RSI_CTRL" \
    RSI_PR_STATE_CMD="bash $T/pr-state-stub.sh \"\$1\"" \
    STUB_PR_STATE="$STUB_PR_STATE" STUB_PR_STATE_FAIL="$STUB_PR_STATE_FAIL" \
    STUB_PR_STATE_ARG_FILE="$STUB_PR_STATE_ARG_FILE" \
    bash "$LANE" autofill > "$T/$CASE.out" 2>&1
  RC=$?
}

# --- cases -------------------------------------------------------------------------------------

# The motivating case: the waiver stands, so the cap is gone and the rework lane must not open.
# The echo names the file so the pulse log explains the idle slot.
test_hold_size_waiver_skips_rework() {
  # repo: before the guard this case reached the diff and claimed a lane, which is the incident
  # the guard prevents — the red run must fail on the claim, not on a missing diff.
  new_case hold_size_waiver repo
  write_sb hold-size
  : > "$(st)/merge/$SLUG.size-ok"
  # The waiver skip is free and comes first: a waived sendback must not pay for a PR lookup.
  STUB_PR_STATE_ARG_FILE="$T/$CASE.arg"
  run_autofill
  [ "$RC" -eq 0 ] || fail "hold_size_waiver: autofill exited $RC ($(out))"
  [ ! -e "$T/$CASE.arg" ] \
    || fail "hold_size_waiver: looked up the PR state for a waived sendback"
  [ ! -e "$(claim_log)" ] \
    || fail "hold_size_waiver: claimed a lane despite the waiver: $(cat "$(claim_log)")"
  grep -q "hold-size waived" "$T/$CASE.out" \
    || fail "hold_size_waiver: no waiver line ($(out))"
  grep -q "$SLUG" "$T/$CASE.out" \
    || fail "hold_size_waiver: the waiver line does not name the slug ($(out))"
  grep -q "merge/$SLUG.size-ok" "$T/$CASE.out" \
    || fail "hold_size_waiver: the waiver line does not name the waiver file ($(out))"
}

# The skip must be `continue`, not `break`/`exit`: a waived sendback seen first must not stop the
# pulse from filling every other pending rework (a silent stall — the incident class this loop has
# been burned by). One claimed slug, and it must be the unwaived one. The waived file is also the
# older one, so age order alone would reach it first too; the waiver's continue is what is pinned.
test_waiver_continues_to_next_sendback() {
  new_case waiver_then_next repo
  write_sb hold-size                      # older: written first
  : > "$(st)/merge/$SLUG.size-ok"
  write_sb_for "$SLUG2" 'gate+review'     # newer, no waiver
  run_autofill
  [ "$RC" -eq 0 ] || fail "waiver_then_next: autofill exited $RC ($(out))"
  [ "$(grep -c . "$(claim_log)" 2>/dev/null || true)" = 1 ] \
    || fail "waiver_then_next: expected exactly one claim, got: $(cat "$(claim_log)" 2>/dev/null)"
  grep -q -- "--slug $SLUG2 " "$(claim_log)" \
    || fail "waiver_then_next: the waived sendback stopped the loop before $SLUG2 ($(out))"
  ! grep -q -- "--slug $SLUG " "$(claim_log)" \
    || fail "waiver_then_next: claimed the waived slug: $(cat "$(claim_log)")"
}

# No waiver, same sendback: the size cap still stands and a rework lane must be claimed.
test_hold_size_without_waiver_reaches_claim() {
  new_case hold_size_no_waiver repo
  write_sb hold-size
  run_autofill
  [ -s "$(claim_log)" ] || fail "hold_size_no_waiver: no claim for an unwaived hold-size ($(out))"
  [ "$(grep -c . "$(claim_log)")" = 1 ] \
    || fail "hold_size_no_waiver: expected one claim, got: $(cat "$(claim_log)")"
  grep -q -- "--slug $SLUG" "$(claim_log)" \
    || fail "hold_size_no_waiver: claim lacks --slug $SLUG: $(cat "$(claim_log)")"
  grep -q -- "--mode rework" "$(claim_log)" \
    || fail "hold_size_no_waiver: claim is not a rework: $(cat "$(claim_log)")"
  ! grep -q "hold-size waived" "$T/$CASE.out" \
    || fail "hold_size_no_waiver: skipped an unwaived sendback ($(out))"
}

# A waiver answers the size cap only. A gate+review sendback must still open its lane.
test_waiver_does_not_skip_other_sources() {
  new_case gate_review_waiver repo
  write_sb 'gate+review'
  : > "$(st)/merge/$SLUG.size-ok"
  run_autofill
  [ -s "$(claim_log)" ] \
    || fail "gate_review_waiver: a waiver silenced a gate+review sendback ($(out))"
  grep -q -- "--slug $SLUG" "$(claim_log)" \
    || fail "gate_review_waiver: claim lacks --slug $SLUG: $(cat "$(claim_log)")"
  grep -q -- "--mode rework" "$(claim_log)" \
    || fail "gate_review_waiver: claim is not a rework: $(cat "$(claim_log)")"
}

# A waiver for a different slug is not this slug's waiver.
test_waiver_is_per_slug() {
  new_case waiver_other_slug repo
  write_sb hold-size
  : > "$(st)/merge/another-pr.size-ok"
  run_autofill
  [ -s "$(claim_log)" ] \
    || fail "waiver_other_slug: another slug's waiver skipped $SLUG ($(out))"
}

# Nothing to do: an empty sendback directory is silent and successful.
test_no_sendback_no_output() {
  new_case no_sendback
  run_autofill
  [ "$RC" -eq 0 ] || fail "no_sendback: autofill exited $RC ($(out))"
  if grep -qiE 'waiv|hold-size' "$T/$CASE.out"; then
    fail "no_sendback: output mentions a waiver with no sendback ($(out))"
  fi
}

# --- terminal-PR cases -------------------------------------------------------------------------
# A squash merge keeps the branch commits out of main, so the fetch/diff below still finds a diff
# after the PR landed. Without the state check autofill claimed a rework lane for the merged PR and
# the worker spent a round on work already on main (2026-11-19, lane 3: "cancelled: stale
# sendback"). Terminal state archives the sendback; OPEN keeps today's path; anything unreadable
# fails open so a gh outage cannot stall a real rework.

# The motivating case: MERGED -> no claim, the file moves to done/, one line says why.
test_merged_pr_sendback_is_archived() {
  new_case merged_pr_archived repo
  write_sb 'gate+review'
  cp "$(st)/sendback/$SLUG.md" "$T/$CASE.before"
  STUB_PR_STATE=MERGED
  run_autofill
  [ "$RC" -eq 0 ] || fail "merged_pr_archived: autofill exited $RC ($(out))"
  [ ! -e "$(claim_log)" ] \
    || fail "merged_pr_archived: claimed a lane for a merged PR: $(cat "$(claim_log)")"
  [ ! -e "$(st)/sendback/$SLUG.md" ] || fail "merged_pr_archived: the sendback is still in the queue"
  local done_f; done_f="$(ls "$(st)/sendback/done/$SLUG-merged-"*.md 2>/dev/null | head -1)"
  [ -n "$done_f" ] || fail "merged_pr_archived: no sendback/done/$SLUG-merged-*.md"
  cmp -s "$T/$CASE.before" "$done_f" \
    || fail "merged_pr_archived: the archived copy differs from the sendback"
  [ "$(grep -c . "$T/$CASE.out")" = 1 ] \
    || fail "merged_pr_archived: expected one explanation line, got: $(out)"
  grep -q "$SLUG" "$T/$CASE.out" || fail "merged_pr_archived: the line does not name the slug ($(out))"
  grep -q "MERGED" "$T/$CASE.out" || fail "merged_pr_archived: the line does not say MERGED ($(out))"
}

# CLOSED is terminal too: nobody will push the rework the sendback asks for.
test_closed_pr_sendback_is_archived() {
  new_case closed_pr_archived repo
  write_sb 'gate+review'
  STUB_PR_STATE=CLOSED
  run_autofill
  [ "$RC" -eq 0 ] || fail "closed_pr_archived: autofill exited $RC ($(out))"
  [ ! -e "$(claim_log)" ] \
    || fail "closed_pr_archived: claimed a lane for a closed PR: $(cat "$(claim_log)")"
  [ ! -e "$(st)/sendback/$SLUG.md" ] || fail "closed_pr_archived: the sendback is still in the queue"
  ls "$(st)/sendback/done/$SLUG-merged-"*.md >/dev/null 2>&1 \
    || fail "closed_pr_archived: no sendback/done/$SLUG-merged-*.md"
  grep -q "CLOSED" "$T/$CASE.out" || fail "closed_pr_archived: the line does not say CLOSED ($(out))"
}

# OPEN is today's path, unchanged: a real rework is claimed. The lookup names the slug, so the
# stub cannot be answering for some other PR.
test_open_pr_sendback_still_claims() {
  new_case open_pr_claims repo
  write_sb 'gate+review'
  STUB_PR_STATE=OPEN
  STUB_PR_STATE_ARG_FILE="$T/$CASE.arg"
  run_autofill
  [ "$RC" -eq 0 ] || fail "open_pr_claims: autofill exited $RC ($(out))"
  [ "$(cat "$T/$CASE.arg" 2>/dev/null)" = "$SLUG" ] \
    || fail "open_pr_claims: the lookup saw '$(cat "$T/$CASE.arg" 2>/dev/null)', want $SLUG"
  [ -s "$(claim_log)" ] || fail "open_pr_claims: no claim for an open PR ($(out))"
  [ "$(grep -c . "$(claim_log)")" = 1 ] \
    || fail "open_pr_claims: expected one claim, got: $(cat "$(claim_log)")"
  grep -q -- "--slug $SLUG" "$(claim_log)" || fail "open_pr_claims: claim lacks --slug $SLUG"
  grep -q -- "--mode rework" "$(claim_log)" || fail "open_pr_claims: claim is not a rework"
  [ -s "$(st)/sendback/$SLUG.md" ] || fail "open_pr_claims: archived an open PR's sendback"
}

# A gh failure is not evidence the PR is done: fail open, log one line, rework as before.
test_unknown_pr_state_fails_open() {
  new_case unknown_state_claims repo
  write_sb 'gate+review'
  STUB_PR_STATE=MERGED STUB_PR_STATE_FAIL=1   # a failed lookup prints nothing; the MERGED would be a lie
  run_autofill
  [ "$RC" -eq 0 ] || fail "unknown_state_claims: autofill exited $RC ($(out))"
  [ -s "$(claim_log)" ] || fail "unknown_state_claims: a failed lookup stopped the rework ($(out))"
  grep -q -- "--slug $SLUG" "$(claim_log)" || fail "unknown_state_claims: claim lacks --slug $SLUG"
  [ -s "$(st)/sendback/$SLUG.md" ] \
    || fail "unknown_state_claims: archived on an unreadable PR state"
  [ "$(grep -c . "$T/$CASE.out")" = 1 ] \
    || fail "unknown_state_claims: expected one log line, got: $(out)"
  grep -qi "state" "$T/$CASE.out" \
    || fail "unknown_state_claims: the log line does not explain the fail-open ($(out))"
}

# --- stale-head cases --------------------------------------------------------------------------
# A rework that pushed its fix and died before the merge lane archived the sendback leaves a
# sendback whose fix is already on the branch. merge.sh suppresses that sendback from its side
# (merge.sh:93-101); autofill used to claim it anyway and the worker spent a round re-editing a
# paragraph that was already fixed (2026-11-23 12:23: a sendback written 12:05 opened a lane
# although 1bd56a7d was pushed; the CEO stopped it at 49 s). A newer head archives the sendback
# and `continue`s; every unreadable input fails open; a tie is not stale.

# The motivating case: head strictly newer than the sendback -> archived, no claim.
test_head_newer_than_sendback_archives_without_rework() {
  new_case stale_head_archive repo
  write_sb 'gate+review'
  cp "$(st)/sendback/$SLUG.md" "$T/$CASE.before"
  local head; head="$(push_newer_head "$SLUG")"
  run_autofill
  [ "$RC" -eq 0 ] || fail "stale_head_archive: autofill exited $RC ($(out))"
  [ ! -e "$(claim_log)" ] \
    || fail "stale_head_archive: claimed a lane for a fixed sendback: $(cat "$(claim_log)")"
  [ ! -e "$(st)/sendback/$SLUG.md" ] || fail "stale_head_archive: the sendback is still in the queue"
  local done_f; done_f="$(ls "$(st)/sendback/done/$SLUG-stale-head-"*.md 2>/dev/null | head -1)"
  [ -n "$done_f" ] || fail "stale_head_archive: no sendback/done/$SLUG-stale-head-*.md"
  cmp -s "$T/$CASE.before" "$done_f" \
    || fail "stale_head_archive: the archived copy differs from the sendback"
  [ "$(grep -c . "$T/$CASE.out")" = 1 ] \
    || fail "stale_head_archive: expected one explanation line, got: $(out)"
  grep -q "$SLUG" "$T/$CASE.out" || fail "stale_head_archive: the line does not name the slug ($(out))"
  grep -q "${head:0:8}" "$T/$CASE.out" \
    || fail "stale_head_archive: the line does not name the head ${head:0:8} ($(out))"
}

# The control: a live sendback is newer than the head and must still open its lane. Without this,
# a blanket skip would pass the case above.
test_sendback_newer_than_head_still_claims() {
  new_case sendback_newer repo
  write_sb 'gate+review'
  # Strictly newer than the pinned branch date: the sendback arrived after the push it reviews.
  touch -t 202612310000 "$(st)/sendback/$SLUG.md"
  run_autofill
  [ "$RC" -eq 0 ] || fail "sendback_newer: autofill exited $RC ($(out))"
  [ "$(grep -c . "$(claim_log)" 2>/dev/null || true)" = 1 ] \
    || fail "sendback_newer: expected one claim, got: $(cat "$(claim_log)" 2>/dev/null)"
  grep -q -- "--slug $SLUG " "$(claim_log)" || fail "sendback_newer: claim lacks --slug $SLUG"
  grep -q -- "--mode rework" "$(claim_log)" || fail "sendback_newer: claim is not a rework"
  [ -s "$(st)/sendback/$SLUG.md" ] || fail "sendback_newer: archived a live sendback"
  ! ls "$(st)/sendback/done/" 2>/dev/null | grep -q "stale-head" \
    || fail "sendback_newer: wrote a stale-head archive for a live sendback"
}

# An unreadable head is not evidence the fix landed: fail open, claim as today, archive nothing.
# Phase one is a git that cannot answer `log --format=%ct` while the ref, fetch and diff still
# work (a partial/corrupt object, a git that died); phase two is a missing origin/<branch>.
test_unreadable_head_claims_as_before() {
  new_case unreadable_head repo
  write_sb 'gate+review'
  cat > "$T/git-no-ct.sh" <<'SH'
#!/bin/bash
for a in "$@"; do [ "$a" = "--format=%ct" ] && exit 128; done
exec git "$@"
SH
  chmod +x "$T/git-no-ct.sh"
  export GIT="$T/git-no-ct.sh"
  run_autofill
  unset GIT
  [ "$RC" -eq 0 ] || fail "unreadable_head: autofill exited $RC ($(out))"
  [ "$(grep -c . "$(claim_log)" 2>/dev/null || true)" = 1 ] \
    || fail "unreadable_head: an unreadable head stopped the rework: $(cat "$(claim_log)" 2>/dev/null)"
  grep -q -- "--slug $SLUG " "$(claim_log)" || fail "unreadable_head: claim lacks --slug $SLUG"
  [ -s "$(st)/sendback/$SLUG.md" ] || fail "unreadable_head: archived on an unreadable head"
  [ "$(grep -c . "$T/$CASE.out")" -le 1 ] \
    || fail "unreadable_head: expected at most one log line, got: $(out)"

  # A missing branch is unreadable too: today's path skips at the diff, and the guard must not
  # have archived the sendback on its way there.
  new_case unreadable_head_missing_ref repo
  write_sb 'gate+review'
  git -C "$T/origin-$CASE.git" update-ref -d "refs/heads/rsi/$SLUG"
  git -C "$RSI_CTRL" update-ref -d "refs/remotes/origin/rsi/$SLUG"
  run_autofill
  [ "$RC" -eq 0 ] || fail "unreadable_head_missing_ref: autofill exited $RC ($(out))"
  [ ! -e "$(claim_log)" ] \
    || fail "unreadable_head_missing_ref: claimed with no branch to review: $(cat "$(claim_log)")"
  [ -s "$(st)/sendback/$SLUG.md" ] \
    || fail "unreadable_head_missing_ref: archived a sendback with no readable head"
  ! ls "$(st)/sendback/done/" 2>/dev/null | grep -q "stale-head" \
    || fail "unreadable_head_missing_ref: wrote a stale-head archive"
}

# The skip must be `continue`, not `break`: a stale sendback seen first must not stop the pass
# from claiming the next, live rework (the stall class this suite already pins for waivers).
test_stale_head_continue_reaches_next_sendback() {
  new_case stale_then_next repo
  write_sb_for "$SLUG" 'gate+review'      # older: seen first
  push_newer_head "$SLUG" >/dev/null
  write_sb_for "$SLUG2" 'gate+review'     # newer: no fix on its branch
  run_autofill
  [ "$RC" -eq 0 ] || fail "stale_then_next: autofill exited $RC ($(out))"
  [ "$(grep -c . "$(claim_log)" 2>/dev/null || true)" = 1 ] \
    || fail "stale_then_next: expected one claim, got: $(cat "$(claim_log)" 2>/dev/null)"
  grep -q -- "--slug $SLUG2 " "$(claim_log)" \
    || fail "stale_then_next: the stale sendback stopped the pass before $SLUG2 ($(out))"
  ! grep -q -- "--slug $SLUG " "$(claim_log)" \
    || fail "stale_then_next: claimed the stale slug: $(cat "$(claim_log)")"
  [ ! -e "$(st)/sendback/$SLUG.md" ] || fail "stale_then_next: the stale sendback is still queued"
}

# Autofill fills one idle slot per pass, so the order it walks the queue decides which rework gets
# the slot. The glob sorted by name, not age: on 2026-11-19 the newer `panel-topmost` (sorts first)
# was claimed at 18:44 while the older `stale-console` had waited since 15:21. Oldest first, and the
# newer one is still reached in the same pass (a skip must not become a stop).
test_oldest_sendback_is_claimed_first() {
  new_case oldest_first repo
  write_sb_for "$SLUG" 'gate+review'      # alphabetically first, but newer
  write_sb_for "$SLUG2" 'gate+review'     # alphabetically last, and older
  touch -t 202611190200 "$(st)/sendback/$SLUG.md"
  touch -t 202611181400 "$(st)/sendback/$SLUG2.md"
  run_autofill
  [ "$RC" -eq 0 ] || fail "oldest_first: autofill exited $RC ($(out))"
  [ -s "$(claim_log)" ] || fail "oldest_first: no claim for two open reworks ($(out))"
  first="$(head -1 "$(claim_log)")"
  case "$first" in
    *"--slug $SLUG2 "*) ;;
    *) fail "oldest_first: claimed the newer rework first: $(cat "$(claim_log)")" ;;
  esac
  grep -q -- "--slug $SLUG " "$(claim_log)" \
    || fail "oldest_first: the older rework stopped the pass before $SLUG: $(cat "$(claim_log)")"
}

# merge.sh archives a sendback into sendback/done/ the moment its PR lands, concurrently with the
# autofill scan. A file that disappears between the glob and its stat used to raise
# FileNotFoundError: python exited non-zero, the `done < <(sendbacks_by_age)` process substitution
# yielded nothing, and the pass claimed no rework at all — every queued sendback lost a pulse, not
# just the vanished one. The ordering must drop the missing file and print the survivors, oldest
# first, exit 0. Deterministic: one listed path exists, one never did; no sleep, no timed race.
# Seam: `lane.sh _sendback-order` reads one path per line on stdin, and sendbacks_by_age pipes the
# production glob into that same command, so this exercises the code autofill runs.
test_missing_sendback_does_not_hide_the_queue() {
  new_case missing_sendback
  : > "$(st)/sendback/older.md"
  printf '%s\n%s\n' "$(st)/sendback/older.md" "$(st)/sendback/gone.md" \
    | RSI_CTRL="$RSI_CTRL" bash "$LANE" _sendback-order > "$T/$CASE.out"
  rc=$?
  [ "$rc" -eq 0 ] || fail "missing_sendback: ordering exited $rc ($(out))"
  [ "$(cat "$T/$CASE.out")" = "$(st)/sendback/older.md" ] \
    || fail "missing_sendback: expected only older.md, got: $(out)"
}

# --- fill_plan: the debounce must not hold back the model-free rework dispatch ------------------
#
# R-rework-dispatch (2026-11-20): a rejected PR starts a rework through `lane.sh autofill`, which
# makes no model call, but the pulse exited on the 8-minute `last_fill` debounce *before* reaching
# it. A rejection then waited for the debounce to lapse: p50 11 min, p90 31 min, 73% of every
# open-to-merge minute. run.sh now asks the pure `fill_plan <debounced> <workers>` for the ordered
# action list and executes it, so the debounce suppresses only the expensive director run and its
# `last_fill` write. The seam `run.sh --fill-plan <0|1>` calls exactly that function; the worker
# gate is resolved from the stubbed volc-budget.py, as in the pulse.

plan() { RSI_CTRL="$RSI_CTRL" bash "$RUN" --fill-plan "$1" 2> "$T/$CASE.err"; }

test_rework_dispatch_survives_the_fill_debounce() {
  new_case plan_debounced
  local o rc
  o="$(plan 1)"; rc=$?
  [ "$rc" -eq 0 ] || fail "plan_debounced: --fill-plan 1 exited $rc ($(cat "$T/$CASE.err"))"
  case "$o" in *autofill-astryx*) ;; *) fail "plan_debounced: no Astryx autofill action: '$o'";; esac
  case "$o" in *autofill-rest*) ;; *) fail "plan_debounced: no rest autofill action: '$o'";; esac
  case "$o" in *director*) fail "plan_debounced: a debounced pulse still plans the director: '$o'";; esac
}

test_director_still_debounced_within_eight_minutes() {
  new_case plan_director_allowed
  local o rc
  o="$(plan 0)"; rc=$?
  [ "$rc" -eq 0 ] || fail "plan_director_allowed: --fill-plan 0 exited $rc ($(cat "$T/$CASE.err"))"
  case "$o" in *director*) ;; *) fail "plan_director_allowed: no director outside the debounce: '$o'";; esac
}

test_autofill_runs_before_the_director() {
  new_case plan_order
  local o
  o="$(plan 0)"
  case "$o" in
    *autofill-astryx*autofill-rest*director*) ;;
    *) fail "plan_order: autofill must precede the director: '$o'";;
  esac
}

test_autofill_still_requires_worker_headroom() {
  new_case plan_no_headroom
  # --allow-workers denied; --export (read at common.sh load) still succeeds quietly.
  cat > "$RSI_CTRL/rsi/runtime/volc-budget.py" <<'PY'
import sys
sys.exit(1 if "--allow-workers" in sys.argv[1:] else 0)
PY
  local o
  o="$(plan 0)"
  case "$o" in
    *autofill*) fail "plan_no_headroom: autofill planned with the worker gate off: '$o'";;
    *director*) ;;
    *) fail "plan_no_headroom: director lost with the worker gate off: '$o'";;
  esac
  [ -z "$(plan 1)" ] \
    || fail "plan_no_headroom: a debounced, gate-off pulse planned work: '$(plan 1)'"
}

# The write itself: a debounced pulse (autofill only) and a backpressured pulse (autofill, then the
# open-PR exit) both run hermetically — lane.sh is a stub that records its argv, no model, no gh —
# and neither may touch last_fill. The positive half (director ran -> last_fill written) is the same
# unchanged `date +%s > last_fill` line, reachable only after the director branch; it is not driven
# end-to-end here because that branch launches the model run.
test_last_fill_is_written_only_when_the_director_runs() {
  new_case last_fill_debounced
  printf '## Queue\n' > "$RSI_CTRL/rsi/STATUS.md"
  : > "$RSI_CTRL/rsi/scorecard.md"
  cat > "$RSI_CTRL/rsi/runtime/lane.sh" <<SH
#!/bin/bash
printf '%s\n' "\$*" >> "$T/$CASE.autofill"
SH
  date +%s > "$(st)/last_fill"
  local before
  before="$(cat "$(st)/last_fill")"
  RSI_CTRL="$RSI_CTRL" RSI_SYNCED=1 bash "$RUN" pulse > "$T/$CASE.out" 2>&1
  local rc=$?
  [ "$rc" -eq 0 ] || fail "last_fill_debounced: pulse exited $rc ($(out))"
  grep -q "skip: fill ran <8 min ago" "$T/$CASE.out" \
    || fail "last_fill_debounced: no debounce line ($(out))"
  [ "$(cat "$T/$CASE.autofill" 2>/dev/null | paste -sd'|' -)" = "autofill astryx|autofill rest" ] \
    || fail "last_fill_debounced: autofill did not run under the debounce: '$(cat "$T/$CASE.autofill" 2>/dev/null | paste -sd'|' -)'"
  [ "$(cat "$(st)/last_fill")" = "$before" ] \
    || fail "last_fill_debounced: a debounced pulse rewrote last_fill"

  # Not debounced, no worker gate problem, but the PR queue is full: autofill runs, the backpressure
  # branch exits before any director, so last_fill must still be absent.
  new_case last_fill_backpressure
  printf '## Queue\n' > "$RSI_CTRL/rsi/STATUS.md"
  : > "$RSI_CTRL/rsi/scorecard.md"
  cat > "$RSI_CTRL/rsi/runtime/lane.sh" <<SH
#!/bin/bash
printf '%s\n' "\$*" >> "$T/$CASE.autofill"
SH
  RSI_CTRL="$RSI_CTRL" RSI_SYNCED=1 RSI_MAX_OPEN_PRS=1 RSI_OPEN_PR_COUNT=1 \
    bash "$RUN" pulse > "$T/$CASE.out" 2>&1
  rc=$?
  [ "$rc" -eq 0 ] || fail "last_fill_backpressure: pulse exited $rc ($(out))"
  grep -q "open PR backpressure" "$T/$CASE.out" \
    || fail "last_fill_backpressure: no backpressure line ($(out))"
  [ -s "$T/$CASE.autofill" ] || fail "last_fill_backpressure: autofill did not run before the exit"
  [ ! -e "$(st)/last_fill" ] \
    || fail "last_fill_backpressure: last_fill written without a director run"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
  TEST_NAME="$1"
  "$1" || exit 1
  ok "$1"
}

RAN=0
run test_hold_size_waiver_skips_rework
run test_waiver_continues_to_next_sendback
run test_hold_size_without_waiver_reaches_claim
run test_waiver_does_not_skip_other_sources
run test_waiver_is_per_slug
run test_no_sendback_no_output
run test_merged_pr_sendback_is_archived
run test_closed_pr_sendback_is_archived
run test_open_pr_sendback_still_claims
run test_unknown_pr_state_fails_open
run test_head_newer_than_sendback_archives_without_rework
run test_sendback_newer_than_head_still_claims
run test_unreadable_head_claims_as_before
run test_stale_head_continue_reaches_next_sendback
run test_oldest_sendback_is_claimed_first
run test_missing_sendback_does_not_hide_the_queue
run test_rework_dispatch_survives_the_fill_debounce
run test_director_still_debounced_within_eight_minutes
run test_autofill_runs_before_the_director
run test_autofill_still_requires_worker_headroom
run test_last_fill_is_written_only_when_the_director_runs
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
