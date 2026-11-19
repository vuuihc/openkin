#!/bin/bash
# test-ux-gate-grounded-red.sh — a below-3 UX axis must name its evidence, or it is not a verdict.
#
# 2026-11-19: PR #383 was sent to a rework round on `feedback=2` while the reviewer's own
# findings said "no regression observed" and never named the axis. The sendback body was the
# score line alone: a lane, an 11-minute walk and a vision review billed to an unexplained
# number. ux-gate.sh now treats a score as evidence, not a verdict: a below-3 axis must appear
# in a finding line (the machine `UX_SCORES:` line never counts), the same reviewer is asked
# once more for that evidence, and a second answer that still cannot name it is "no verdict"
# (unavailable, exit 2) — never a sendback, never a merge.
#
# Hermetic: a temp control tree (common.sh + ux-gate.sh), a throwaway repo with origin/main,
# and stubs for the walk and the reviewer. npm/go/node/gh/curl are booby traps. Prints
# "ok: <case>" per case, exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used for the red proof).
# GATE=<path> points every case at another ux-gate.sh (the red proof against origin/main).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
GATE="${GATE:-$REPO/rsi/runtime/ux-gate.sh}"
MANIFEST="$HERE/ux-gate-grounded-red.mutants.json"
SLUG="ux-grounded"; ITEM="R-ux-gate-grounded-red"; PR=386
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"

pass() { echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

npm()  { echo "booby trap: npm invoked" >&2; exit 97; }
go()   { echo "booby trap: go invoked" >&2; exit 97; }
node() { echo "booby trap: node invoked" >&2; exit 97; }
gh()   { echo "booby trap: gh invoked" >&2; exit 97; }
curl() { echo "booby trap: curl invoked" >&2; exit 97; }
export -f npm go node gh curl

# --- fixtures --------------------------------------------------------------------------------

GH_STUB="$T/bin/gh"; mkdir -p "$T/bin"
printf '#!/bin/bash\nexit 0\n' > "$GH_STUB"; chmod +x "$GH_STUB"
CTRL="$T/ctrl"; mkdir -p "$CTRL/rsi/runtime"
cp "$REPO/rsi/runtime/common.sh" "$CTRL/rsi/runtime/common.sh"
cp "$GATE" "$CTRL/rsi/runtime/ux-gate.sh"
chmod +x "$CTRL/rsi/runtime/"*.sh
printf '\nGH="%s"\n' "$GH_STUB" >> "$CTRL/rsi/runtime/common.sh"

WT="$T/wt"; mkdir -p "$WT"; printf 'seed\n' > "$WT/README"
G() { /usr/bin/git -C "$WT" -c user.email=owner@example.com -c user.name=grounded \
        -c commit.gpgsign=false "$@"; }
G init -q
G add -A; G commit -qm seed
G update-ref refs/remotes/origin/main HEAD
G checkout -q -b rsi/test
printf 'change\n' >> "$WT/README"; G add -A; G commit -qm change

# Walker stub: always green, one screenshot, one line per call in WALKS_LOG.
WALK_STUB="$T/bin/walk.sh"
cat > "$WALK_STUB" <<'SH'
#!/bin/bash
set -u
dir="$1"; printf '%s\n' "$dir" >> "$WALKS_LOG"
mkdir -p "$dir"
printf '{"hardFail":[],"screens":[]}\n' > "$dir/walk.json"
printf 'png\n' > "$dir/seed-1-1.png"
SH
chmod +x "$WALK_STUB"

# Reviewer stub: call N reads $FIX/N.txt (no fixture = a passing review). Each call is one
# line in $REVIEWS_LOG, so a case can prove whether the gate re-asked.
REVIEW_STUB="$T/bin/review.sh"
cat > "$REVIEW_STUB" <<'SH'
#!/bin/bash
set -u
printf '%s\n' "$1" >> "$REVIEWS_LOG"
n="$(wc -l < "$REVIEWS_LOG" | tr -d ' ')"
if [ -s "$FIX/$n.txt" ]; then cat "$FIX/$n.txt"; exit 0; fi
printf 'looks fine\n'
printf 'UX_SCORES: clarity=4 density=4 consistency=4 feedback=4 keyboard=4\n'
printf 'UX_VERDICT: PASS\n'
SH
chmod +x "$REVIEW_STUB"
export WALK_STUB REVIEW_STUB

new_case() {
  CASE="$1"
  ST="$T/$CASE.state"; FIX="$T/$CASE.fix"; LOG="$T/$CASE.walks.log"; RLOG="$T/$CASE.reviews.log"
  rm -rf "$ST" "$FIX" "$LOG" "$RLOG"; mkdir -p "$ST" "$FIX"
  SHOTS="$ST/shots/$SLUG/journeys"; UXD="$ST/ux/$SLUG"; BODY="$ST/merge/$SLUG.ux.txt"
  : > "$LOG"; : > "$RLOG"
}
fixture() { printf '%s\n' "$2" > "$FIX/$1.txt"; }
run_gate() {
  RSI_CTRL="$CTRL" RSI_UX_STATE="$ST" RSI_UX_COOLDOWN_MIN=0 \
  RSI_UX_WALK_CMD='bash "$WALK_STUB" "$1" "${2:-}"' RSI_UX_REVIEW_CMD='bash "$REVIEW_STUB" "$1"' \
  WALKS_LOG="$LOG" REVIEWS_LOG="$RLOG" FIX="$FIX" \
    bash "$CTRL/rsi/runtime/ux-gate.sh" "$WT" "$SLUG" "$ITEM" "$PR" deadbeef1234 reviewer \
    > "$T/$CASE.out" 2>&1
  RC=$?
}
reviews() { wc -l < "$RLOG" | tr -d ' '; }
scores_field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d[sys.argv[2]])' "$UXD/scores.json" "$1"; }
ungrounded_reason() { grep -h "without naming\|re-ask produced no review" "$UXD/unavailable.txt" 2>/dev/null; }

