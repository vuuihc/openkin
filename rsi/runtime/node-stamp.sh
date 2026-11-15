# shellcheck shell=bash
# node-stamp.sh — one answer to "does this package dir's install match its own package-lock.json?"
#
# Why: three scripts used to treat `[ -d <pkg>/node_modules ]` as "installed". That is true for a
# symlink into another worktree (an install this tree does not own, shared by accident) and for an
# install older than the lockfile (one added dependency makes every existing worktree stale at
# once). Both produced tsc / vitest / build failures that looked like the PR's fault, and the gate
# never ran the repair because the directory existed. One predicate decides it; prep-worktree.sh,
# gate.sh and merge.sh all use it.
#
# Sourced, never executed. No common.sh dependency, no side effects at source time.
#
#   node_stamp_state  <pkg-dir>   absent | symlink | stale | fresh
#   node_stamp_mark   <pkg-dir>   record a successful install: node_modules/.kin-lock-sha
#   node_stamp_ensure <pkg-dir>   repair to fresh with ${RSI_NPM:-npm} ci; non-zero on failure

node_stamp_lock_sha() { # <pkg-dir> -> sha256 of its package-lock.json (empty when unreadable)
  shasum -a 256 "$1/package-lock.json" 2>/dev/null | cut -d' ' -f1
}

node_stamp_state() { # <pkg-dir> -> absent | symlink | stale | fresh
  local dir="${1%/}" nm want got
  nm="$dir/node_modules"
  # Test the link first: `-e` is false for a dangling link, and a link is never ours to use or
  # write through even when it resolves.
  if [ -L "$nm" ]; then echo symlink; return 0; fi
  if [ ! -e "$nm" ]; then echo absent; return 0; fi
  if [ ! -d "$nm" ] || [ ! -f "$nm/.kin-lock-sha" ] || [ ! -f "$dir/package-lock.json" ]; then
    echo stale; return 0
  fi
  want="$(node_stamp_lock_sha "$dir")"
  got="$(tr -d '[:space:]' < "$nm/.kin-lock-sha" 2>/dev/null)"
  # Empty, garbage or old marker contents are stale, never fresh.
  if [ -n "$want" ] && [ "$want" = "$got" ]; then echo fresh; else echo stale; fi
}

node_stamp_mark() { # <pkg-dir> — call only after a successful install in that dir
  local dir="${1%/}" sha
  [ -d "$dir/node_modules" ] && [ ! -L "$dir/node_modules" ] || return 1
  sha="$(node_stamp_lock_sha "$dir")"
  [ -n "$sha" ] || return 1
  printf '%s\n' "$sha" > "$dir/node_modules/.kin-lock-sha"
}

node_stamp_ensure() { # <pkg-dir> — fresh, or install once; echoes what it did
  local dir="${1%/}" state
  state="$(node_stamp_state "$dir")"
  [ "$state" = fresh ] && return 0
  echo "node-stamp: $dir/node_modules is $state; installing with ${RSI_NPM:-npm} ci"
  if [ "$state" = symlink ]; then
    # Remove the link, never the directory it points at; refuse to install if it is still there.
    rm -f "$dir/node_modules" || return 1
    [ -L "$dir/node_modules" ] && return 1
  fi
  ( cd "$dir" && "${RSI_NPM:-npm}" ci --no-audit --no-fund ) || return 1
  node_stamp_mark "$dir"
}
