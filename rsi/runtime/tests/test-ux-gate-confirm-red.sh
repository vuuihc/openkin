#!/bin/bash
# test-ux-gate-confirm-red.sh — a walk red is re-walked once before it bills a rework round.
#
# 2026-11-18: #296 was billed a 9-minute lane and $0.89 for
# `J9/mac: scroll-kept ... at 3471, want 320±48`, which three independent walks of the same
# tree could not reproduce. That was the third false-red class that week (stale walker spec
# 02:31, index/assets mismatch 05:50, this one 13:34), because the gate's rule was "one sample
# convicts". ux-gate.sh now re-walks only the journeys a red names, once, on the same tree:
# reproduced failures survive, flakes are recorded (never billed), a new confirm failure is
# kept, and a confirm that cannot run keeps the first red. A green run walks once.
#
# 2026-11-19 (R-ux-gate-confirm-carry): #389's first walk hard-failed 33 lines and the confirm
# walk on the same tree reproduced 0, yet the reviewer still scored density=2 feedback=2 off
# the flaked first-walk screenshots: a below-3 verdict, a rework round and a block for evidence
# the gate itself had just disproved. When confirm.json says reproduced=0 flaked>0 the prompt
# now hands the reviewer the confirm walk instead of $SHOTS, names the flakes as not evidence,
# and a below-3 axis is grounded only by confirm-walk evidence; otherwise it is "no verdict".
#
# Hermetic: a temp control tree (common.sh + ux-gate.sh, so RSI_DIR and STATE resolve there),
# a throwaway git repo with an origin/main ref, and stubs for the walk, the reviewer and gh.
# npm/go/node/gh/curl are booby traps (exit 97), so a seam that reached a build, a daemon or
# the network cannot pass. Prints "ok: <case>" per case, exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used for the red proof).
# GATE=<path> points every case at another ux-gate.sh (the red proof against origin/main).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
GATE="${GATE:-$REPO/rsi/runtime/ux-gate.sh}"
MANIFEST="$HERE/ux-gate-confirm-red.mutants.json"
SLUG="ux-confirm"; ITEM="R-ux-gate-confirm-red"; PR=242
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"

