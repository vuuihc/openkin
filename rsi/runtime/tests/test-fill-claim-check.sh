#!/bin/bash
# test-fill-claim-check.sh — the prose-delivery claim check must be in both prompts.
#
# When a delivery is a sentence rather than behaviour (an rsi/GOAL.md line, an
# ADR, a PLAN.md, a story contract), the director must name the exact path:line
# that sentence asserts and one command that proves it today; the PR body
# answers with `Claim check:` and that command's literal output. The 2026-11-19
# retro measured 3 of 6 rework rounds as prose the tree contradicts, and the
# requirement itself was prose with no test: deleting fill.md's sentence left
# the gate green. The cloud/NAS brief template never asked for a claim check at
# all, so a prose row handed to an external agent arrived as an unverified
# sentence. This suite pins the prompt copies and proves the pin can go red.
# Cases 13-14 pin the scarce-reset freeze across MANDATE, director, fill and the
# legacy pulse prompt; deleting legacy pulse-serial.md itself is therefore red.
#
# Cases 3, 4, 6, 8, 10, 12 and 14 are negative fixtures: `missing` must refuse a copy
# of the relevant prompt with its required text removed, or the positive cases are vacuous.
# Case 5 pins the queue-dry fallback (fill.md §3b) and the dogfooder trigger:
# on 2026-11-21 deleting either left check.sh green, the silent-drop failure
# §3b exists to repair. Case 7 pins §2d (a signed story with open scope refills
# the queue): on 2026-11-25 deleting the section left every named test green
# while the only rule that refills the queue from signed stories was gone.
# Cases 9-10 pin §2's RN priority and cases 11-12 §2d's cell audit: the same
# day a fill read seven existing acceptance test files as coverage while list
# search, scroll, tool-row expand and virtualization had no code, and its report
# still led with the finished Astryx programme. Deleting either passage left
# every named test green (the gap #719 closed for §2d, one section earlier).
#
# Hermetic: temp dir, no network, no state dirs. Prints "PASS <case>" per case
# and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
FILL="$ROOT/rsi/runtime/prompts/fill.md"
TEMPLATE="$ROOT/rsi/runtime/prompts/cloud-brief-template.md"
PULSE="$ROOT/rsi/runtime/prompts/pulse-serial.md"
DIRECTOR="$ROOT/rsi/roles/director.md"
MANDATE_FILE="$ROOT/rsi/MANDATE.md"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
# Optional case group (`priority` / `audit`): every base case still runs, and one new
# passage's case is added. The red-first lane seam reverts fill.md and runs ONE command,
# and this script stops at the first failure, so each new passage needs a command whose
# first red names its own case.
MODE="${1:-all}"
case_wanted() { [ "$MODE" = all ] || [ "$MODE" = "$1" ]; }

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# missing <file> <label> <marker>... — non-zero when <file> lacks any <marker>,
# naming every absent one; zero only when all markers are present.
missing() {
  local f="$1" label="$2" m rc=0
  shift 2
  if [ ! -f "$f" ]; then
    echo "$label: no such file: $f" >&2
    return 1
  fi
  for m in "$@"; do
    if ! grep -qF -- "$m" "$f"; then
      echo "$label: absent marker: $m" >&2
      rc=1
    fi
  done
  return "$rc"
}

# --- 1. the director prompt carries the requirement (the pin; passes today) ---------------------
if ! missing "$FILL" "fill-prompt-carries-claim-check" \
    'Claim check:' 'path:line' 'not delivered'; then
  fail "fill-prompt-carries-claim-check"
fi
pass "fill-prompt-carries-claim-check"

# --- 2. the cloud brief template asks for it too ------------------------------------------------
if ! missing "$TEMPLATE" "cloud-template-carries-claim-check" \
    'Claim check:' 'path:line'; then
  fail "cloud-template-carries-claim-check"
fi
pass "cloud-template-carries-claim-check"

