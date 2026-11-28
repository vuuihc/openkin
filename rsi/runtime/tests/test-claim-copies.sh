#!/bin/bash
# test-claim-copies.sh — one rule, N copies: the gate names the copy the sweep missed.
#
# Why: #568 made the evidence-width rule executable in eight files, but the list
# was hard-coded, so the three copies it missed (the generated worker contract,
# the dogfooder walk, the merge gate's screenshot sendback) were found by a model
# review a round later — after a full gate. This suite drives
# rsi/runtime/claim-copies.py end to end against the shipped registry, on
# throwaway trees through its --root seam: a stale copy in a file nobody swept
# must red and be named, a swept file that drifts must red, an allowed file must
# pass while its unused allow entries are named on stderr only, and a replay of
# the three pre-#568 sentences must name exactly those three files. Cases 10-11
# pin the scarce-reset freeze group: a fifth unregistered copy reds even when it
# starts exact, and a swept copy reds when it drops the freeze.
#
# The negative half matters as much as the red half: today's three-width rule
# (the `... and ...` form and the `390/820/1100` slash form) must stay green in a
# file nobody swept, or the checker would red the next correct brief.
#
# Hermetic: temp dirs, no network, no state dirs. Prints "PASS <case>" per case
# and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CHECKER="$REPO/rsi/runtime/claim-copies.py"
REGISTRY="$REPO/rsi/runtime/claim-copies.json"
# The registry's swept set: the eight files #568 brought onto the three widths.
SWEPT=(
  rsi/roles/dogfooder.md
  rsi/roles/fixer.md
  rsi/roles/reviewer.md
  rsi/runtime/lane.sh
  rsi/runtime/screenshots-obligation.sh
  rsi/runtime/prompts/cloud-brief-template.md
  rsi/runtime/prompts/fill.md
  rsi/runtime/prompts/pulse-serial.md
)
# The scarce-reset freeze is a second swept set: any new copy of the rule must be
# registered here or the checker names it instead of letting it drift unwatched.
RESET_SWEPT=(
  rsi/MANDATE.md
  rsi/roles/director.md
  rsi/runtime/prompts/fill.md
  rsi/runtime/prompts/pulse-serial.md
)
# An allowed file that really matches a stale pattern on today's tree.
ALLOWED="rsi/runtime/ux-gate.sh"
STALE_LANE='For visible UI also save 390×844 and 1100×760 before/after screenshots'
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

[ -f "$CHECKER" ] || fail "checker missing: $CHECKER"
[ -f "$REGISTRY" ] || fail "registry missing: $REGISTRY"

seed() { # <dir> — the swept files, exactly as the tree carries them today
  local d="$1" rel
  for rel in "${SWEPT[@]}" "${RESET_SWEPT[@]}"; do
    mkdir -p "$d/$(dirname "$rel")"
    cp "$REPO/$rel" "$d/$rel" || fail "seed: cannot copy $rel"
  done
}

run_tree() { # <root> [checker args...] — stdout in OUT, stderr in ERR
  local root="$1"; shift
  OUT="$(python3 "$CHECKER" --root "$root" "$@" 2>"$T/stderr")"; RC=$?
  ERR="$(cat "$T/stderr")"
}

run_default() { # the --root default: this repo
  OUT="$(python3 "$CHECKER" 2>"$T/stderr")"; RC=$?
  ERR="$(cat "$T/stderr")"
}

