#!/bin/bash
# test-screenshots-obligation.sh — MANDATE 5 must reach the phone client.
#
# merge.sh's inline screenshot gate matched `^ui/src/.*\.tsx$` only, so a PR that changed
# only mobile-rn screens reached the gate and the strong review with no screenshot obligation.
# rn-approval-dock (2026-11-28) wrote `Screenshots: none: not visible — no ui/ change` while
# changing mobile-rn/src/screens/ConversationView.tsx; the reviewer spent a round on it.
# The obligation is one helper now (runtime/screenshots-obligation.sh): the ui/src rule
# unchanged, plus every hand-written phone .tsx under mobile-rn/src/ or mobile-rn/app/ —
# screens, native modules, layout primitives and app routes alike — and an RN change may not
# waive itself as invisible; a named capture gap still passes.
#
# Hermetic: mktemp dirs, no gh, no network, no model. Prints "PASS <case>" per case.
# Set RSI_TEST_ONLY=<case name> to run one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"
ROOT="$(cd "$RSI/.." && pwd)"
OBL="$RSI/runtime/screenshots-obligation.sh"
MERGE="$RSI/runtime/merge.sh"
CHECK="$ROOT/scripts/check.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
RC=0; OUT=""
pass() { echo "PASS $*"; }
fail() { echo "FAIL ${CASE:-?}: $*" >&2; exit 1; }
run() { if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi; CASE="$1"; "$1" || exit 1; pass "$1"; }

paths() { printf '%s\n' "$@" > "$T/paths"; }
body() { printf '%s\n' "$*" > "$T/body"; }
shots_empty() { rm -rf "$T/shots"; mkdir -p "$T/shots"; }
shots_one() { rm -rf "$T/shots"; mkdir -p "$T/shots"; : > "$T/shots/390.png"; }
oblig() { OUT="$(bash "$OBL" "$T/paths" "$T/body" "$T/shots" 2>&1)"; RC=$?; }

test_ui_change_without_evidence_fails() {
  paths ui/src/components/Foo.tsx
  body "A console change with no capture and no Screenshots line."
  shots_empty
  oblig
  [ "$RC" -ne 0 ] || fail "ui/no-evidence: accepted ($OUT)"
  # Byte-identical to the old inline gate's sentence, with the shots path substituted.
  local want="SHOTS_FAIL: UI .tsx changed but no screenshots in $T/shots/ and no 'Screenshots:' line with a link/image or 'none: <reason>' in the PR body (MANDATE 5). Capture 390x844, 820x1180 and 1100x760 before/after, or state why nothing is visible."
  [ "$OUT" = "$want" ] || fail "ui/no-evidence: verdict drifted from the old sentence: $OUT"
}

test_ui_change_honest_none_passes() {
  paths ui/src/components/Foo.tsx
  body "Screenshots: none: no console surface shipped in this round"
  shots_empty
  oblig
  [ "$RC" -eq 0 ] || fail "ui/none: refused an honest reason ($OUT)"
  case "$OUT" in SHOTS_OK:*) ;; *) fail "ui/none: verdict '$OUT'" ;; esac
}

test_ui_change_with_captures_passes() {
  paths ui/src/components/Foo.tsx
  body "No body line."
  shots_one
  oblig
  [ "$RC" -eq 0 ] || fail "ui/captures: refused a non-empty shots dir ($OUT)"
}

test_ui_test_only_change_has_no_obligation() {
  paths ui/src/components/Foo.dom.test.tsx
  body "No body line."
  shots_empty
  oblig
  [ "$RC" -eq 0 ] || fail "ui/test-only: obligation fired ($OUT)"
  case "$OUT" in *"no user-visible surface changed"*) ;; *) fail "ui/test-only: verdict '$OUT'" ;; esac
}

test_rn_screen_change_without_line_fails() {
  paths mobile-rn/src/screens/ConversationView.tsx
  body "No body line."
  shots_empty
  oblig
  [ "$RC" -ne 0 ] || fail "rn/no-line: an RN screen change reached the gate uncaptured ($OUT)"
  case "$OUT" in
    "SHOTS_FAIL: Phone .tsx changed but no screenshots in $T/shots/ "*) ;;
    *) fail "rn/no-line: verdict '$OUT' does not name the phone" ;;
  esac
}

test_rn_invisibility_waiver_fails() {
  # The measured rn-approval-dock major 2, verbatim.
  paths mobile-rn/src/screens/ConversationView.tsx
  body "Screenshots: none: not visible — no ui/ change"
  shots_empty
  oblig
  [ "$RC" -ne 0 ] || fail "rn/invisible: an untrue phone waiver passed ($OUT)"
  case "$OUT" in
    *"user-visible on the phone"*) ;;
    *) fail "rn/invisible: verdict '$OUT' does not explain the gap" ;;
  esac
}

test_rn_named_capture_gap_passes() {
  paths mobile-rn/src/screens/ConversationView.tsx
  body "Screenshots: none: needs a simulator capture; capture floor not met on this host"
  shots_empty
  oblig
  [ "$RC" -eq 0 ] || fail "rn/gap: refused an honest capture gap ($OUT)"
}