# --- 3. the check can go red: a fill.md copy without `Claim check:` is refused -------------------
sed 's/Claim check:/Check:/' "$FILL" > "$T/fill-negative.md"
if missing "$T/fill-negative.md" "fill-negative-fixture-is-refused" \
    'Claim check:' 'path:line' 'not delivered'; then
  fail "fill-negative-fixture-is-refused: the copy without 'Claim check:' still passed"
fi
pass "fill-negative-fixture-is-refused"

# --- 4. the check can go red: a template copy without the new bullet is refused -------------------
grep -v 'Claim check:' "$TEMPLATE" > "$T/template-negative.md"
if missing "$T/template-negative.md" "cloud-negative-fixture-is-refused" \
    'Claim check:' 'path:line'; then
  fail "cloud-negative-fixture-is-refused: the copy without the bullet still passed"
fi
pass "cloud-negative-fixture-is-refused"

# --- 5. the queue-dry fallback and the dogfooder trigger stay pinned ------------------------------
# A dry queue must dispatch a dogfood pass, not end the run ("queue dry" is not an exit).
DOGFOOD="$ROOT/rsi/roles/dogfooder.md"
QD_MARKERS=('## 3b. Queue dry is not an exit' '(no ready Astryx slice)' 'R-dogfood-' '6 小时' '一次性 daemon' '不碰 :7777')
if ! missing "$FILL" "fill-prompt-carries-queue-dry-fallback" "${QD_MARKERS[@]}"; then
  fail "fill-prompt-carries-queue-dry-fallback"
fi
pass "fill-prompt-carries-queue-dry-fallback"
if ! missing "$DOGFOOD" "dogfooder-card-carries-trigger" \
    'Runs when the queue is dry' '`rsi/runtime/prompts/fill.md` §3b' '6 hours'; then
  fail "dogfooder-card-carries-trigger"
fi
pass "dogfooder-card-carries-trigger"

# --- 6. the check can go red: a fill.md copy without §3b is refused -------------------------------
sed '/^## 3b\. Queue dry is not an exit$/,/^## 4\./d' "$FILL" > "$T/fill-no-3b.md"
if missing "$T/fill-no-3b.md" "queue-dry-negative-fixture-is-refused" "${QD_MARKERS[@]}"; then
  fail "queue-dry-negative-fixture-is-refused: the copy without §3b still passed"
fi
pass "queue-dry-negative-fixture-is-refused"

# --- 7. §2d (a signed story with open scope refills the queue) stays pinned ---------------------
# Without §2d the director prompt has no rule that turns a signed story's open
# scope into Queue rows, so lanes idle while approved work waits.
REFILL_MARKERS=('## 2d. A signed story with open scope refills the queue before any lane idles' 'docs/product/stories/registry.json' 'waits on #N' '**做** list only' '不做（各自去处）' "name it on STATUS.md's Parked list" "a person's subjective check" 'active claim')
if ! missing "$FILL" "fill-prompt-carries-signed-story-refill" "${REFILL_MARKERS[@]}"; then
  fail "fill-prompt-carries-signed-story-refill"
fi
pass "fill-prompt-carries-signed-story-refill"

# --- 8. the check can go red: a fill.md copy without §2d is refused ------------------------------
# Delete the §2d heading through its paragraph; the next `## ` heading stays.
awk '/^## 2d\./ {skip=1} /^## / && !/^## 2d\./ {skip=0} !skip' "$FILL" > "$T/fill-no-2d.md"
if missing "$T/fill-no-2d.md" "signed-story-refill-negative-fixture-is-refused" "${REFILL_MARKERS[@]}"; then
  fail "signed-story-refill-negative-fixture-is-refused: the copy without §2d still passed"
fi
pass "signed-story-refill-negative-fixture-is-refused"