# --- 1. a stale copy nobody swept is named, not just counted -----------------------------------
test_unregistered_copy_reds() {
  local tree="$T/unregistered"
  seed "$tree"
  mkdir -p "$tree/rsi/runtime/prompts"
  printf '%s\n%s\n' "$STALE_LANE" '1100×760 and 390×844 before/after' \
    > "$tree/rsi/runtime/prompts/new-brief.md"
  run_tree "$tree"
  [ "$RC" -eq 1 ] || fail "unregistered-copy-reds: exit $RC, want 1 ($ERR)"
  grep -qxF 'rsi/runtime/prompts/new-brief.md:1: stale copy of evidence-widths (not swept, not allowed)' <<<"$ERR" \
    || fail "unregistered-copy-reds: the new copy is not named: $ERR"
  # Each stale line is named at its own line number, and a line is one finding
  # however many stale patterns it matches.
  grep -qxF 'rsi/runtime/prompts/new-brief.md:2: stale copy of evidence-widths (not swept, not allowed)' <<<"$ERR" \
    || fail "unregistered-copy-reds: the reverse-order copy is not named: $ERR"
  [ "$(grep -c 'new-brief.md' <<<"$ERR")" -eq 2 ] \
    || fail "unregistered-copy-reds: want exactly two findings: $ERR"
  [ -z "$OUT" ] || fail "unregistered-copy-reds: a red run wrote to stdout: $OUT"
  pass unregistered-copy-reds
}

# --- 2. a swept file that loses the current rule is named --------------------------------------
test_drifted_swept_file_reds() {
  local tree="$T/drifted" target="rsi/roles/reviewer.md"
  seed "$tree"
  awk '{ gsub(/820/, ""); print }' "$tree/$target" > "$tree/$target.tmp" \
    && mv "$tree/$target.tmp" "$tree/$target" || fail "drifted: cannot edit $target"
  run_tree "$tree"
  [ "$RC" -eq 1 ] || fail "drifted-swept-file-reds: exit $RC, want 1 ($ERR)"
  grep -qxF "$target: swept file no longer carries evidence-widths" <<<"$ERR" \
    || fail "drifted-swept-file-reds: the drifted file is not named: $ERR"
  [ "$(grep -c 'swept file no longer carries' <<<"$ERR")" -eq 1 ] \
    || fail "drifted-swept-file-reds: another swept file was reported: $ERR"
  pass drifted-swept-file-reds
}

# --- 3. the three widths must share a line: spread across lines is drift -----------------------
test_widths_on_separate_lines_do_not_carry_the_rule() {
  local tree="$T/separate-lines" target="rsi/roles/fixer.md"
  seed "$tree"
  printf '%s\n' 'Evidence at 390 wide.' 'Evidence at 820 wide.' 'Evidence at 1100 wide.' \
    > "$tree/$target"
  run_tree "$tree"
  [ "$RC" -eq 1 ] || fail "widths-on-separate-lines: exit $RC, want 1 ($ERR)"
  grep -qxF "$target: swept file no longer carries evidence-widths" <<<"$ERR" \
    || fail "widths-on-separate-lines: the file is not named: $ERR"
  pass widths-on-separate-lines-do-not-carry-the-rule
}

# --- 4. an allowed file passes; an unused allow is named on stderr and still exits 0 -----------
test_allow_with_reason_passes_and_unused_allow_is_stderr_only() {
  local tree="$T/allowed"
  seed "$tree"
  mkdir -p "$tree/rsi/runtime"
  cp "$REPO/$ALLOWED" "$tree/$ALLOWED" || fail "allow: cannot copy $ALLOWED"
  run_tree "$tree"
  [ "$RC" -eq 0 ] || fail "allow-with-reason-passes: exit $RC, want 0 ($ERR)"
  [ -z "$OUT" ] || fail "allow-with-reason-passes: the checker wrote to stdout: $OUT"
  case "$ERR" in *ux-gate.sh*) fail "allow-with-reason-passes: an allowed file was reported: $ERR" ;; esac
  grep -qF 'unused allow: rsi/GOAL.md' <<<"$ERR" \
    || fail "allow-with-reason-passes: an unused allow entry is not named on stderr: $ERR"
  pass allow-with-reason-passes
}

# --- 5. today's rule in a file nobody swept stays green ---------------------------------------
# If either stale pattern matched the current form, every new brief would red.
test_current_sentence_in_a_new_file_is_green() {
  local tree="$T/current-new"
  seed "$tree"
  mkdir -p "$tree/rsi/runtime/prompts"
  printf '%s\n' 'Capture 390×844, 820×1180 and 1100×760 before/after; record 390/820/1100 in the body.' \
    > "$tree/rsi/runtime/prompts/new-brief.md"
  run_tree "$tree"
  [ "$RC" -eq 0 ] || fail "current-sentence-is-green: exit $RC, want 0; a stale pattern matched today's rule ($ERR)"
  [ -z "$OUT" ] || fail "current-sentence-is-green: the checker wrote to stdout: $OUT"
  pass current-sentence-in-a-new-file-is-green
}