pass() { echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# common.sh rewrites PATH, so an exported function is the only stub that survives into the
# child bash. gh is pinned to an absolute path by common.sh; the temp copy gets an override
# appended below.
npm()  { echo "booby trap: npm invoked" >&2; exit 97; }
go()   { echo "booby trap: go invoked" >&2; exit 97; }
node() { echo "booby trap: node invoked" >&2; exit 97; }
gh()   { echo "booby trap: gh invoked" >&2; exit 97; }
curl() { echo "booby trap: curl invoked" >&2; exit 97; }
export -f npm go node gh curl

# --- fixtures --------------------------------------------------------------------------------

# Temp control tree. common.sh derives RSI_CTRL from its own path, and ux-gate.sh sources the
# sibling common.sh, so the pair under <tmp>/ctrl/rsi/runtime is self-contained.
GH_STUB="$T/bin/gh"; mkdir -p "$T/bin"
printf '#!/bin/bash\nexit 0\n' > "$GH_STUB"; chmod +x "$GH_STUB"
CTRL="$T/ctrl"; mkdir -p "$CTRL/rsi/runtime"
cp "$REPO/rsi/runtime/common.sh" "$CTRL/rsi/runtime/common.sh"
cp "$GATE" "$CTRL/rsi/runtime/ux-gate.sh"
chmod +x "$CTRL/rsi/runtime/"*.sh
# common.sh pins GH=/opt/homebrew/bin/gh at source time, so an exported GH cannot win; the
# hermetic copy gets the stub appended. Nothing else in common.sh is altered.
printf '\nGH="%s"\n' "$GH_STUB" >> "$CTRL/rsi/runtime/common.sh"

# One throwaway repo: HEAD differs from origin/main so the gate's diff command is a real diff.
WT="$T/wt"; mkdir -p "$WT"; printf 'seed\n' > "$WT/README"
G() { /usr/bin/git -C "$WT" -c user.email=owner@example.com -c user.name=confirm \
        -c commit.gpgsign=false "$@"; }
G init -q
G add -A; G commit -qm seed
G update-ref refs/remotes/origin/main HEAD
G checkout -q -b rsi/test
printf 'change\n' >> "$WT/README"; G add -A; G commit -qm change

# Walker stub. $1 is the output dir, $2 the optional journey selector. Each call is one line
# in WALKS_LOG; call N reads fixtures from $FIX/N.json, N.unavailable or N.missing. No fixture
# means a green walk, so a case only states the calls it cares about.
WALK_STUB="$T/bin/walk.sh"
cat > "$WALK_STUB" <<'SH'
#!/bin/bash
set -u
dir="$1"; sel="${2:-}"
printf '%s|%s\n' "$dir" "$sel" >> "$WALKS_LOG"
n="$(wc -l < "$WALKS_LOG" | tr -d ' ')"
mkdir -p "$dir"
if [ -e "$FIX/$n.unavailable" ]; then cat "$FIX/$n.unavailable" > "$dir/UNAVAILABLE"; exit 2; fi
if [ -e "$FIX/$n.missing" ]; then exit 0; fi
if [ -s "$FIX/$n.json" ]; then cp "$FIX/$n.json" "$dir/walk.json"
else printf '{"hardFail":[],"screens":[]}\n' > "$dir/walk.json"; fi
printf 'png\n' > "$dir/seed-1-1.png"
SH
chmod +x "$WALK_STUB"

# Reviewer stub. Every call appends its prompt path to $REVIEW_LOG and copies the prompt to
# $PROMPT_DIR/<n>.md, so a case can prove what the gate actually handed the reviewer. Call N
# reads fixtures from $FIX/N.txt (no fixture = a passing review), the same numbering as the
# walker's own fixtures but a separate counter.
REVIEW_STUB="$T/bin/review.sh"
cat > "$REVIEW_STUB" <<'SH'
#!/bin/bash
set -u
printf '%s\n' "$1" >> "$REVIEW_LOG"
n="$(wc -l < "$REVIEW_LOG" | tr -d ' ')"
cp "$1" "$PROMPT_DIR/$n.md"
if [ -s "$FIX/$n.txt" ]; then cat "$FIX/$n.txt"; exit 0; fi
printf 'looks fine\n'
printf 'UX_SCORES: clarity=4 density=4 consistency=4 feedback=4 keyboard=4\n'
printf 'UX_VERDICT: %s\n' "${REVIEW_VERDICT:-PASS}"
SH
chmod +x "$REVIEW_STUB"

export WALK_STUB REVIEW_STUB

new_case() {
  CASE="$1"
  ST="$T/$CASE.state"; FIX="$T/$CASE.fix"; LOG="$T/$CASE.walks.log"; RLOG="$T/$CASE.reviews.log"
  PDIR="$T/$CASE.prompts"
  rm -rf "$ST" "$FIX" "$LOG" "$RLOG" "$PDIR"; mkdir -p "$ST" "$FIX" "$PDIR"
  SHOTS="$ST/shots/$SLUG/journeys"; UXD="$ST/ux/$SLUG"; BODY="$ST/merge/$SLUG.ux.txt"
  : > "$LOG"; : > "$RLOG"
}
fixture() { printf '%s\n' "$2" > "$FIX/$1.json"; }
rev_fixture() { printf '%s\n' "$2" > "$FIX/$1.txt"; }
# hard_section — the lines the sendback bills under `walk hard failures:` (up to the blank line).
hard_section() {
  awk '/^walk hard failures:$/ { on=1; next } on && /^$/ { exit } on { print }' "$BODY"
}
run_gate() {
  RSI_CTRL="$CTRL" RSI_UX_STATE="$ST" RSI_UX_COOLDOWN_MIN=0 \
  RSI_UX_WALK_CMD='bash "$WALK_STUB" "$1" "${2:-}"' RSI_UX_REVIEW_CMD='bash "$REVIEW_STUB" "$1"' \
  WALKS_LOG="$LOG" REVIEW_LOG="$RLOG" PROMPT_DIR="$PDIR" FIX="$FIX" \
    bash "$CTRL/rsi/runtime/ux-gate.sh" "$WT" "$SLUG" "$ITEM" "$PR" deadbeef1234 reviewer \
    > "$T/$CASE.out" 2>&1
  RC=$?
}
walks() { wc -l < "$LOG" | tr -d ' '; }
reviews() { wc -l < "$RLOG" | tr -d ' '; }
prompt_has() { grep -Fq "$2" "$PDIR/$1.md"; }
score_field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["walk_confirm"][sys.argv[2]])' "$UXD/scores.json" "$1"; }

