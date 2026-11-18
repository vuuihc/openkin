#!/bin/bash
# test-mutants-restore.sh — a terminated mutants.py run restores the mutant it had applied.
#
# dispatch.sh kills a worker's process group at the time cap (SIGTERM), and
# lane.sh then commits every modified tracked file (`git add -u`). scripts/mutants.py
# restored the mutated file only in `finally`, which a default SIGTERM termination
# never reaches, so a kill inside the mutant window could commit the deliberate
# break (measured 2026-11-19 00:28 near-miss: the walk suite was ~5 minutes from
# the cap with a mutant applied). Hermetic: a temp tree, a test command that sleeps
# only while mutated, one SIGTERM, one byte comparison.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

[ -f "$REPO/scripts/mutants.py" ] || fail "scripts/mutants.py missing under $REPO"
printf 'ALPHA\n' > "$T/sample.txt"
cat > "$T/manifest.json" <<JSON
[
  {
    "label": "slow mutant",
    "file": "$T/sample.txt",
    "test": "grep -q BETA $T/sample.txt && exec sleep 10; exit 0",
    "old": "ALPHA",
    "new": "BETA"
  }
]
JSON

python3 "$REPO/scripts/mutants.py" "$T/manifest.json" --timeout 60 > "$T/run.log" 2>&1 &
pid=$!
applied=0
for _ in $(seq 1 200); do
  if grep -q BETA "$T/sample.txt" 2>/dev/null; then applied=1; break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
done
if [ "$applied" -ne 1 ]; then
  kill -KILL "$pid" 2>/dev/null || true
  cat "$T/run.log" 2>/dev/null
  fail "the mutant was never applied; nothing to restore"
fi

kill -TERM "$pid" 2>/dev/null || true
wait "$pid"; rc=$?

[ "$(cat "$T/sample.txt")" = "ALPHA" ] \
  || fail "SIGTERM left the mutant in the tree ($(cat "$T/sample.txt")); lane.sh's git add -u would commit it"
[ "$rc" -ne 0 ] || fail "a terminated run must not report success (exit $rc)"
grep -q "STOPPED" "$T/run.log" \
  || { cat "$T/run.log"; fail "the run did not say it restored the mutant"; }
echo "test-mutants-restore: ALL-PASS"