# --- 6. the tests and state trees are never scanned -------------------------------------------
test_excluded_tests_and_state_are_not_scanned() {
  local tree="$T/excluded"
  seed "$tree"
  mkdir -p "$tree/rsi/runtime/tests" "$tree/rsi/state"
  printf '%s\n' "$STALE_LANE" > "$tree/rsi/runtime/tests/fixture.sh"
  printf '%s\n' "$STALE_LANE" > "$tree/rsi/state/notes.md"
  run_tree "$tree"
  [ "$RC" -eq 0 ] || fail "excluded-tests-and-state: exit $RC, want 0 ($ERR)"
  [ -z "$OUT" ] || fail "excluded-tests-and-state: the checker wrote to stdout: $OUT"
  pass excluded-tests-and-state-are-not-scanned
}

# --- 7. the real tree is green: every match on it is swept or allowed with a reason ------------
test_repo_tree_green() {
  run_default
  [ "$RC" -eq 0 ] || fail "repo-tree-green: exit $RC, want 0; a real match is neither swept nor allowed ($ERR)"
  [ -z "$OUT" ] || fail "repo-tree-green: the checker wrote to stdout: $OUT"
  pass repo-tree-green
}

# --- 8. the pre-#568 round replays red, naming exactly the three files it shipped --------------
# The three sentences are restored exactly as rsi/state/sendback/done/evidence-contract-095924.md
# quoted them, so the proof is the round's own regression, not a fabricated one.
test_pre_568_round_replays_red() {
  local tree="$T/pre568" rel
  seed "$tree"
  python3 - "$tree" <<'PY' || fail "pre-568: cannot restore the old sentences"
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
edits = (
    ("rsi/runtime/lane.sh", "390×844, 820×1180 and 1100×760", "390×844 and 1100×760"),
    ("rsi/runtime/prompts/fill.md", "390×844, 820×1180 and 1100×760", "390×844 and 1100×760"),
    ("rsi/runtime/screenshots-obligation.sh", "390x844, 820x1180 and 1100x760", "390x844 and 1100x760"),
)
for rel, current, stale in edits:
    path = root / rel
    text = path.read_text(encoding="utf-8")
    if text.count(current) != 1:
        raise SystemExit("%s: expected one current sentence, found %d" % (rel, text.count(current)))
    path.write_text(text.replace(current, stale), encoding="utf-8")
PY
  grep -Fq 'For visible UI also save 390×844 and 1100×760 before/after screenshots' "$tree/rsi/runtime/lane.sh" \
    || fail "pre-568: lane.sh does not carry the old sentence"
  grep -Fq 'open `/` at 390×844 and 1100×760 and walk F1–F5' "$tree/rsi/runtime/prompts/fill.md" \
    || fail "pre-568: fill.md does not carry the old sentence"
  grep -Fq 'Capture 390x844 and 1100x760 before/after' "$tree/rsi/runtime/screenshots-obligation.sh" \
    || fail "pre-568: the helper does not carry the old sentence"
  run_tree "$tree"
  [ "$RC" -eq 1 ] || fail "pre-568-round-replays-red: exit $RC, want 1 ($ERR)"
  [ -z "$OUT" ] || fail "pre-568-round-replays-red: a red run wrote to stdout: $OUT"
  [ "$(printf '%s\n' "$ERR" | grep -c ': swept file no longer carries evidence-widths')" -eq 3 ] \
    || fail "pre-568-round-replays-red: want exactly three named files: $ERR"
  for rel in rsi/runtime/lane.sh rsi/runtime/prompts/fill.md rsi/runtime/screenshots-obligation.sh; do
    grep -qF "$rel: swept file no longer carries evidence-widths" <<<"$ERR" \
      || fail "pre-568-round-replays-red: $rel is not named: $ERR"
  done
  pass pre-568-round-replays-red
}

