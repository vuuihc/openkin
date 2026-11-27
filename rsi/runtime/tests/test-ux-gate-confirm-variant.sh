#!/bin/bash
# test-ux-gate-confirm-variant.sh — a red only the confirm walk produced is sampled twice.
#
# 2026-11-24 (R-ux-confirm-variant): #656's 06:29 confirm walk invented
# `J9/mac: scroll-kept [role=region][tabindex='-1'] is at 2201, want 320±48` — a line the
# full-spec first walk never produced (its confirm.json says reproduced=0, and reproduced is
# the intersection) — and the gate billed a fourth rework round for it while §1c called the
# first walk's reds "not evidence" for the same run. A hard-fail line that appears only in the
# confirm walk (a variant) now needs a second confirm sample on the same tree: seen twice it
# convicts; seen once it is recorded as evidence (confirm.json variant=<n>, the summary's
# variant=<n>, confirm.txt under a variant heading, confirm.hard empty) and never bills.
# A first-walk line the confirm reproduces still convicts on the first sample; a green run
# still walks once; and a second sample that cannot run keeps the conviction (fail closed).
#
# Hermetic like its sibling test-ux-gate-confirm-red.sh: a temp control tree (common.sh +
# ux-gate.sh, so RSI_DIR and STATE resolve there), a throwaway git repo with an origin/main
# ref, stubs for the walk and the reviewer, and npm/go/node/gh/curl booby traps (exit 97).
# Prints "PASS <case>" per case, exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used for the red proof).
# GATE=<path> points every case at another ux-gate.sh (the red proof against origin/main).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
GATE="${GATE:-$REPO/rsi/runtime/ux-gate.sh}"
SLUG="ux-variant"; ITEM="R-ux-confirm-variant"; PR=660
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
INV="$T/invariants"; mkdir -p "$INV"

