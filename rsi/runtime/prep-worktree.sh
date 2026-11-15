#!/bin/bash
# prep-worktree.sh <worktree> — make ui/ and desktop/ node_modules available fast: APFS-clone (cp -c) from a worktree
# whose package-lock.json is identical; fall back to `npm ci`. Idempotent. (scripts/check.sh also runs desktop tsc/tests.)
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
WT="$1"
for sub in ui desktop; do
  [ -f "$WT/$sub/package-lock.json" ] || continue
  [ -d "$WT/$sub/node_modules" ] && continue
  done_=0
  for d in "$WT_ROOT"/*/$sub; do
    [ "$d" = "$WT/$sub" ] && continue
    [ -d "$d/node_modules/.bin" ] && cmp -s "$d/package-lock.json" "$WT/$sub/package-lock.json" || continue
    if cp -cR "$d/node_modules" "$WT/$sub/node_modules" 2>/dev/null; then echo "$sub/node_modules cloned from $d"; done_=1; break; fi
    rm -rf "$WT/$sub/node_modules"   # partial clone inside our own rsi worktree only
  done
  [ $done_ -eq 1 ] || { echo "npm ci in $WT/$sub"; ( cd "$WT/$sub" && npm ci --no-audit --no-fund ); }
done
