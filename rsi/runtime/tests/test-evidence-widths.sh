#!/bin/bash
# test-evidence-widths.sh — the loop's evidence rule has three widths, in every brief.
#
# Why: the merge gate (rsi/MANDATE.md, merge gate item 5) requires UI evidence at
# 390, 820 and 1100, and says the 820 shot must show the surface's real reading
# state. The documents that tell a worker, cloud agent, dogfooder, fixer and
# reviewer what to capture still asked for two widths, so the missing 820 shot was
# discovered at review — after a full gate and a model review. This suite makes a
# two-width brief red before the gate instead of at it.
#
# For every claim file it requires ONE line carrying all three widths in that
# file's own notation (`390x844` and `390×844` both count, as does the
# slash form `390/820/1100`), so a file that names 390 and 1100 but not 820 is
# named in the failure. The source of truth is read too: if a future edit drops
# 820 from rsi/MANDATE.md the rule has drifted, and this suite reds rather than
# silently redefining the rule to two widths.
#
# RSI_WIDTH_ROOT points the checker at another tree; the negative case below uses
# a temp copy with 820 deleted from one file. With the seam set the suite checks
# that copy only and never runs the negative case again, so it cannot recurse.
#
# Hermetic: temp dirs, no network. Prints "PASS <case>" per case and exits
# non-zero on failure, naming every claim file that is still short a width.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
ROOT="${RSI_WIDTH_ROOT:-$REPO}"
SOURCE_OF_TRUTH="rsi/MANDATE.md"
CLAIM_FILES=(
  rsi/runtime/prompts/cloud-brief-template.md
  rsi/runtime/prompts/pulse-serial.md
  rsi/runtime/prompts/fill.md
  rsi/roles/dogfooder.md
  rsi/roles/reviewer.md
  rsi/roles/fixer.md
  rsi/runtime/lane.sh
  rsi/runtime/screenshots-obligation.sh
)
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL $*" >&2; exit 1; }

# one_line_all_widths <file> — true when a single line names 390, 820 and 1100.
# Digits must not run into a larger number (1390 is not 390).
one_line_all_widths() {
  awk '/(^|[^0-9])390([^0-9]|$)/ && /(^|[^0-9])820([^0-9]|$)/ && /(^|[^0-9])1100([^0-9]|$)/ { found = 1 }
       END { exit !found }' "$1"
}

# missing_widths <file> — which of the three numbers the file never mentions.
missing_widths() {
  local f="$1" missing="" w
  for w in 390 820 1100; do
    grep -Eq "(^|[^0-9])$w([^0-9]|\$)" "$f" || missing="$missing $w"
  done
  printf '%s' "${missing# }"
}

# --- every claim file names all three widths on one line -----------------------
bad=()
for rel in "${CLAIM_FILES[@]}"; do
  path="$ROOT/$rel"
  if [ ! -f "$path" ]; then
    bad+=("$rel (missing file)")
    continue
  fi
  if one_line_all_widths "$path"; then
    echo "PASS claim-${rel##*/}"
  else
    miss="$(missing_widths "$path")"
    bad+=("$rel (no line names 390, 820 and 1100${miss:+; missing $miss})")
  fi
done

if ((${#bad[@]})); then
  echo "FAIL evidence widths: each file must name 390, 820 and 1100 on one line:" >&2
  printf '  %s\n' "${bad[@]}" >&2
  exit 1
fi

# --- the source of truth still states the three-width rule --------------------
grep -Fq '390/820/1100' "$ROOT/$SOURCE_OF_TRUTH" \
  || fail "$SOURCE_OF_TRUTH no longer names 390/820/1100; the evidence rule drifted from three widths"
echo "PASS source-of-truth-three-widths"

# A custom root is checked and nothing else: the negative case below points here.
if [ -n "${RSI_WIDTH_ROOT:-}" ]; then
  echo "PASS custom-root-three-widths"
  exit 0
fi

# --- negative case: deleting 820 from a copy must red and name that file -------
NEG="$T/root"
for rel in "${CLAIM_FILES[@]}" "$SOURCE_OF_TRUTH"; do
  mkdir -p "$NEG/$(dirname "$rel")"
  cp "$REPO/$rel" "$NEG/$rel"
done
TARGET="rsi/runtime/prompts/pulse-serial.md"
awk '{ gsub(/820/, ""); print }' "$NEG/$TARGET" > "$NEG/$TARGET.tmp"
mv "$NEG/$TARGET.tmp" "$NEG/$TARGET"
if out="$(RSI_WIDTH_ROOT="$NEG" bash "$HERE/test-evidence-widths.sh" 2>&1)"; then
  fail "missing-820-fails: checker exited 0"
fi
grep -q 'pulse-serial.md' <<<"$out" || fail "missing-820-fails: output does not name the file: $out"
grep -q '820' <<<"$out" || fail "missing-820-fails: output does not name the missing width: $out"
echo "PASS missing-820-fails"
