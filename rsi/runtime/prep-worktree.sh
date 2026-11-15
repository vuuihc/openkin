#!/bin/bash
# prep-worktree.sh <worktree> — make ui/node_modules available fast: APFS-clone (cp -c) from a worktree
# whose ui/package-lock.json is identical; fall back to `npm ci`. Idempotent.
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
WT="$1"
[ -f "$WT/ui/package-lock.json" ] || exit 0
[ -d "$WT/ui/node_modules" ] && exit 0
for d in "$WT_ROOT"/*/ui; do
  [ "$d" = "$WT/ui" ] && continue
  [ -d "$d/node_modules/.bin" ] && cmp -s "$d/package-lock.json" "$WT/ui/package-lock.json" || continue
  if cp -cR "$d/node_modules" "$WT/ui/node_modules" 2>/dev/null; then echo "node_modules cloned from $d"; exit 0; fi
  rm -rf "$WT/ui/node_modules"   # partial clone inside our own rsi worktree only
done
echo "npm ci in $WT/ui"; ( cd "$WT/ui" && npm ci --no-audit --no-fund )