FLAKE="J9/mac: scroll-kept [role=region][tabindex='-1'] is at 0, want 320±48"
flake_json() { printf '{"hardFail":["%s"],"screens":[]}\n' "$FLAKE"; }

# --- cases -----------------------------------------------------------------------------------

# The J9 flake (the #296 / 13:34 line) must not survive a confirm walk that only reproduces
# J2, and the first walk's evidence must stay untouched for the reviewer to open.
test_confirm_fails_only_reproduced() {
  new_case confirm_reproduced
  fixture 1 '{"hardFail":["J9/mac: scroll-kept at 3471, want 320±48","J2/mac: wait box"],"screens":[]}'
  fixture 2 '{"hardFail":["J2/mac: wait box"],"screens":[]}'
  run_gate
  [ "$RC" -eq 1 ] || fail "confirm-reproduced: exit $RC, want 1 ($(tail -3 "$T/$CASE.out" | tr '\n' ' '))"
  hard_section | grep -Fq 'J2/mac: wait box' || fail "confirm-reproduced: the reproduced J2 line is not billed"
  hard_section | grep -Fq 'scroll-kept' && fail "confirm-reproduced: the flaked J9 line is still billed"
  grep -Fq 'reproduced=1 flaked=1' "$BODY" || fail "confirm-reproduced: the body has no reproduced/flaked count"
  grep -Fq 're-walked J2,J9' "$BODY" || fail "confirm-reproduced: the body does not name the re-walked journeys"
  grep -Fq 'flaked' "$BODY" || fail "confirm-reproduced: the flaked line is not recorded in the body"
  [ "$(walks)" = 2 ] || fail "confirm-reproduced: $(walks) walks, want exactly 2"
  tail -1 "$LOG" | grep -q '|J2,J9$' || fail "confirm-reproduced: confirm selector was '$(tail -1 "$LOG")', want J2,J9"
  head -1 "$LOG" | grep -q "|$" || fail "confirm-reproduced: the first walk got a selector"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if len(d["hardFail"])==2 else 1)' \
    "$SHOTS/walk.json" || fail "confirm-reproduced: the first walk's walk.json was overwritten"
  [ "$(score_field flaked)" = 1 ] || fail "confirm-reproduced: scores.json walk_confirm.flaked is not 1"
}

# Everything flaked and the reviewer passed: the PR merges, no sendback, and the false red is
# still countable. This is #296's outcome.
test_confirm_flake_passes() {
  new_case confirm_flake
  fixture 1 '{"hardFail":["J9/mac: scroll-kept at 3471, want 320±48"],"screens":[]}'
  run_gate
  [ "$RC" -eq 0 ] || fail "confirm-flake: exit $RC, want 0 ($(tail -3 "$T/$CASE.out" | tr '\n' ' '))"
  [ ! -s "$BODY" ] || fail "confirm-flake: a sendback body was written: $(head -3 "$BODY" | tr '\n' ' ')"
  [ "$(walks)" = 2 ] || fail "confirm-flake: $(walks) walks, want exactly 2"
  [ "$(score_field flaked)" = 1 ] || fail "confirm-flake: scores.json walk_confirm.flaked is not 1"
  [ "$(score_field reproduced)" = 0 ] || fail "confirm-flake: scores.json walk_confirm.reproduced is not 0"
}

# A green first walk is not re-walked and never creates the confirm directory: the confirm is
# a red-only cost.
test_green_run_walks_once() {
  new_case green_once
  run_gate
  [ "$RC" -eq 0 ] || fail "green-once: exit $RC, want 0"
  [ "$(walks)" = 1 ] || fail "green-once: $(walks) walks, want exactly 1"
  [ ! -e "$UXD/confirm" ] || fail "green-once: the confirm directory was created"
}

