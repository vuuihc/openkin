#!/bin/bash
# test-ux-gate-rn-attribution.sh — an RN delivery is sent back only for a red its own diff can reach.
#
# 2026-11-27: PR #822 changed ui/src/components/Markdown.tsx (the console's shared
# renderer) and mobile-rn/src/screens/ConversationView.tsx. The gate's 1b0 pass had
# no row for either file and no vocabulary for mobile-rn/, so it printed
# `ATTRCLOSED unmapped path: mobile-rn/src/screens/ConversationView.tsx`, walked
# every journey, and J12's list-order artefact became #822's blocking red — a
# journey neither file can reach. A pure mobile-rn/ PR never runs this gate at all
# (merge.sh's UI_TOUCH needs a ui/src change); the damage is on mixed diffs.
#
# The contract this suite pins:
#   1. mobile-rn/ is not a console surface: it neither closes the attribution union
#      nor adds journeys (an RN change cannot render in the web console; its proof
#      is scripts/check.sh's mobile-rn job).
#   2. The shared markdown renderer has its own journeys.json row: the journeys
#      whose steps draw a message body or a table through ui/src/components/Markdown.tsx
#      (J3's reply paragraphs, J16's long answer table, J17's message-body tap).
#   3. Every other unmatched path still fails closed, exactly as before the rule.
#   4. scripts/check.sh names this suite, so the guard cannot land unwired.
#
# Hermetic: a temp control tree (common.sh + ux-gate.sh), a throwaway repo per case
# with origin/main, and stubs for the walk and the reviewer. npm/go/node/gh/curl are
# booby traps; the walker selection cases call the real node by absolute path and
# parse JSON only (no browser, no daemon, no build). Prints "ok: <case>" per case,
# exits non-zero on the first failure. The selection cases run first so a revert of
# journeys.json reds the case that names the row, not an earlier gate case.
# Set RSI_TEST_ONLY=<case name> to run one case (used for the red proof).
# GATE=<path> points every gate case at another ux-gate.sh (the red proof against
# origin/main).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
GATE="${GATE:-$REPO/rsi/runtime/ux-gate.sh}"
SLUG="ux-rn-attribution"; ITEM="R-ux-rn-attribution"; PR=831
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
REAL_NODE="$(type -P node || true)"