PASS_REVIEW='looks fine
UX_SCORES: clarity=4 density=4 consistency=4 feedback=4 keyboard=4
UX_VERDICT: PASS'

# --- cases -----------------------------------------------------------------------------------

# A grounded red is a red: the finding names the axis, one reviewer call, one sendback body.
test_grounded_red_stays_a_red() {
  new_case grounded_red
  fixture 1 'feedback: after-wait-390.png shows no wait cue at all while the turn is running
UX_SCORES: clarity=4 density=4 consistency=4 feedback=2 keyboard=4
UX_VERDICT: FAIL'
  run_gate
  [ "$RC" -eq 1 ] || fail "grounded-red: exit $RC, want 1 ($(tail -3 "$T/$CASE.out" | tr '\n' ' '))"
  [ "$(reviews)" = 1 ] || fail "grounded-red: $(reviews) reviews, want 1 (a grounded red is not re-asked)"
  grep -Fq 'axis below 3: feedback=2' "$BODY" || fail "grounded-red: the failing axis is not in the sendback body"
  grep -Fq 'feedback: after-wait-390.png' "$BODY" || fail "grounded-red: the evidence line is not preserved for the worker"
}

# The #383 shape: feedback=2, findings say everything is fine, the axis is named only on the
# machine line. Re-asked once; a second answer that names the evidence keeps the red.
test_ungrounded_red_is_reasked_once_then_grounded() {
  new_case ungrounded_then_grounded
  fixture 1 'Everything the PR changed looks right; no regression observed.
UX_SCORES: clarity=4 density=4 consistency=4 feedback=2 keyboard=4
UX_VERDICT: FAIL'
  fixture 2 'feedback: after-wait-1100.png has no visible waiting state; the dot is gone.
UX_SCORES: clarity=4 density=4 consistency=4 feedback=2 keyboard=4
UX_VERDICT: FAIL'
  run_gate
  [ "$RC" -eq 1 ] || fail "reasked-grounded: exit $RC, want 1 ($(tail -3 "$T/$CASE.out" | tr '\n' ' '))"
  [ "$(reviews)" = 2 ] || fail "reasked-grounded: $(reviews) reviews, want 2 (one re-ask)"
  grep -Fq 're-asking once' "$T/$CASE.out" || fail "reasked-grounded: the gate did not say it re-asked"
  grep -Fq 'feedback: after-wait-1100.png' "$BODY" || fail "reasked-grounded: the second answer's evidence is not billed"
  [ "$(scores_field reasked)" = "True" ] || fail "reasked-grounded: scores.json does not record the re-ask"
  if [ -e "$UXD/unavailable.txt" ]; then fail "reasked-grounded: a grounded red was recorded as unavailable"; fi
}