# A confirm that cannot run must fail closed: the first red stands and the gate stays FAIL,
# never exit 2 (which would say "infra, not merged / needs-ceo").
test_confirm_unavailable_fails_closed() {
  new_case confirm_unavailable
  fixture 1 '{"hardFail":["J9/mac: scroll-kept at 3471, want 320±48"],"screens":[]}'
  printf 'chrome crashed mid-walk\n' > "$FIX/2.unavailable"
  run_gate
  [ "$RC" -eq 1 ] || fail "confirm-unavailable: exit $RC, want 1 (not 2, not 0)"
  hard_section | grep -Fq 'scroll-kept' || fail "confirm-unavailable: the first-walk failure was dropped"
  grep -Fq 'confirm: unavailable' "$BODY" || fail "confirm-unavailable: the body does not say the confirm was unavailable"

  new_case confirm_no_json
  fixture 1 '{"hardFail":["J9/mac: scroll-kept at 3471, want 320±48"],"screens":[]}'
  : > "$FIX/2.missing"
  run_gate
  [ "$RC" -eq 1 ] || fail "confirm-no-json: exit $RC, want 1 (not 2, not 0)"
  hard_section | grep -Fq 'scroll-kept' || fail "confirm-no-json: the first-walk failure was dropped"
  grep -Fq 'confirm: unavailable' "$BODY" || fail "confirm-no-json: the body does not say the confirm was unavailable"
}

# A confirm walk.json that is present but unparseable (walker killed mid-write, partial write,
# disk full) must fail closed like any other unavailable confirm: empty evidence used to mark
# every first-walk failure as flaked and could pass a real red.
test_confirm_unreadable_json_fails_closed() {
  new_case confirm_unreadable
  fixture 1 '{"hardFail":["J9/mac: scroll-kept at 3471, want 320±48"],"screens":[]}'
  fixture 2 '{"hardFail": ['
  run_gate
  [ "$RC" -eq 1 ] || fail "confirm-unreadable: exit $RC, want 1 (not 2, not 0)"
  hard_section | grep -Fq 'scroll-kept' || fail "confirm-unreadable: the first-walk failure was dropped"
  grep -Fq 'walk.json unreadable' "$BODY" || fail "confirm-unreadable: the body does not name the unreadable confirm"
  grep -Fq 'flaked' "$BODY" && fail "confirm-unreadable: the first red was recorded as flaked"
  [ "$(walks)" = 2 ] || fail "confirm-unreadable: $(walks) walks, want exactly 2"
}

# A flaky first sample must not hide a real second failure: the confirm walk's own new line
# is billed, and the first-walk line is recorded as flaked.
test_confirm_new_failure_is_kept() {
  new_case confirm_new
  fixture 1 '{"hardFail":["J9/mac: A"],"screens":[]}'
  fixture 2 '{"hardFail":["J9/mac: B"],"screens":[]}'
  run_gate
  [ "$RC" -eq 1 ] || fail "confirm-new: exit $RC, want 1"
  hard_section | grep -Fqx 'J9/mac: B' || fail "confirm-new: the new confirm failure is not billed: $(hard_section | tr '\n' ' ')"
  hard_section | grep -Fq 'J9/mac: A' && fail "confirm-new: the unreproduced first-walk line is still billed"
  grep -Fq 'reproduced=0 flaked=1' "$BODY" || fail "confirm-new: the body does not count A as flaked"
  grep -Fq 'J9/mac: A' "$BODY" || fail "confirm-new: the flaked line is not named in the body"
}

# A hard-fail line with no journey prefix cannot be localised; re-walking everything would
# double the cost for a failure the selector cannot target, so the first walk stands alone.
test_unattributable_failure_skips_confirm() {
  new_case unattributable
  fixture 1 '{"hardFail":["blank page"],"screens":[]}'
  run_gate
  [ "$RC" -eq 1 ] || fail "unattributable: exit $RC, want 1"
  hard_section | grep -Fqx 'blank page' || fail "unattributable: the first-walk line was not kept"
  [ "$(walks)" = 1 ] || fail "unattributable: $(walks) walks, want exactly 1 (no confirm)"
  [ ! -e "$UXD/confirm" ] || fail "unattributable: a confirm directory was created"
}

