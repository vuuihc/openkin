#!/bin/bash
# heavy.sh <cmd...>  box-wide semaphore for builds/tests/tsc (RSI_HEAVY_SLOTS, default 2). Same idea as the Mac's runtime/heavy.sh.
[ -n "${RSI_HEAVY_HELD:-}" ] && exec "$@"
D=/workspace/box-lane/heavy; mkdir -p "$D"; SLOTS="${RSI_HEAVY_SLOTS:-2}"; waited=0; got=""
while [ -z "$got" ]; do
  for i in $(seq 1 "$SLOTS"); do
    if mkdir "$D/slot$i" 2>/dev/null; then got="$D/slot$i"; break; fi
    old="$(cat "$D/slot$i/pid" 2>/dev/null || true)"
    [ -n "$old" ] && ! kill -0 "$old" 2>/dev/null && rm -rf "$D/slot$i"
  done
  [ -n "$got" ] && break
  sleep 3; waited=$((waited+3)); [ $waited -ge 1500 ] && exec env RSI_HEAVY_HELD=1 "$@"
done
echo $$ > "$got/pid"; trap 'rm -rf "$got"' EXIT
RSI_HEAVY_HELD=1 "$@"; exit $?