# Twice ungrounded: no verdict (exit 2), no sendback body, the reason says so.
test_ungrounded_twice_is_unavailable() {
  new_case ungrounded_twice
  fixture 1 'Everything the PR changed looks right; no regression observed.
UX_SCORES: clarity=4 density=4 consistency=3 feedback=2 keyboard=4
UX_VERDICT: FAIL'
  fixture 2 'Still looks fine to me.
UX_SCORES: clarity=4 density=4 consistency=3 feedback=2 keyboard=4
UX_VERDICT: FAIL'
  run_gate
  [ "$RC" -eq 2 ] || fail "ungrounded-twice: exit $RC, want 2 (no verdict, not a sendback)"
  [ "$(reviews)" = 2 ] || fail "ungrounded-twice: $(reviews) reviews, want 2"
  [ ! -s "$BODY" ] || fail "ungrounded-twice: a sendback body was written"
  ungrounded_reason | grep -Fq 'feedback' || fail "ungrounded-twice: the reason does not name the axis"
  ungrounded_reason | grep -Fq 'asked twice' || fail "ungrounded-twice: the reason does not say it was asked twice"
}

# The axis word on the machine `UX_SCORES:` line must not count as grounding (that was #383).
test_scores_line_alone_does_not_ground() {
  new_case scores_line_only
  fixture 1 'Everything looks right.
UX_SCORES: clarity=4 density=4 consistency=4 feedback=2 keyboard=4
UX_VERDICT: FAIL'
  fixture 2 'feedback: after-running-390.png loses the busy dot when a tool runs.
UX_SCORES: clarity=4 density=4 consistency=4 feedback=2 keyboard=4
UX_VERDICT: FAIL'
  run_gate
  [ "$(reviews)" = 2 ] || fail "scores-line-only: $(reviews) reviews, want 2 (the scores line is not a finding)"
  [ "$RC" -eq 1 ] || fail "scores-line-only: exit $RC, want 1"
}

# Mean-only FAIL (3,3,3,3,3 = 3.0) has no below-3 axis: it is not a grounding case, so no
# re-ask, and the sendback stands exactly as before.
test_mean_only_fail_is_not_reasked() {
  new_case mean_only
  fixture 1 'Density and polish are only acceptable; several screens feel unfinished.
UX_SCORES: clarity=3 density=3 consistency=3 feedback=3 keyboard=3
UX_VERDICT: FAIL'
  run_gate
  [ "$RC" -eq 1 ] || fail "mean-only: exit $RC, want 1"
  [ "$(reviews)" = 1 ] || fail "mean-only: $(reviews) reviews, want 1 (no axis < 3, no re-ask)"
  grep -Fq 'mean 3.0 < 3.5' "$BODY" || fail "mean-only: the mean reason is not in the body"
}

# A re-ask that produces no review must not fall back to the first, ungrounded verdict: it is
# "no verdict" (exit 2), and the reason says the re-ask produced nothing.
test_reask_without_a_review_is_unavailable() {
  new_case reask_no_review
  fixture 1 'Everything looks right.
UX_SCORES: clarity=4 density=4 consistency=4 feedback=2 keyboard=4
UX_VERDICT: FAIL'
  printf 'dispatch timed out\n' > "$FIX/2.txt"
  run_gate
  [ "$RC" -eq 2 ] || fail "reask-no-review: exit $RC, want 2"
  [ "$(reviews)" = 2 ] || fail "reask-no-review: $(reviews) reviews, want 2"
  ungrounded_reason | grep -Fq 're-ask produced no review' || fail "reask-no-review: the reason does not name the missing re-ask"
  [ ! -s "$BODY" ] || fail "reask-no-review: a sendback body was written"
}

test_mutant_manifest_points_at_this_gate() {
  [ -s "$MANIFEST" ] || fail "manifest: $MANIFEST is missing"
  python3 - "$MANIFEST" "$GATE" <<'PY'
import json, sys
entries = json.load(open(sys.argv[1]))
gate = open(sys.argv[2], encoding="utf-8").read()
if not entries:
    raise SystemExit("manifest is empty")
for entry in entries:
    count = gate.count(entry["old"])
    if count != 1:
        raise SystemExit("`old` occurs %d times in ux-gate.sh, not once: %r" % (count, entry["label"]))
    if "test-ux-gate-grounded-red.sh" not in entry["test"]:
        raise SystemExit("`test` does not run this suite: %r" % entry["label"])
print("manifest ok: %d mutants, each anchored once in ux-gate.sh" % len(entries))
PY
  [ $? -eq 0 ] || fail "manifest: the mutants no longer point at the grounding block"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
  "$1" || exit 1
  pass "$1"
}

RAN=0
run test_grounded_red_stays_a_red
run test_ungrounded_red_is_reasked_once_then_grounded
run test_ungrounded_twice_is_unavailable
run test_scores_line_alone_does_not_ground
run test_mean_only_fail_is_not_reasked
run test_reask_without_a_review_is_unavailable
run test_mutant_manifest_points_at_this_gate
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo "ux-gate grounded-red contract: $RAN/$RAN cases passed"