# A screenshot check names its journey in the step name (`J11-phone-03-switch-back: blank page`),
# so it is localisable and must be re-walked like any step failure. Treating it as unattributable
# billed #330 a rework round (2026-11-18 22:03) for two blank-page lines the gate's own confirm walk
# could not reproduce — the same false-red class #296 paid for.
test_step_named_failure_is_confirmed() {
  new_case step_named_flake
  fixture 1 '{"hardFail":["J11-phone-03-switch-back: blank page"],"screens":[]}'
  run_gate
  [ "$RC" -eq 0 ] || fail "step-named-flake: exit $RC, want 0 ($(tail -3 "$T/$CASE.out" | tr '\n' ' '))"
  [ "$(walks)" = 2 ] || fail "step-named-flake: $(walks) walks, want exactly 2"
  tail -1 "$LOG" | grep -q '|J11$' || fail "step-named-flake: confirm selector was '$(tail -1 "$LOG")', want J11"
  [ ! -s "$BODY" ] || fail "step-named-flake: a sendback body was written: $(head -3 "$BODY" | tr '\n' ' ')"
  [ "$(score_field flaked)" = 1 ] || fail "step-named-flake: scores.json walk_confirm.flaked is not 1"

  new_case step_named_real
  fixture 1 '{"hardFail":["J11-phone-03-switch-back: blank page"],"screens":[]}'
  fixture 2 '{"hardFail":["J11-phone-03-switch-back: blank page"],"screens":[]}'
  run_gate
  [ "$RC" -eq 1 ] || fail "step-named-real: exit $RC, want 1 (a reproduced blank page must still block)"
  hard_section | grep -Fqx 'J11-phone-03-switch-back: blank page' || fail "step-named-real: the reproduced blank page is not billed"
  grep -Fq 'reproduced=1 flaked=0' "$BODY" || fail "step-named-real: the body does not count the reproduced line"
}

# A known artefact is an environment defect: it is filtered from the first walk (existing
# behaviour) and must not sneak back in as a reproduced failure from the confirm walk.
test_known_artefact_does_not_count_as_reproduced() {
  new_case known_artifact
  printf 'J9/mac: scroll-kept at 3471, want 320±48\n' > "$ST/ux-known-artifacts.txt"
  fixture 1 '{"hardFail":["J9/mac: scroll-kept at 3471, want 320±48"],"screens":[]}'
  run_gate
  [ "$RC" -eq 0 ] || fail "known-artefact: exit $RC, want 0 (the only failure is known)"
  [ "$(walks)" = 1 ] || fail "known-artefact: $(walks) walks, want exactly 1"
  [ ! -e "$UXD/confirm" ] || fail "known-artefact: the known line started a confirm walk"
  [ -s "$UXD/ignored.txt" ] || fail "known-artefact: the known line was not recorded in ignored.txt"
}

# A previous red run's confirm evidence must not decide this run: a stale UNAVAILABLE used to
# make a successful confirm look unavailable, and a stale walk.json could look reproduced.
test_stale_confirm_evidence_does_not_poison() {
  new_case stale_confirm
  fixture 1 '{"hardFail":["J9/mac: scroll-kept at 3471, want 320±48"],"screens":[]}'
  printf 'chrome crashed mid-walk\n' > "$FIX/2.unavailable"
  run_gate
  [ "$RC" -eq 1 ] || fail "stale-confirm: setup run exit $RC, want 1"
  [ -e "$UXD/confirm/UNAVAILABLE" ] || fail "stale-confirm: the setup run left no UNAVAILABLE to poison the next"
  fixture 3 '{"hardFail":["J9/mac: scroll-kept at 3471, want 320±48"],"screens":[]}'
  run_gate   # call 4 has no fixture: the confirm walk is green and must win over the stale marker
  [ "$RC" -eq 0 ] || fail "stale-confirm: exit $RC, want 0 (a stale UNAVAILABLE decided this run)"
  [ "$(score_field flaked)" = 1 ] || fail "stale-confirm: the flake was not counted"
}

