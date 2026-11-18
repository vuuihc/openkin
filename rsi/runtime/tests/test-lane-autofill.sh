#!/bin/bash
# test-lane-autofill.sh — a size-only sendback whose cap was waived must not open a rework lane.
#
# merge.sh bounces a PR for size alone with `source: hold-size`. The CEO can then grant a waiver
# (`state/merge/<slug>.size-ok`) because the diff is signed and must not be trimmed. `merge.sh`
# honours it, but lane.sh autofill used to claim the sendback anyway: the lane then spent its
# round cutting real content to fit a cap that no longer exists (2026-11-18: #296's rework deleted
# 879 lines of a signed story before it was killed; #299 was waived before a lane claimed it).
# The guard skips exactly that pair — `source: hold-size` plus a standing `.size-ok` — and says
# why in one line. Every other sendback source must still reach a lane.
#
# Hermetic: temp RSI_CTRL (common.sh derives STATE from it), stubbed lanes.py/volc-budget.py,
# no network, no model calls. npm/go/node/curl are booby traps: autofill must not need them.
# The non-waived cases use a local bare origin so the real fetch/diff finds a diff; the waived
# case must never get that far.
# Prints "ok: <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LANE="$(cd "$HERE/.." && pwd)/lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SLUG="waiver-guard"
# Sorts after waiver-guard in the sendback glob, so a waiver for SLUG is seen first. Used to pin
# that a waiver `continue`s the loop instead of stopping autofill for every other rework.
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
  run_autofill
  [ "$RC" -eq 0 ] || fail "hold_size_waiver: autofill exited $RC ($(out))"
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
# been burned by). One claimed slug, and it must be the unwaived one.
test_waiver_continues_to_next_sendback() {
  new_case waiver_then_next repo
  write_sb hold-size                      # first in glob order
  : > "$(st)/merge/$SLUG.size-ok"
  write_sb_for "$SLUG2" 'gate+review'     # sorts after $SLUG, no waiver
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
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