pass() { PASSED=$((PASSED+1)); echo "ok: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
PASSED=0
# A case that stops running reds the suite instead of shrinking the summary.
EXPECTED_CASES=6

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

# Walker stub: the same unrelated J12 red on the first and the confirm walk. It
# ignores the journey selector, so the gate's attribution decision is the only
# thing that can keep this line from convicting.
WALK_STUB="$T/bin/walk.sh"
cat > "$WALK_STUB" <<'SH'
#!/bin/bash
set -u
dir="$1"; printf '%s\n' "$dir" >> "$WALKS_LOG"
mkdir -p "$dir"
printf '{"hardFail":["J12/mac: the list order changed after a session switch"],"screens":[{"journey":"J12","name":"list-1100","lint":{"smallTapTargets":0}}]}\n' > "$dir/walk.json"
printf 'png\n' > "$dir/J12-mac-1-list.png"
SH
chmod +x "$WALK_STUB"

# Reviewer stub: one passing rubric per call; a call is one line in $REVIEWS_LOG.
REVIEW_STUB="$T/bin/review.sh"
cat > "$REVIEW_STUB" <<'SH'
#!/bin/bash
set -u
printf '%s\n' "$1" >> "$REVIEWS_LOG"
cat <<'EOF'
Nothing in the diff regresses the console.
UX_SCORES: clarity=4 density=4 consistency=4 feedback=4 keyboard=4
UX_VERDICT: PASS
EOF
SH
chmod +x "$REVIEW_STUB"
export WALK_STUB REVIEW_STUB

new_case() {
  CASE="$1"
  ST="$T/$CASE.state"; LOG="$T/$CASE.walks.log"; RLOG="$T/$CASE.reviews.log"
  rm -rf "$ST" "$LOG" "$RLOG"; mkdir -p "$ST"
  SHOTS="$ST/shots/$SLUG/journeys"; UXD="$ST/ux/$SLUG"; BODY="$ST/merge/$SLUG.ux.txt"
  : > "$LOG"; : > "$RLOG"
}

# A throwaway repo whose seed commit (origin/main) carries the branch's own
# journeys.json, so a mutant applied to that file is what the gate reads. The
# changed paths then land on rsi/test and are the PR's diff.
G() { /usr/bin/git -C "$WT_G" -c user.email=owner@example.com -c user.name=rn-attr \
        -c commit.gpgsign=false "$@"; }
mkwt() { # <name> <changed path>...
  WT_G="$T/$1.wt"; shift
  rm -rf "$WT_G"; mkdir -p "$WT_G/rsi/runtime/ux"
  cp "$REPO/rsi/runtime/ux/journeys.json" "$WT_G/rsi/runtime/ux/journeys.json"
  printf 'seed\n' > "$WT_G/README"
  G init -q
  G add -A
  G commit -qm seed
  G update-ref refs/remotes/origin/main HEAD
  G checkout -q -b rsi/test
  local p
  for p in "$@"; do
    mkdir -p "$WT_G/$(dirname "$p")"
    printf 'changed for the fixture\n' > "$WT_G/$p"
  done
  G add -A
  G commit -qm change
}

run_gate() {
  RSI_CTRL="$CTRL" RSI_UX_STATE="$ST" RSI_UX_COOLDOWN_MIN=0 \
  RSI_UX_REVIEW_CMD='bash "$REVIEW_STUB" "$1"' \
  RSI_UX_WALK_CMD='bash "$WALK_STUB" "$1" "${2:-}"' \
  WALKS_LOG="$LOG" REVIEWS_LOG="$RLOG" \
    bash "$CTRL/rsi/runtime/ux-gate.sh" "$WT_G" "$SLUG" "$ITEM" "$PR" deadbeef1234 reviewer \
    > "$T/$CASE.out" 2>&1
  RC=$?
}
walks() { wc -l < "$LOG" | tr -d ' '; }

# --- walker selection: the same vocabulary, before --base/playwright/Chrome ---------------
select_walk() { # <--files PATH>: resolved ids; refusal on stderr
  "$REAL_NODE" "$REPO/rsi/runtime/ux/walk.mjs" --select \
    --spec "$REPO/rsi/runtime/ux/journeys.json" "$@" 2>"$T/select.err"
}

test_pure_rn_changed_file_list_selects_no_journey() {
  case_name="test_pure_rn_changed_file_list_selects_no_journey"
  printf 'mobile-rn/src/screens/ConversationView.tsx\n' > "$T/rn-only.txt"
  out="$(select_walk --files "$T/rn-only.txt")"; rc=$?
  [ "$rc" -eq 2 ] || fail "$case_name: exit $rc, want 2 (refusal) (out: $out)"
  [ -z "$out" ] || fail "$case_name: printed journey ids for a diff that cannot reach the console: $out"
  [ "$(wc -l < "$T/select.err" | tr -d ' ')" = 1 ] \
    || fail "$case_name: stderr is not one line: $(cat "$T/select.err")"
  grep -Fq 'cannot change the console' "$T/select.err" \
    || fail "$case_name: the refusal does not name the reason: $(cat "$T/select.err")"
  pass "$case_name"
}

test_mixed_changed_file_list_selects_only_the_renderer_journeys() {
  case_name="test_mixed_changed_file_list_selects_only_the_renderer_journeys"
  printf '%s\n' \
    'mobile-rn/src/screens/ConversationView.tsx' \
    'ui/src/components/Markdown.tsx' > "$T/rn-renderer.txt"
  out="$(select_walk --files "$T/rn-renderer.txt")"; rc=$?
  [ "$rc" -eq 0 ] || fail "$case_name: exit $rc ($(cat "$T/select.err"))"
  got="$(printf '%s\n' "$out" | sort | tr '\n' ' ')"
  [ "$got" = 'J16 J17 J3 ' ] \
    || fail "$case_name: got '$got', want only the shared renderer's J3 J16 J17"
  for banned in J9 J10 J11 J12; do
    printf '%s\n' "$out" | grep -qx "$banned" \
      && fail "$case_name: $banned was selected although no file in the list can reach it"
  done
  pass "$case_name"
}

# --- cases -----------------------------------------------------------------------------------

# The #822 shape: RN screen + shared renderer. The reproduced J12 red is outside
# the renderer's journeys, so it is recorded as evidence and the PR passes.
test_mixed_rn_renderer_is_not_convicted_by_an_unrelated_journey() {
  case_name="test_mixed_rn_renderer_is_not_convicted_by_an_unrelated_journey"
  new_case mixed_rn_renderer
  mkwt mixed_rn_renderer \
    mobile-rn/src/screens/ConversationView.tsx \
    ui/src/components/Markdown.tsx
  run_gate
  [ "$RC" -eq 0 ] || fail "$case_name: exit $RC, want 0 ($(tail -4 "$T/$CASE.out" | tr '\n' ' '))"
  [ ! -s "$BODY" ] || fail "$case_name: a UX sendback body was written for a red the diff cannot reach"
  [ "$(walks)" = 2 ] || fail "$case_name: $(walks) walks, want the first and its confirm (the red must be reproduced, not flaked)"
  grep -Fq 'reproduced=1' "$T/$CASE.out" \
    || fail "$case_name: the confirm walk did not reproduce the J12 red, so outside.txt would prove nothing"
  grep -Fq 'J12/mac:' "$UXD/outside.txt" 2>/dev/null \
    || fail "$case_name: the reproduced J12 red is not recorded in outside.txt as evidence"
  if grep -Fq 'ATTRCLOSED' "$UXD/attributed.txt" 2>/dev/null; then
    fail "$case_name: the attribution still failed closed: $(cat "$UXD/attributed.txt")"
  fi
  pass "$case_name"
}

# mobile-rn/ must never enter the union: the union is exactly the markdown row's
# journeys, and the RN path neither closes it nor contributes an id.
test_rn_path_never_closes_the_attribution_union() {
  case_name="test_rn_path_never_closes_the_attribution_union"
  new_case rn_union
  mkwt rn_union \
    mobile-rn/src/screens/ConversationView.tsx \
    ui/src/components/Markdown.tsx
  run_gate
  attr="$(sed -n 1p "$UXD/attributed.txt" 2>/dev/null || true)"
  [ -n "$attr" ] || fail "$case_name: the gate wrote no attributed.txt"
  case "$attr" in
    ATTRCLOSED*) fail "$case_name: mobile-rn/ closed the union: $attr" ;;
  esac
  [ "$attr" = "ATTRJ=J3,J16,J17" ] \
    || fail "$case_name: attributed '$attr', want the shared renderer's row ATTRJ=J3,J16,J17"
  pass "$case_name"
}

