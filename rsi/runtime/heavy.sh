#!/bin/bash
# heavy.sh <cmd...> — run a CPU/memory-heavy command (build, full tests, tsc, go test) under a machine-wide semaphore.
# LLM "thinking" in the lanes is cheap and runs in parallel; builds/tests are not (16 GB Mac: three at once = load 300+).
# RSI_HEAVY_SLOTS (default 1) concurrent holders; a holder is a live pid; waits ≤ 30 min, then runs anyway. Re-entrant via RSI_HEAVY_HELD.
if [ -n "${RSI_HEAVY_HELD:-}" ]; then exec "$@"; fi
D="${RSI_STATE:-$HOME/.kin/worktrees/rsi-ceo/rsi/state}/heavy"; mkdir -p "$D"
SLOTS="${RSI_HEAVY_SLOTS:-1}"; waited=0; got=""
while [ -z "$got" ]; do
  for i in $(seq 1 "$SLOTS"); do
    if mkdir "$D/slot$i" 2>/dev/null; then got="$D/slot$i"; break; fi
    old="$(cat "$D/slot$i/pid" 2>/dev/null || true)"
    if [ -n "$old" ] && ! kill -0 "$old" 2>/dev/null; then rm -rf "$D/slot$i"; continue; fi
    # slot dir exists but pid not written yet (race): leave it for a few seconds
  done
  [ -n "$got" ] && break
  sleep 4; waited=$((waited+4))
  [ $waited -ge 1800 ] && { echo "[heavy] waited 30 min, running anyway: $*" >&2; exec env RSI_HEAVY_HELD=1 "$@"; }
done
echo $$ > "$got/pid"
[ $waited -gt 8 ] && echo "[heavy] waited ${waited}s for the machine-wide build/test slot" >&2
trap 'rm -rf "$got"' EXIT
RSI_HEAVY_HELD=1 "$@"; exit $?
