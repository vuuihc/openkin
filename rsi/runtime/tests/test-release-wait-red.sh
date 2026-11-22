#!/bin/bash
# test-release-wait-red.sh — every new claim in release.sh's slot wait must be able to fail.
#
# The wait exists because a `heavy:` HOLD is a timing accident, not a property of the tree:
# on 2026-11-22 six merges sat unshipped while each patrol reading landed on a UX walk that
# ended minutes later. Four behaviours carry that fix — the wait budget, the re-read after a
# sleep, the GATE_WAIT record, and leaving the loop only on GO — and each one has a mutant
# here that must turn test-release-wait.sh red. scripts/mutants.py applies each, requires the
# test to fail, restores the file and proves the restore byte for byte.
#
# Hermetic and offline: the suite it breaks is stubbed (no node, no docker, no network).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MANIFEST="$HERE/release-wait.mutants.json"
[ -f "$REPO/scripts/mutants.py" ] || { echo "FAIL scripts/mutants.py missing under $REPO" >&2; exit 1; }
out="$(cd "$REPO" && python3 scripts/mutants.py "$MANIFEST" 2>&1)"; rc=$?
printf '%s\n' "$out"
[ "$rc" = 0 ] || { echo "FAIL release-wait mutants did not all go red" >&2; exit 1; }
grep -q '0 problem' <<<"$out" || { echo "FAIL mutants.py did not report 0 problems" >&2; exit 1; }
echo "all release-wait mutants red"