test_rn_model_only_change_has_no_obligation() {
  paths mobile-rn/src/list/listModel.ts
  body "No body line."
  shots_empty
  oblig
  [ "$RC" -eq 0 ] || fail "rn/model: a non-visual change was obliged ($OUT)"
}

test_rn_test_and_mutant_files_have_no_obligation() {
  paths mobile-rn/src/screens/Conversation.visual.test.tsx \
        mobile-rn/src/screens/screens.mutants.json
  body "No body line."
  shots_empty
  oblig
  [ "$RC" -eq 0 ] || fail "rn/test-files: test/mutant files were obliged ($OUT)"
}

test_rn_layout_only_change_without_line_fails() {
  # A layout primitive renders too; the old matcher let mobile-rn/src/layout through.
  paths mobile-rn/src/layout/SplitListLayout.tsx
  body "No body line."
  shots_empty
  oblig
  [ "$RC" -ne 0 ] || fail "rn/layout-no-line: a layout .tsx reached the gate uncaptured ($OUT)"
  case "$OUT" in
    "SHOTS_FAIL: Phone .tsx changed but no screenshots in $T/shots/ "*) ;;
    *) fail "rn/layout-no-line: verdict '$OUT' does not name the phone" ;;
  esac
}

test_rn_layout_only_invisibility_waiver_fails() {
  # The same untrue waiver that cost the rn-approval-dock round, on a layout file.
  paths mobile-rn/src/layout/SplitListLayout.tsx
  body "Screenshots: none: not visible — no ui/ change"
  shots_empty
  oblig
  [ "$RC" -ne 0 ] || fail "rn/layout-invisible: an untrue phone waiver passed ($OUT)"
  case "$OUT" in
    *"user-visible on the phone"*) ;;
    *) fail "rn/layout-invisible: verdict '$OUT' does not explain the gap" ;;
  esac
}

test_rn_layout_named_capture_gap_passes() {
  paths mobile-rn/src/layout/SplitListLayout.tsx
  body "Screenshots: none: needs a simulator capture; capture floor not met on this host"
  shots_empty
  oblig
  [ "$RC" -eq 0 ] || fail "rn/layout-gap: refused an honest capture gap ($OUT)"
}

test_rn_layout_non_tsx_module_has_no_obligation() {
  # Pure logic under src/layout carries no surface of its own; only .tsx is obliged.
  paths mobile-rn/src/layout/split.ts mobile-rn/src/layout/useListWidth.ts
  body "No body line."
  shots_empty
  oblig
  [ "$RC" -eq 0 ] || fail "rn/layout-module: a non-visual .ts module was obliged ($OUT)"
  case "$OUT" in
    *"no user-visible surface changed"*) ;;
    *) fail "rn/layout-module: verdict '$OUT'" ;;
  esac
}

test_merge_block_holds_on_rn_waiver() {
  # Run merge.sh's real step-3 block with stubs, not just a grep: an untrue RN waiver
  # must reach sendback with the hold category, and a clean change must fall through.
  local d="$T/block"; rm -rf "$d"; mkdir -p "$d/state/merge"
  sed -n '/^# 3\. MANDATE 5/,/^fi$/p' "$MERGE" > "$d/block.sh"
  [ -s "$d/block.sh" ] || fail "merge: the MANDATE 5 block is not extractable"
  (
    STATE="$d/state"; RSI_DIR="$RSI"; SLUG="conv"; ITEM="R-test"
    CH="mobile-rn/src/screens/ConversationView.tsx"
    BODY="Screenshots: none: not visible — no ui/ change"
    sendback() { printf '%s\n' "$*" > "$d/sendback.args"; }
    . "$d/block.sh"
    : > "$d/fell-through"
  )
  [ -e "$d/fell-through" ] && fail "merge block: an untrue RN waiver fell through the gate"
  grep -q 'hold-screenshots' "$d/sendback.args" 2>/dev/null \
    || fail "merge block: no hold-screenshots sendback"
  grep -q 'missing screenshots' "$d/sendback.args" 2>/dev/null \
    || fail "merge block: sendback category drifted"
  grep -q 'user-visible on the phone' "$d/state/merge/conv.err" 2>/dev/null \
    || fail "merge block: the helper's reason did not reach the err file"
  [ ! -e "$d/state/merge/conv.shot-paths" ] || fail "merge block: temp path file left behind"
  [ ! -e "$d/state/merge/conv.shot-body" ] || fail "merge block: temp body file left behind"
  # A non-visible change is not held: the block only holds on a failing verdict.
  rm -f "$d/state/merge/conv.err"; : > "$d/state/merge/keep"
  (
    STATE="$d/state"; RSI_DIR="$RSI"; SLUG="clean"; ITEM="R-test"
    CH="ui/src/components/Foo.dom.test.tsx"; BODY=""
    sendback() { printf '%s\n' "$*" > "$d/sendback-clean.args"; }
    . "$d/block.sh"
    : > "$d/fell-through-clean"
  )
  [ -e "$d/fell-through-clean" ] || fail "merge block: a test-only change was held"
  [ ! -e "$d/sendback-clean.args" ] || fail "merge block: a test-only change called sendback"
}