pass() { echo "PASS $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# common.sh rewrites PATH, so an exported function is the only stub that survives into the
# child bash; gh is pinned to an absolute path by common.sh, so the temp copy gets an override.
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

# One throwaway repo: HEAD differs from origin/main so the gate's diff command is a real diff.
# No journeys.json: attribution fails closed, so every journey a red names is in scope and the
# cases below are about the confirm samples, not about §1b0.
WT="$T/wt"; mkdir -p "$WT"; printf 'seed\n' > "$WT/README"
G() { /usr/bin/git -C "$WT" -c user.email=owner@example.com -c user.name=variant \
        -c commit.gpgsign=false "$@"; }
G init -q
G add -A; G commit -qm seed
G update-ref refs/remotes/origin/main HEAD
G checkout -q -b rsi/test
printf 'change\n' >> "$WT/README"; G add -A; G commit -qm change

# Walker stub. $1 is the output dir, $2 the optional journey selector. Each call is one line in
# WALKS_LOG; call N reads fixtures from $FIX/N.json, N.unavailable, N.exit2 or N.missing. No
# fixture means a green walk, so a case states only the calls it cares about.
WALK_STUB="$T/bin/walk.sh"
cat > "$WALK_STUB" <<'SH'
#!/bin/bash
set -u
dir="$1"; sel="${2:-}"
printf '%s|%s\n' "$dir" "$sel" >> "$WALKS_LOG"
n="$(wc -l < "$WALKS_LOG" | tr -d ' ')"
mkdir -p "$dir"
if [ -e "$FIX/$n.unavailable" ]; then cat "$FIX/$n.unavailable" > "$dir/UNAVAILABLE"; exit 2; fi
if [ -e "$FIX/$n.exit2" ]; then exit 2; fi
if [ -e "$FIX/$n.missing" ]; then exit 0; fi
if [ -s "$FIX/$n.json" ]; then cp "$FIX/$n.json" "$dir/walk.json"
else printf '{"hardFail":[],"screens":[]}\n' > "$dir/walk.json"; fi
printf 'png\n' > "$dir/seed-1-1.png"
SH
chmod +x "$WALK_STUB"

# Reviewer stub: a passing review, so a FAIL can only come from the walk half. Each prompt is
# copied to $PROMPT_DIR/<n>.md so a case can prove which state the reviewer was handed. Call N
# reads an answer from $FIX/N.review when one exists (the re-ask case), else passes.
REVIEW_STUB="$T/bin/review.sh"
cat > "$REVIEW_STUB" <<'SH'
#!/bin/bash
set -u
printf '%s\n' "$1" >> "$REVIEW_LOG"
n="$(wc -l < "$REVIEW_LOG" | tr -d ' ')"
cp "$1" "$PROMPT_DIR/$n.md"
if [ -s "$FIX/$n.review" ]; then cat "$FIX/$n.review"; exit 0; fi
printf 'looks fine\n'
printf 'UX_SCORES: clarity=4 density=4 consistency=4 feedback=4 keyboard=4\n'
printf 'UX_VERDICT: PASS\n'
SH
chmod +x "$REVIEW_STUB"

export WALK_STUB REVIEW_STUB

new_case() {
  CASE="$1"
  ST="$T/$CASE.state"; FIX="$T/$CASE.fix"; LOG="$T/$CASE.walks.log"; RLOG="$T/$CASE.reviews.log"
  PDIR="$T/$CASE.prompts"
  rm -rf "$ST" "$FIX" "$LOG" "$RLOG" "$PDIR"; mkdir -p "$ST" "$FIX" "$PDIR"
  SHOTS="$ST/shots/$SLUG/journeys"; UXD="$ST/ux/$SLUG"; BODY="$ST/merge/$SLUG.ux.txt"
  CONF_JSON="$UXD/confirm.json"
  : > "$LOG"; : > "$RLOG"
}
fixture() { printf '%s\n' "$2" > "$FIX/$1.json"; }
review_fixture() { printf '%s\n' "$2" > "$FIX/$1.review"; }
red_json() { printf '{"hardFail":["%s"],"screens":[]}\n' "$1"; }
red_json_line() { python3 -c 'import json,sys; print(json.dumps({"hardFail":[sys.argv[1]],"screens":[]}, ensure_ascii=False))' "$1"; }
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
field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v=d[sys.argv[2]]; print("true" if v is True else "false" if v is False else v)' "$CONF_JSON" "$1"; }
expect_field() { # <name> <want>
  local got; got="$(field "$1")"
  [ "$got" = "$2" ] || fail "$CASE: confirm.json $1 is $got, want $2"
}
# record_invariant — keep this case's artifacts for test_confirm_only_never_with_a_conviction.
record_invariant() {
  mkdir -p "$INV/$CASE"
  cp "$CONF_JSON" "$INV/$CASE/confirm.json"
  cp "$UXD/confirm.hard" "$INV/$CASE/confirm.hard"
}

# The #656 first-walk red, and a variant only a confirm sample produces.
X='J9/mac: scroll-kept at 3471, want 320±48'
Y='J9/mac: scroll-kept at 2201, want 320±48'
R0='J12/phone: rows css=[data-phone-scroll] are ["[seed] Approve the migration · Claude Code · 2分钟前 · 运行中", "[seed] Morning planning · Claude Code · 41秒钟前 · 已完成"], want ["[seed] Morning planning", "[seed] Approve the migration"]'
R1='J12/phone: rows css=[data-phone-scroll] are ["[seed] Approve the migration · Claude Code · 3分钟前 · 运行中", "[seed] Morning planning · Claude Code · 43秒钟前 · 已完成"], want ["[seed] Morning planning", "[seed] Approve the migration"]'
R2='J12/phone: rows css=[data-phone-scroll] are ["[seed] Approve the migration · Claude Code · 33秒钟前 · 待批准 1", "[seed] Morning planning · Claude Code · 1分钟前 · 已完成"], want ["[seed] Morning planning", "[seed] Approve the migration"]'
OV1='J12/phone: rows css=[data-phone-scroll] are ["[seed] Morning planning · Claude Code · 33秒钟前 · 已完成"], want ["[seed] Morning", "[seed] Morning planning"]'
OV2='J12/phone: rows css=[data-phone-scroll] are ["[seed] Morning planning · Claude Code · 34秒钟前 · 已完成"], want ["[seed] Morning", "[seed] Morning planning"]'
RREV='J12/phone: rows css=[data-phone-scroll] are ["[seed] Morning planning · Claude Code · 33秒钟前 · 已完成", "[seed] Approve the migration · Claude Code · 1分钟前 · 待批准 1"], want ["[seed] Morning planning", "[seed] Approve the migration"]'

# --- cases -----------------------------------------------------------------------------------

# Case 1: the first walk red X, confirm1 produces only the new Y, confirm2 is green. Y is a
# variant seen once: it is evidence (counted, listed) and must not convict, and the run is the
# confirm-only state. RED on origin/main, which bills Y on its first confirm sample.
test_variant_line_needs_second_sample() {
  new_case variant_once
  fixture 1 "$(red_json "$X")"
  fixture 2 "$(red_json "$Y")"
  run_gate
  [ "$RC" -eq 0 ] || fail "variant-once: exit $RC, want 0 (one sample must not convict a variant): $(tail -3 "$T/$CASE.out" | tr '\n' ' ')"
  [ "$(walks)" = 3 ] || fail "variant-once: $(walks) walks, want 3 (first walk + confirm + second sample)"
  tail -1 "$LOG" | grep -q '|J9$' || fail "variant-once: the second sample selector was '$(tail -1 "$LOG")', want J9"
  expect_field reproduced 0
  expect_field flaked 1
  expect_field variant 1
  expect_field variant_confirmed 0
  expect_field variant_sample ok
  expect_field confirm_only true
  [ ! -s "$UXD/confirm.hard" ] || fail "variant-once: confirm.hard bills the one-sample variant: $(tr '\n' ' ' < "$UXD/confirm.hard")"
  grep -Fq 'variant=1' "$UXD/confirm.summary" || fail "variant-once: the summary has no variant=1: $(head -1 "$UXD/confirm.summary")"
  grep -A3 '^variant (' "$UXD/confirm.txt" | grep -Fqx "$Y" \
    || fail "variant-once: the variant line is not under confirm.txt's variant heading: $(tr '\n' ' ' < "$UXD/confirm.txt")"
  # CONFIRM_ONLY is on: the reviewer is told the first-walk reds are not evidence.
  prompt_has 1 "not evidence about this PR" || fail "variant-once: the run is not in the confirm-only state"
  # The variant section of confirm.txt is a different list: printing it here would hand the
  # reviewer the one-sample line under "did not reproduce", i.e. call the gate's own evidence
  # a flake it already ruled in. Only the flaked first-walk lines belong there.
  prompt_has 1 "$Y" && fail "variant-once: the one-sample variant is presented as a flake"
  record_invariant
}

# Case 2: both confirm samples produce Y. Seen twice, it convicts on the same terms as a
# reproduced red, and the run is not the confirm-only state.
test_variant_line_seen_twice_convicts() {
  new_case variant_twice
  fixture 1 "$(red_json "$X")"
  fixture 2 "$(red_json "$Y")"
  fixture 3 "$(red_json "$Y")"
  run_gate
  [ "$RC" -eq 1 ] || fail "variant-twice: exit $RC, want 1 (a variant seen twice must convict): $(tail -3 "$T/$CASE.out" | tr '\n' ' ')"
  hard_section | grep -Fqx "$Y" || fail "variant-twice: the confirmed variant is not billed: $(hard_section | tr '\n' ' ')"
  grep -Fqx "$Y" "$UXD/confirm.hard" || fail "variant-twice: confirm.hard does not carry the confirmed variant"
  expect_field reproduced 0
  expect_field flaked 1
  expect_field variant 0
  expect_field variant_confirmed 1
  expect_field confirm_only false
  grep -Fq 'variant=0' "$UXD/confirm.summary" || fail "variant-twice: the summary counts an unconfirmed variant"
  grep -Fq '1 confirmed' "$UXD/confirm.summary" || fail "variant-twice: the summary does not say the sample confirmed it: $(tr '\n' ' ' < "$UXD/confirm.summary")"
  [ "$(walks)" = 3 ] || fail "variant-twice: $(walks) walks, want 3"
  record_invariant
}

test_rows_variant_with_volatile_metadata_convicts() {
  new_case rows_volatile_convict
  fixture 1 "$(red_json "$X")"
  fixture 2 "$(red_json_line "$R1")"
  fixture 3 "$(red_json_line "$R2")"
  run_gate
  [ "$RC" -eq 1 ] || fail "rows-volatile-convict: exit $RC, want 1 (the same row order must convict across volatile row metadata)"
  hard_section | grep -Fqx "$R1" || fail "rows-volatile-convict: the confirmed row-order line is not billed: $(hard_section | tr '\n' ' ')"
  expect_field variant 0
  expect_field variant_confirmed 1
  expect_field confirm_only false
}

test_rows_reproduced_with_volatile_metadata_convicts_without_a_second_sample() {
  new_case rows_volatile_reproduced
  fixture 1 "$(red_json_line "$R0")"
  fixture 2 "$(red_json_line "$R1")"
  run_gate
  [ "$RC" -eq 1 ] || fail "rows-volatile-reproduced: exit $RC, want 1"
  hard_section | grep -Fqx "$R1" || fail "rows-volatile-reproduced: the reproduced row-order line is not billed: $(hard_section | tr '\n' ' ')"
  [ "$(walks)" = 2 ] || fail "rows-volatile-reproduced: $(walks) walks, want exactly 2"
  expect_field reproduced 1
  expect_field variant 0
  expect_field variant_sample not-needed
}

test_rows_variant_reversed_order_does_not_convict() {
  new_case rows_reversed_variant
  fixture 1 "$(red_json "$X")"
  fixture 2 "$(red_json_line "$R1")"
  fixture 3 "$(red_json_line "$RREV")"
  run_gate
  [ "$RC" -eq 0 ] || fail "rows-reversed-variant: exit $RC, want 0 (a different row order must not convict)"
  expect_field variant 1
  expect_field variant_confirmed 0
  expect_field confirm_only true
}

test_overlapping_rows_tokens_fail_closed_to_exact_comparison() {
  new_case rows_overlapping_variant
  fixture 1 "$(red_json "$X")"
  fixture 2 "$(red_json_line "$OV1")"
  fixture 3 "$(red_json_line "$OV2")"
  run_gate
  [ "$RC" -eq 0 ] || fail "rows-overlapping-variant: exit $RC, want 0 (ambiguous overlapping tokens must not convict across volatile metadata)"
  expect_field variant 1
  expect_field variant_confirmed 0
  expect_field confirm_only true
}

# Case 3 (fail closed): confirm2 exits 2 and leaves no walk.json. The variant keeps its
# conviction, the summary says the second sample was unavailable, and the gate never turns the
# red into "unavailable" (exit 2).
test_second_sample_unavailable_keeps_the_red() {
  new_case variant_unavailable
  fixture 1 "$(red_json "$X")"
  fixture 2 "$(red_json "$Y")"
  : > "$FIX/3.exit2"
  run_gate
  [ "$RC" -eq 1 ] || fail "variant-unavailable: exit $RC, want 1 (not 2, not 0)"
  hard_section | grep -Fqx "$Y" || fail "variant-unavailable: the variant red was dropped: $(hard_section | tr '\n' ' ')"
  grep -Fqx "$Y" "$UXD/confirm.hard" || fail "variant-unavailable: confirm.hard does not carry the kept variant"
  grep -Fq 'second sample: unavailable' "$UXD/confirm.summary" \
    || fail "variant-unavailable: the summary does not say the second sample was unavailable: $(tr '\n' ' ' < "$UXD/confirm.summary")"
  grep -Fq 'variant lines kept' "$UXD/confirm.summary" || fail "variant-unavailable: the summary does not say the variant was kept"
  expect_field variant 0
  expect_field variant_confirmed 1
  expect_field variant_sample unavailable
  expect_field confirm_only false
  [ ! -e "$UXD/confirm2/walk.json" ] || fail "variant-unavailable: the fixture was supposed to leave no walk.json"
  [ "$(walks)" = 3 ] || fail "variant-unavailable: $(walks) walks, want 3"
  record_invariant
}

# Case 4: the confirm reproduces the first-walk line, so it convicts on the first confirm and a
# reproduced red must not pay a second sample: the stub is invoked exactly twice.
test_reproduced_red_still_convicts_on_first_confirm() {
  new_case variant_reproduced
  fixture 1 "$(red_json "$X")"
  fixture 2 "$(red_json "$X")"
  run_gate
  [ "$RC" -eq 1 ] || fail "variant-reproduced: exit $RC, want 1"
  hard_section | grep -Fqx "$X" || fail "variant-reproduced: the reproduced line is not billed"
  [ "$(walks)" = 2 ] || fail "variant-reproduced: $(walks) walks, want exactly 2 (a reproduced red pays no second sample)"
  [ ! -e "$UXD/confirm2" ] || fail "variant-reproduced: a second-sample directory was created"
  expect_field reproduced 1
  expect_field variant 0
  expect_field variant_sample not-needed
  grep -Fq 'variant=0' "$UXD/confirm.summary" || fail "variant-reproduced: the summary changed shape for a reproduced red"
  record_invariant
}

# Case 4b: the confirm-only re-ask repeats the first-walk failure list, so it too must stop at
# the variant heading. The first answer scores an axis below 3 without naming evidence, which
# makes the gate re-ask; a reverted awk would print the one-sample variant there and invite the
# reviewer to ground a score in a line the gate itself keeps as evidence. The second answer
# passes, so a leaked variant is the only way this case can fail.
test_variant_not_presented_in_the_reask() {
  new_case variant_reask
  fixture 1 "$(red_json "$X")"
  fixture 2 "$(red_json "$Y")"
  review_fixture 1 "density: the confirm screen looks cramped
UX_SCORES: clarity=4 density=2 consistency=4 feedback=4 keyboard=4
UX_VERDICT: FAIL"
  run_gate
  [ "$RC" -eq 0 ] || fail "variant-reask: exit $RC, want 0 (the second answer accepts the confirm evidence): $(tail -3 "$T/$CASE.out" | tr '\n' ' ')"
  [ "$(walks)" = 3 ] || fail "variant-reask: $(walks) walks, want 3"
  [ "$(reviews)" = 2 ] || fail "variant-reask: $(reviews) reviews, want 2 (one re-ask)"
  prompt_has 2 "grounds that score only in failures the confirm walk could not reproduce" \
    || fail "variant-reask: the re-ask is not the confirm-only branch"
  if prompt_has 2 "$Y"; then fail "variant-reask: the re-ask presents the one-sample variant as a flake"; fi
  if prompt_has 2 "variant (seen in one confirm sample only"; then fail "variant-reask: the re-ask carries the variant heading"; fi
}

# Case 5: the invariant the brief names — CONFIRM_ONLY must never coexist with a conviction.
# Checked on the artifacts cases 1-4 wrote, so it cannot drift from what the gate produced.
test_confirm_only_never_with_a_conviction() {
  if [ -z "$(ls -A "$INV" 2>/dev/null)" ]; then
    test_variant_line_needs_second_sample
    test_variant_line_seen_twice_convicts
    test_second_sample_unavailable_keeps_the_red
    test_reproduced_red_still_convicts_on_first_confirm
  fi
  python3 - "$INV" <<'PY' || fail "invariant: CONFIRM_ONLY coexists with a non-empty confirm.hard"
import glob, json, os, sys
rows = []
for d in sorted(glob.glob(os.path.join(sys.argv[1], "*"))):
    name = os.path.basename(d)
    try:
        doc = json.load(open(os.path.join(d, "confirm.json")))
    except (OSError, ValueError) as exc:
        raise SystemExit("%s: unreadable confirm.json (%s)" % (name, exc))
    hard = open(os.path.join(d, "confirm.hard"), errors="replace").read().strip()
    rows.append((name, doc, bool(hard)))
    if doc.get("confirm_only") and hard:
        raise SystemExit("%s: confirm_only=true with a non-empty confirm.hard" % name)
    if doc.get("confirm_only") and doc.get("variant_confirmed"):
        raise SystemExit("%s: confirm_only=true with a confirmed variant" % name)
kinds = set()
for _name, doc, hard in rows:
    if doc.get("confirm_only"):
        kinds.add("confirm-only")
    if hard:
        kinds.add("convicted")
    if doc.get("reproduced"):
        kinds.add("reproduced")
if kinds != {"confirm-only", "convicted", "reproduced"}:
    raise SystemExit("cases 1-4 did not cover every state: %s" % sorted(kinds))
print("ok: %d artifacts, confirm-only and convicted never coexist" % len(rows))
PY
}

# Case 6: the confirm is a red-only cost. A green first walk is walked once and never creates
# either confirm directory.
test_no_extra_walk_when_confirm_is_clean() {
  new_case variant_green
  run_gate
  [ "$RC" -eq 0 ] || fail "variant-green: exit $RC, want 0"
  [ "$(walks)" = 1 ] || fail "variant-green: $(walks) walks, want exactly 1"
  [ ! -e "$UXD/confirm" ] || fail "variant-green: the confirm directory was created"
  [ ! -e "$UXD/confirm2" ] || fail "variant-green: a second-sample directory was created"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
  "$1" || exit 1
  pass "$1"
}

RAN=0
run test_variant_line_needs_second_sample
run test_variant_line_seen_twice_convicts
run test_rows_variant_with_volatile_metadata_convicts
run test_rows_reproduced_with_volatile_metadata_convicts_without_a_second_sample
run test_rows_variant_reversed_order_does_not_convict
run test_overlapping_rows_tokens_fail_closed_to_exact_comparison
run test_second_sample_unavailable_keeps_the_red
run test_reproduced_red_still_convicts_on_first_confirm
run test_variant_not_presented_in_the_reask
run test_confirm_only_never_with_a_conviction
run test_no_extra_walk_when_confirm_is_clean
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo "ux-gate confirm-variant contract: $RAN/$RAN cases passed"