# --- 9. §2's RN priority stays pinned ------------------------------------------------------------
# Without this paragraph the fill keeps reading the finished Astryx programme as
# the priority and leaves RN rows in the queue.
if case_wanted priority; then
  PRIORITY_MARKERS=('current priority: KIN-MOBILE-001' 'before any other non-P0 row' 'Do not open a report with')
  if ! missing "$FILL" "fill-prompt-carries-rn-priority" "${PRIORITY_MARKERS[@]}"; then
    fail "fill-prompt-carries-rn-priority"
  fi
  pass "fill-prompt-carries-rn-priority"

  # --- 10. the check can go red: a fill.md copy without §2's priority paragraph is refused -------
  # Delete the §2 heading and its priority paragraph; `Ethan expected the whole Astryx` stays.
  awk '/^## 2\. Pick one task/ {skip=1} /^Ethan expected the whole Astryx/ {skip=0} !skip' "$FILL" > "$T/fill-no-rn-priority.md"
  if missing "$T/fill-no-rn-priority.md" "rn-priority-negative-fixture-is-refused" "${PRIORITY_MARKERS[@]}"; then
    fail "rn-priority-negative-fixture-is-refused: the copy without the priority paragraph still passed"
  fi
  pass "rn-priority-negative-fixture-is-refused"
fi

# --- 11. §2d's cell audit stays pinned -----------------------------------------------------------
# An existing acceptance test file is not coverage: without these sentences the
# fill rows a story from its test files and leaves six-beat promises unimplemented.
if case_wanted audit; then
  AUDIT_MARKERS=('**An existing test file is not coverage.**' 'six-beat tables')
  if ! missing "$FILL" "fill-prompt-carries-cell-audit" "${AUDIT_MARKERS[@]}"; then
    fail "fill-prompt-carries-cell-audit"
  fi
  pass "fill-prompt-carries-cell-audit"

  # --- 12. the check can go red: a fill.md copy without §2d is refused for the audit too --------
  awk '/^## 2d\./ {skip=1} /^## / && !/^## 2d\./ {skip=0} !skip' "$FILL" > "$T/fill-no-2d-audit.md"
  if missing "$T/fill-no-2d-audit.md" "cell-audit-negative-fixture-is-refused" "${AUDIT_MARKERS[@]}"; then
    fail "cell-audit-negative-fixture-is-refused: the copy without §2d still passed"
  fi
  pass "cell-audit-negative-fixture-is-refused"
fi

# --- 13. the scarce-asset freeze reaches every CEO control copy -------------------------------
# 2026-11-27: the patrol consumed every Codex Full reset after treating renewable
# 5h pressure and expiry as spend triggers. The trigger is prompt/policy text, so
# all four control copies must carry the same prohibition, not only the incident note.
RESET_MARKERS=('Codex Full reset and other external scarce assets are never automatic' 'renewable 5h/window pressure means wait, reschedule, downgrade, or switch models' 'expiry does not create demand' 'weekly/5h usage' 'record the approval and readings before use' 'the last remaining one is never automatic' "one use requires Ethan's explicit single-use approval")
for reset_copy in "$MANDATE_FILE" "$DIRECTOR" "$FILL" "$PULSE"; do
  if ! missing "$reset_copy" "scarce-asset-freeze-$reset_copy" "${RESET_MARKERS[@]}"; then
    fail "scarce-asset-freeze-$reset_copy"
  fi
done
pass "scarce-asset-freeze-present-in-control-copies"

# --- 14. the check can go red: removing the freeze sentence is refused ---------------------
grep -v 'Codex Full reset and other external scarce assets are never automatic' "$FILL" > "$T/fill-no-reset-freeze.md"
if missing "$T/fill-no-reset-freeze.md" "reset-freeze-negative-fixture-is-refused" "${RESET_MARKERS[@]}"; then
  fail "reset-freeze-negative-fixture-is-refused: the copy without the freeze still passed"
fi
pass "reset-freeze-negative-fixture-is-refused"

echo "test-fill-claim-check: ALL-PASS"
