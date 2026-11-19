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
# sentence. This suite pins both prompts and proves the pin can go red.
#
# Cases 3 and 4 are negative fixtures: `missing` must refuse a copy of each
# prompt with its claim-check text removed, or the positive cases are vacuous.
#
# Hermetic: temp dir, no network, no state dirs. Prints "PASS <case>" per case
# and exits non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
FILL="$ROOT/rsi/runtime/prompts/fill.md"
TEMPLATE="$ROOT/rsi/runtime/prompts/cloud-brief-template.md"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

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

echo "test-fill-claim-check: ALL-PASS"