# R-ux-gate-confirm-carry case 1: when the confirm walk reproduced nothing, the reviewer must
# open the confirm walk, not the flaked first walk, and the prompt must say the flakes are not
# evidence about this PR. With a passing review the gate merges. RED on the branch base, where
# the prompt still named $SHOTS and never listed the flakes.
test_flaked_only_red_reviews_confirm_evidence() {
  new_case flaked_only_pass
  fixture 1 "$(flake_json)"
  run_gate
  [ "$RC" -eq 0 ] || fail "flaked-only-pass: exit $RC, want 0 ($(tail -3 "$T/$CASE.out" | tr '\n' ' '))"
  [ ! -s "$BODY" ] || fail "flaked-only-pass: a sendback body was written: $(head -3 "$BODY" | tr '\n' ' ')"
  [ "$(walks)" = 2 ] || fail "flaked-only-pass: $(walks) walks, want exactly 2"
  [ "$(reviews)" = 1 ] || fail "flaked-only-pass: $(reviews) reviews, want 1"
  prompt_has 1 "the walk screenshots in $UXD/confirm (" \
    || fail "flaked-only-pass: the prompt does not name the confirm walk: $(grep -i 'walk screenshots' "$PDIR/1.md" | head -1)"
  prompt_has 1 "$UXD/confirm/walk.json" || fail "flaked-only-pass: the prompt does not name the confirm walk.json"
  prompt_has 1 "the walk screenshots in $SHOTS (" && fail "flaked-only-pass: the prompt still names the flaked first walk"
  prompt_has 1 "$FLAKE" || fail "flaked-only-pass: the prompt does not list the flaked line verbatim"
  prompt_has 1 "not evidence about this PR" || fail "flaked-only-pass: the prompt does not say the flakes are not evidence"
  [ "$(score_field reproduced)" = 0 ] || fail "flaked-only-pass: scores.json walk_confirm.reproduced is not 0"
  [ "$(score_field flaked)" = 1 ] || fail "flaked-only-pass: scores.json walk_confirm.flaked is not 1"
}

# R-ux-gate-confirm-carry case 2: a below-3 axis grounded only in a flaked line is today's
# ungrounded axis. Re-asked once with the flakes spelled out; a second answer that still quotes
# only the flake is "no verdict" (exit 2), never a sendback (exit 1) and never a merge.
test_flaked_only_red_below_three_is_unavailable() {
  new_case flaked_only_ungrounded
  fixture 1 "$(flake_json)"
  rev_fixture 1 "density: $FLAKE
UX_SCORES: clarity=4 density=2 consistency=4 feedback=4 keyboard=4
UX_VERDICT: FAIL"
  rev_fixture 2 "density: $FLAKE
UX_SCORES: clarity=4 density=2 consistency=4 feedback=4 keyboard=4
UX_VERDICT: FAIL"
  run_gate
  [ "$RC" -eq 2 ] || fail "flaked-only-ungrounded: exit $RC, want 2 (no verdict, not a sendback)"
  [ "$(reviews)" = 2 ] || fail "flaked-only-ungrounded: $(reviews) reviews, want 2 (one re-ask)"
  [ ! -s "$BODY" ] || fail "flaked-only-ungrounded: a sendback body was written"
  grep -Fq 'density' "$UXD/unavailable.txt" || fail "flaked-only-ungrounded: the reason does not name the axis"
  grep -Fq 'asked twice' "$UXD/unavailable.txt" || fail "flaked-only-ungrounded: the reason does not say it was asked twice"
  prompt_has 2 "$FLAKE" || fail "flaked-only-ungrounded: the re-ask does not spell out the flaked line"
}

# R-ux-gate-confirm-carry case 3 (fail-closed): when the confirm walk reproduces the line, the
# first walk is the evidence, nothing is called a flake, and the red still sends the PR back.
test_reproduced_red_still_reviews_first_walk() {
  new_case reproduced_first_walk
  fixture 1 "$(flake_json)"
  fixture 2 "$(flake_json)"
  run_gate
  [ "$RC" -eq 1 ] || fail "reproduced-first-walk: exit $RC, want 1 ($(tail -3 "$T/$CASE.out" | tr '\n' ' '))"
  [ "$(reviews)" = 1 ] || fail "reproduced-first-walk: $(reviews) reviews, want 1"
  prompt_has 1 "the walk screenshots in $SHOTS (" || fail "reproduced-first-walk: the prompt does not name the first walk"
  prompt_has 1 "not evidence about this PR" && fail "reproduced-first-walk: the flaked preamble leaked into a reproduced red"
  hard_section | grep -Fq 'scroll-kept' || fail "reproduced-first-walk: the reproduced line is not billed"
  grep -Fq 'reproduced=1 flaked=0' "$BODY" || fail "reproduced-first-walk: the body does not count the reproduced line"
}

