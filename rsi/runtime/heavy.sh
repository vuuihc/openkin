#!/bin/bash
# heavy.sh <cmd...> — run a CPU/memory-heavy command (build, full tests, tsc, go test) under a machine-wide semaphore.
# LLM "thinking" in the lanes is cheap and runs in parallel; builds/tests are not (16 GB Mac: three at once = load 300+).
# RSI_HEAVY_SLOTS (default 1) concurrent holders; a holder is a live pid; waits ≤ RSI_HEAVY_WAIT_MAX
# (default 30 min), then runs anyway. Re-entrant via RSI_HEAVY_HELD.
# RSI_HEAVY_WAIT_STRICT (the walk sets it) makes an expired wait fail closed with exit 125 instead of
# running anyway: the walk must hold the slot, and its caller reports the slot wait as its own
# "no verdict" rather than charging the queue to the walker (2026-11-23, PR #610).
# Reviewers (RSI_NO_HEAVY=1) never take or wait for the heavy slot: the gate already builds/tests; review must not queue behind it.
if [ -n "${RSI_NO_HEAVY:-}" ]; then echo "[heavy] disabled for reviewers (the gate runs builds/tests); read code and diffs only: $*" >&2; exit 3; fi
if [ -n "${RSI_HEAVY_HELD:-}" ]; then exec "$@"; fi
D="${RSI_STATE:-$HOME/.kin/worktrees/rsi-ceo/rsi/state}/heavy"; mkdir -p "$D"
SLOTS="${RSI_HEAVY_SLOTS:-1}"; waited=0; got=""
# Validated like ux-walk.sh's other bounds: a caller's non-number is the default, not a
# zero-second expiry or an arithmetic error in the loop.
WAIT_MAX="${RSI_HEAVY_WAIT_MAX:-1800}"; case "$WAIT_MAX" in ''|*[!0-9]*) WAIT_MAX=1800;; esac
while [ -z "$got" ]; do
  for i in $(seq 1 "$SLOTS"); do
    if mkdir "$D/slot$i" 2>/dev/null; then got="$D/slot$i"; break; fi
    old="$(cat "$D/slot$i/pid" 2>/dev/null || true)"
    if [ -n "$old" ] && ! kill -0 "$old" 2>/dev/null; then rm -rf "$D/slot$i"; continue; fi
    # slot dir exists but pid not written yet (race): leave it for a few seconds
  done
  [ -n "$got" ] && break
  sleep 4; waited=$((waited+4))
  if [ "$waited" -ge "$WAIT_MAX" ]; then
    if [ -n "${RSI_HEAVY_WAIT_STRICT:-}" ]; then
      echo "[heavy] waited ${waited}s for the machine-wide build/test slot; running nothing (RSI_HEAVY_WAIT_STRICT)" >&2
      exit 125
    fi
    echo "[heavy] waited ${waited}s, running anyway: $*" >&2
    exec env RSI_HEAVY_HELD=1 "$@"
  fi
done
echo $$ > "$got/pid"
[ $waited -gt 8 ] && echo "[heavy] waited ${waited}s for the machine-wide build/test slot" >&2
trap 'rm -rf "$got"' EXIT
RSI_HEAVY_HELD=1 "$@"; exit $?