# The doctrine survives: one genuinely unmapped non-surface path beside the same
# renderer still makes the same reproduced red convict. The two fixtures differ
# only by internal/api/tasks.go, so this is the probe that the case above did not
# pass by weakening the fail-closed rule.
test_a_genuinely_unmapped_path_still_fails_closed() {
  case_name="test_a_genuinely_unmapped_path_still_fails_closed"
  new_case unmapped_path
  mkwt unmapped_path \
    internal/api/tasks.go \
    ui/src/components/Markdown.tsx
  run_gate
  [ "$RC" -eq 1 ] || fail "$case_name: exit $RC, want 1 (a sendback) ($(tail -4 "$T/$CASE.out" | tr '\n' ' '))"
  grep -Fq 'J12/mac:' "$BODY" 2>/dev/null \
    || fail "$case_name: the reproduced J12 red is not in the sendback body"
  attr="$(sed -n 1p "$UXD/attributed.txt" 2>/dev/null || true)"
  case "$attr" in
    ATTRCLOSED*internal/api/tasks.go*) ;;
    *) fail "$case_name: want ATTRCLOSED naming internal/api/tasks.go, got '$attr'" ;;
  esac
  [ ! -s "$UXD/outside.txt" ] \
    || fail "$case_name: a fail-closed run recorded the red as outside: $(cat "$UXD/outside.txt")"
  pass "$case_name"
}

# AGENTS §12: a new suite nobody wires is a green light for a regression.
test_check_sh_names_this_suite() {
  case_name="test_check_sh_names_this_suite"
  grep -Fq 'rsi/runtime/tests/test-ux-gate-rn-attribution.sh' "$REPO/scripts/check.sh" \
    || fail "$case_name: check.sh: the shell job does not name test-ux-gate-rn-attribution.sh"
  pass "$case_name"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
  "$1" || exit 1
}

RAN=0
run test_pure_rn_changed_file_list_selects_no_journey
run test_mixed_changed_file_list_selects_only_the_renderer_journeys
run test_mixed_rn_renderer_is_not_convicted_by_an_unrelated_journey
run test_rn_path_never_closes_the_attribution_union
run test_a_genuinely_unmapped_path_still_fails_closed
run test_check_sh_names_this_suite
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
# The literal pins a full run; a focused run (RSI_TEST_ONLY) is the red-proof seam the
# mutant entries and red-first use, so it is exempt from the total but not from running.
if [ -z "$ONLY" ]; then
  [ "$RAN" -eq "$EXPECTED_CASES" ] \
    || fail "ran $RAN cases, expected $EXPECTED_CASES (a case was skipped or deleted)"
  [ "$PASSED" -eq "$EXPECTED_CASES" ] \
    || fail "passed $PASSED cases, expected $EXPECTED_CASES"
fi
echo "ux-gate rn attribution contract: $PASSED/$RAN cases passed"