# The composition rule: a below-3 axis that DOES name confirm-walk evidence stays a normal
# sendback. Without this, the new branch would make every below-3 score unavailable, which
# would hide a real defect the confirm walk did reproduce on screen.
test_flaked_only_grounded_below_three_is_a_red() {
  new_case flaked_only_grounded
  fixture 1 "$(flake_json)"
  rev_fixture 1 "density: seed-1-1.png (confirm walk) shows a cramped empty state; the transcript is clipped.
UX_SCORES: clarity=4 density=2 consistency=4 feedback=4 keyboard=4
UX_VERDICT: FAIL"
  run_gate
  [ "$RC" -eq 1 ] || fail "flaked-only-grounded: exit $RC, want 1 ($(tail -3 "$T/$CASE.out" | tr '\n' ' '))"
  [ "$(reviews)" = 1 ] || fail "flaked-only-grounded: $(reviews) reviews, want 1 (confirm evidence needs no re-ask)"
  [ ! -e "$UXD/unavailable.txt" ] || fail "flaked-only-grounded: a grounded confirm finding was recorded as unavailable"
  grep -Fq 'density: seed-1-1.png' "$BODY" || fail "flaked-only-grounded: the confirm evidence line is not billed"
}

# The manifest must keep pointing at this gate and this suite: a rotted `old` would retire
# the red proof silently.
test_mutant_manifest_points_at_this_gate() {
  [ -f "$MANIFEST" ] || fail "manifest: no $MANIFEST"
  python3 - "$MANIFEST" "$REPO/rsi/runtime/ux-gate.sh" <<'PY' || exit 1
import json
import sys

manifest, gate = sys.argv[1], sys.argv[2]
entries = json.load(open(manifest, encoding="utf-8"))
if not isinstance(entries, list) or len(entries) != 4:
    raise SystemExit("manifest must be exactly four entries, got %r" % (entries,))
text = open(gate, encoding="utf-8").read()
for entry in entries:
    for key in ("label", "file", "old", "new", "test"):
        if not isinstance(entry.get(key), str) or not entry[key]:
            raise SystemExit("entry is missing a non-empty %r" % key)
    if entry["file"] != "rsi/runtime/ux-gate.sh":
        raise SystemExit("mutant file is %r, not the confirm gate" % entry["file"])
    if entry["old"] == entry["new"]:
        raise SystemExit("`new` is identical to `old`; the mutant changes nothing")
    count = text.count(entry["old"])
    if count != 1:
        raise SystemExit("`old` occurs %d times in ux-gate.sh, not once: %r" % (count, entry["label"]))
    if "test-ux-gate-confirm-red.sh" not in entry["test"]:
        raise SystemExit("`test` does not run this suite: %r" % entry["label"])
print("manifest ok: 4 mutants, each anchored once in ux-gate.sh")
PY
  [ $? -eq 0 ] || fail "manifest: the mutants no longer point at the confirm block"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
  "$1" || exit 1
  pass "$1"
}

RAN=0
run test_confirm_fails_only_reproduced
run test_confirm_flake_passes
run test_green_run_walks_once
run test_confirm_unavailable_fails_closed
run test_confirm_unreadable_json_fails_closed
run test_confirm_new_failure_is_kept
run test_unattributable_failure_skips_confirm
run test_step_named_failure_is_confirmed
run test_known_artefact_does_not_count_as_reproduced
run test_stale_confirm_evidence_does_not_poison
run test_flaked_only_red_reviews_confirm_evidence
run test_flaked_only_red_below_three_is_unavailable
run test_reproduced_red_still_reviews_first_walk
run test_flaked_only_grounded_below_three_is_a_red
run test_mutant_manifest_points_at_this_gate
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo "ux-gate confirm-red contract: $RAN/$RAN cases passed"
