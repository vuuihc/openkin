#!/bin/bash
# prep-worktree.sh <worktree> — make ui/ and desktop/ node_modules available fast: APFS-clone (cp -c) from a worktree
# whose install is fresh and whose package-lock.json is identical; fall back to `npm ci`. Idempotent.
# (scripts/check.sh also runs desktop tsc/tests.)
# "Installed" is decided by node-stamp.sh, not `[ -d node_modules ]`: that test also accepted a symlink
# into another worktree and an install made before the current lockfile, and skipped the repair for both.
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
source "$(cd "$(dirname "$0")" && pwd)/node-stamp.sh"
WT="$1"
rc=0
for sub in ui desktop; do
  pkg="$WT/$sub"
  [ -f "$pkg/package-lock.json" ] || continue
  state="$(node_stamp_state "$pkg")"
  [ "$state" = fresh ] && continue
  if [ "$state" = symlink ]; then
    echo "$sub/node_modules is a symlink; removing the link, never the tree it points at"
    rm -f "$pkg/node_modules" || { rc=1; continue; }
    [ -L "$pkg/node_modules" ] && { echo "cannot remove $sub/node_modules symlink"; rc=1; continue; }
  fi
  installed=0
  if [ ! -e "$pkg/node_modules" ]; then   # clone only into an empty slot, never over an existing install
    for d in "$WT_ROOT"/*/$sub; do
      [ "$d" = "$pkg" ] && continue
      [ "$(node_stamp_state "$d")" = fresh ] || continue
      [ -d "$d/node_modules/.bin" ] || continue
      cmp -s "$d/package-lock.json" "$pkg/package-lock.json" || continue
      if cp -cR "$d/node_modules" "$pkg/node_modules" 2>/dev/null && node_stamp_mark "$pkg"; then
        echo "$sub/node_modules cloned from $d"; installed=1; break
      fi
      rm -rf "$pkg/node_modules"   # partial clone inside our own rsi worktree only
    done
  fi
  [ $installed -eq 1 ] && continue
  node_stamp_ensure "$pkg" || rc=1
done
exit $rc
