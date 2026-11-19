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
# Hermetic: temp RSI_CTRL (common.sh derives STATE from it), stubbed lanes.py/volc-budget.py and
# PR state, no network, no model calls, no real gh. npm/go/node/curl are booby traps: autofill must
# not need them. The claim cases use a local bare origin so the real fetch/diff finds a diff.
# Prints "ok: <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LANE="$(cd "$HERE/.." && pwd)/lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SLUG="waiver-guard"
# Written after waiver-guard, so it is the newer sendback when both exist (autofill walks the
# queue oldest first). Used to pin that a waiver `continue`s the loop instead of stopping autofill
# for every other rework.
SLUG2="waiver-two"
CASE=""; RC=0
ONLY="${RSI_TEST_ONLY:-}"

ok() { echo "ok: $1"; }
fail() { echo "FAIL $*" >&2; exit 1; }
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
  # Default PR state OPEN so the waiver cases keep reaching the claim, as they did before the
  # terminal-PR guard; each terminal case overrides it.
  STUB_PR_STATE=OPEN; STUB_PR_STATE_FAIL=0; STUB_PR_STATE_ARG_FILE=""
  if [ "${2:-}" = repo ]; then make_repo || fail "$CASE: repo setup failed"; fi
  return 0
}

make_repo() {
  git init -q -b main "$RSI_CTRL" || fail "$CASE: git init failed"
  echo one > "$RSI_CTRL/file.txt"
  git -C "$RSI_CTRL" add file.txt
  git -C "$RSI_CTRL" commit -qm init
  git init -q --bare "$T/origin-$CASE.git"
  git -C "$RSI_CTRL" remote add origin "$T/origin-$CASE.git"
  git -C "$RSI_CTRL" push -q origin main
  git -C "$RSI_CTRL" checkout -qb "rsi/$SLUG"
  echo two >> "$RSI_CTRL/file.txt"
  git -C "$RSI_CTRL" commit -qam change
  git -C "$RSI_CTRL" push -q origin "rsi/$SLUG"
  # A second, independent rework branch: only test_waiver_continues_to_next_sendback writes its
  # sendback, but every repo case may carry it harmlessly.
  git -C "$RSI_CTRL" checkout -q main
  git -C "$RSI_CTRL" checkout -q -b "rsi/$SLUG2"
  echo three > "$RSI_CTRL/other.txt"
  git -C "$RSI_CTRL" add other.txt
  git -C "$RSI_CTRL" commit -qm change-two
  git -C "$RSI_CTRL" push -q origin "rsi/$SLUG2"
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

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
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
run test_oldest_sendback_is_claimed_first
run test_missing_sendback_does_not_hide_the_queue
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
