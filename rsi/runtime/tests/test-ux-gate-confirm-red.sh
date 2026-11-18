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

REVIEW_STUB="$T/bin/review.sh"
cat > "$REVIEW_STUB" <<'SH'
#!/bin/bash
printf 'looks fine\n'
printf 'UX_SCORES: clarity=4 density=4 consistency=4 feedback=4 keyboard=4\n'
printf 'UX_VERDICT: %s\n' "${REVIEW_VERDICT:-PASS}"
SH
chmod +x "$REVIEW_STUB"

export WALK_STUB REVIEW_STUB

new_case() {
  CASE="$1"
  ST="$T/$CASE.state"; FIX="$T/$CASE.fix"; LOG="$T/$CASE.walks.log"
  rm -rf "$ST" "$FIX" "$LOG"; mkdir -p "$ST" "$FIX"
  SHOTS="$ST/shots/$SLUG/journeys"; UXD="$ST/ux/$SLUG"; BODY="$ST/merge/$SLUG.ux.txt"
  : > "$LOG"
}
fixture() { printf '%s\n' "$2" > "$FIX/$1.json"; }
# hard_section — the lines the sendback bills under `walk hard failures:` (up to the blank line).
hard_section() {
  awk '/^walk hard failures:$/ { on=1; next } on && /^$/ { exit } on { print }' "$BODY"
}
run_gate() {
  RSI_CTRL="$CTRL" RSI_UX_STATE="$ST" RSI_UX_COOLDOWN_MIN=0 \
  RSI_UX_WALK_CMD='bash "$WALK_STUB" "$1" "${2:-}"' RSI_UX_REVIEW_CMD='bash "$REVIEW_STUB" "$1"' \
  WALKS_LOG="$LOG" FIX="$FIX" \
    bash "$CTRL/rsi/runtime/ux-gate.sh" "$WT" "$SLUG" "$ITEM" "$PR" deadbeef1234 reviewer \
    > "$T/$CASE.out" 2>&1
  RC=$?
}
walks() { wc -l < "$LOG" | tr -d ' '; }
score_field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["walk_confirm"][sys.argv[2]])' "$UXD/scores.json" "$1"; }

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

# The manifest must keep pointing at this gate and this suite: a rotted `old` would retire
# the red proof silently.
test_mutant_manifest_points_at_this_gate() {
  [ -f "$MANIFEST" ] || fail "manifest: no $MANIFEST"
  python3 - "$MANIFEST" "$REPO/rsi/runtime/ux-gate.sh" <<'PY' || exit 1
import json
import sys

manifest, gate = sys.argv[1], sys.argv[2]
entries = json.load(open(manifest, encoding="utf-8"))
if not isinstance(entries, list) or len(entries) != 3:
    raise SystemExit("manifest must be exactly three entries, got %r" % (entries,))
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
print("manifest ok: 3 mutants, each anchored once in ux-gate.sh")
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
run test_known_artefact_does_not_count_as_reproduced
run test_stale_confirm_evidence_does_not_poison
run test_mutant_manifest_points_at_this_gate
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo "ux-gate confirm-red contract: $RAN/$RAN cases passed"