# --- 9. an allow without a reason is a registry error, not a silent pass -----------------------
test_allow_without_a_reason_is_a_registry_error() {
  local tree="$T/bad-registry" bad="$T/bad-registry.json"
  seed "$tree"
  python3 - "$REGISTRY" "$bad" <<'PY' || fail "bad-registry: cannot build the fixture"
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
data["groups"][0]["allow"][0]["reason"] = ""
json.dump(data, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
PY
  run_tree "$tree" --registry "$bad"
  [ "$RC" -eq 2 ] || fail "allow-without-reason: exit $RC, want 2 ($ERR)"
  grep -qF 'no reason' <<<"$ERR" || fail "allow-without-reason: the registry error is not explained: $ERR"
  pass allow-without-reason-is-a-registry-error
}

# --- 10. an unregistered fifth copy of the reset freeze is named ------------------------------
# The incident rule is prompt/policy text. A fifth CEO copy added later must not
# drift unwatched: even if it starts as the exact current sentence, being outside
# the swept set is itself red so the sweep has to register or explicitly allow it.
test_unregistered_reset_copy_reds() {
  local tree="$T/unregistered-reset"
  seed "$tree"
  mkdir -p "$tree/rsi/runtime/prompts"
  grep -m1 'Codex Full reset and other external scarce assets' "$REPO/rsi/MANDATE.md" | sed 's/^- //' \
    > "$tree/rsi/runtime/prompts/new-ceo-prompt.md"
  run_tree "$tree"
  [ "$RC" -eq 1 ] || fail "unregistered-reset-copy-reds: exit $RC, want 1 ($ERR)"
  grep -qxF 'rsi/runtime/prompts/new-ceo-prompt.md:1: stale copy of scarce-reset-freeze (not swept, not allowed)' <<<"$ERR" \
    || fail "unregistered-reset-copy-reds: the fifth copy is not named: $ERR"
  [ -z "$OUT" ] || fail "unregistered-reset-copy-reds: a red run wrote to stdout: $OUT"
  pass unregistered-reset-copy-reds
}

# --- 11. a swept reset copy that loses the freeze is named ------------------------------------
test_drifted_reset_swept_file_reds() {
  local tree="$T/drifted-reset" target="rsi/MANDATE.md"
  seed "$tree"
  sed 's/expiry does not create demand/expiry creates demand/' "$tree/$target" > "$tree/$target.tmp" \
    && mv "$tree/$target.tmp" "$tree/$target" || fail "drifted-reset: cannot edit $target"
  run_tree "$tree"
  [ "$RC" -eq 1 ] || fail "drifted-reset-swept-file-reds: exit $RC, want 1 ($ERR)"
  grep -qxF "$target: swept file no longer carries scarce-reset-freeze" <<<"$ERR" \
    || fail "drifted-reset-swept-file-reds: the drifted file is not named: $ERR"
  pass drifted-reset-swept-file-reds
}

run() { # <function> [<case name>] — RSI_TEST_ONLY accepts either spelling
  local fn="$1" name="${2:-$1}"
  [ -n "${RSI_TEST_ONLY:-}" ] && [ "$fn" != "$RSI_TEST_ONLY" ] && [ "$name" != "$RSI_TEST_ONLY" ] \
    && return 0
  "$fn" || exit 1
}
run test_unregistered_copy_reds
run test_drifted_swept_file_reds
run test_widths_on_separate_lines_do_not_carry_the_rule
run test_allow_with_reason_passes_and_unused_allow_is_stderr_only
run test_current_sentence_in_a_new_file_is_green
run test_excluded_tests_and_state_are_not_scanned
run test_repo_tree_green
run test_pre_568_round_replays_red
run test_allow_without_a_reason_is_a_registry_error
run test_unregistered_reset_copy_reds
run test_drifted_reset_swept_file_reds
echo "test-claim-copies: ALL-PASS"