test_merge_calls_the_helper() {
  local hits
  hits="$(grep -c 'screenshots-obligation\.sh' "$MERGE")"
  [ "$hits" -eq 1 ] || fail "merge: $hits screenshots-obligation call sites, want exactly 1"
  grep -q '"\$CH" > "\$SHOT_PATHS"' "$MERGE" \
    || fail "merge: the helper is not fed the changed-path list"
  grep -q '"\$STATE/shots/\$SLUG"' "$MERGE" \
    || fail "merge: the helper is not fed the local shots dir"
  ! grep -qF "'^ui/src/.*\.tsx$'" "$MERGE" \
    || fail "merge: the old inline ui/src-only condition is still there"
}

test_check_sh_runs_the_suite() {
  grep -q 'rsi/runtime/tests/test-screenshots-obligation\.sh' "$CHECK" \
    || fail "check.sh: the screenshots-obligation suite is not wired (AGENTS.md §12)"
}

# The worker contract calls the capture note a `## Screenshots` section. A heading has no
# colon, so the inline label matcher missed it and an honest `none:` paragraph under it was
# never read (rn-usage-i18n, 2026-11-28 08:40: RSI item R-shots-obligation-heading).
test_heading_section_none_passes() {
  paths mobile-rn/src/screens/ConversationView.tsx
  printf '%s\n' \
    '## Screenshots' \
    '' \
    'none: mem_avail 5402 MB < 6144 MB, swap_free 1272 MB < 2048 MB (capture floor 6144/2048, measured before writing this body).' \
    > "$T/body"
  shots_empty
  oblig
  [ "$RC" -eq 0 ] || fail "heading/none: refused an honest section reason ($OUT)"
  case "$OUT" in
    SHOTS_OK:*"mem_avail 5402 MB"*) ;;
    *) fail "heading/none: verdict '$OUT' does not name the reason" ;;
  esac
}

test_heading_section_link_passes() {
  paths ui/src/components/Foo.tsx
  printf '%s\n' \
    '## Screenshots' \
    '' \
    '390x844: https://example.com/390.png' \
    > "$T/body"
  shots_empty
  oblig
  [ "$RC" -eq 0 ] || fail "heading/link: refused a link under the heading ($OUT)"
  case "$OUT" in SHOTS_OK:*) ;; *) fail "heading/link: verdict '$OUT'" ;; esac
}

test_heading_section_short_none_fails() {
  paths ui/src/components/Foo.tsx
  printf '%s\n' '## Screenshots' '' 'none: too short' > "$T/body"
  shots_empty
  oblig
  [ "$RC" -ne 0 ] || fail "heading/short: a short section reason passed ($OUT)"
  case "$OUT" in
    *"at least 20 characters"*) ;;
    *) fail "heading/short: verdict '$OUT' is not the reason floor" ;;
  esac
}

test_heading_section_empty_fails() {
  paths ui/src/components/Foo.tsx
  printf '%s\n' '## Screenshots' '' '## Risk' > "$T/body"
  shots_empty
  oblig
  [ "$RC" -ne 0 ] || fail "heading/empty: an empty section passed ($OUT)"
  case "$OUT" in
    "SHOTS_FAIL: UI .tsx changed but no screenshots in $T/shots/ "*) ;;
    *) fail "heading/empty: verdict '$OUT' is not the no-usable-line sentence" ;;
  esac
  { [ "$RC" -eq 1 ] || [ "$RC" -eq 2 ]; } || fail "heading/empty: unexpected exit $RC"
}

test_heading_section_invisibility_waiver_fails() {
  paths mobile-rn/src/screens/ConversationView.tsx
  printf '%s\n' '## Screenshots' '' 'none: not visible — no ui/ change' > "$T/body"
  shots_empty
  oblig
  [ "$RC" -ne 0 ] || fail "heading/invisible: an untrue phone waiver passed ($OUT)"
  case "$OUT" in
    *"user-visible on the phone"*) ;;
    *) fail "heading/invisible: verdict '$OUT' does not explain the gap" ;;
  esac
}

run test_ui_change_without_evidence_fails
run test_ui_change_honest_none_passes
run test_ui_change_with_captures_passes
run test_ui_test_only_change_has_no_obligation
run test_rn_screen_change_without_line_fails
run test_rn_invisibility_waiver_fails
run test_rn_named_capture_gap_passes
run test_rn_model_only_change_has_no_obligation
run test_rn_test_and_mutant_files_have_no_obligation
run test_rn_layout_only_change_without_line_fails
run test_rn_layout_only_invisibility_waiver_fails
run test_rn_layout_named_capture_gap_passes
run test_rn_layout_non_tsx_module_has_no_obligation
run test_merge_block_holds_on_rn_waiver
run test_merge_calls_the_helper
run test_check_sh_runs_the_suite
run test_heading_section_none_passes
run test_heading_section_link_passes
run test_heading_section_short_none_fails
run test_heading_section_empty_fails
run test_heading_section_invisibility_waiver_fails
echo ALL-PASS
