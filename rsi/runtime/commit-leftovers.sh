#!/bin/bash
# commit-leftovers.sh <worktree> <item> — commit everything the worker left behind, including the
# files it created, and print one committed path per line on stdout.
#
# Why this exists: lane.sh used to sweep only already-tracked files (`status --untracked-files=no`
# plus `add -u`). A worker that never `git add`ed a new file delivered a branch without it: the
# lane's own gate was green because the file was still on that disk, and CI judged the pushed
# branch and went red (2026-11-21, PR #511's new rsi/runtime/ux/journeys/J15.json). The same path
# silently passes a *new test file* that no job then runs — a false green, worse than a red one.
#
# Nothing ignored or generated is ever committed, enforced in three places: `git add -A` respects
# .gitignore, an explicit `reset` unstages web/dist/assets even when a fixture lacks that ignore
# rule, and the post-add checks carry the same exclusion pathspec. Do not put the exclusion back on
# `add`: naming an ignored path there makes git exit 1, and a UI lane that ran `npm run build`
# (writing the gitignored web/dist/assets) then failed the handoff as "left 0 path(s)" after all of
# its work was committed (2026-11-21, R-ios-bottom-band). The root .gitignore carries .vitest/ for
# this sweep: a lane's untracked vitest cache would otherwise ride into every PR.
#
# Exit 0 — nothing to commit, or one commit holding every leftover with nothing left behind.
# Exit 1 — leftovers remain (unmerged entries, add/commit failed, or files still uncommitted after
#          the commit). One `leftovers: <item> left <n> path(s) ...` line is appended to
#          $STATE/needs-ceo.md, at most once per item, so a sweep that did not take never looks
#          clean. The failing reason goes to stderr; stdout stays exactly the path list.
# Exit 2 — usage error.
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

WT="${1:-}"; ITEM="${2:-}"
[ -n "$WT" ] && [ -n "$ITEM" ] || { echo "usage: commit-leftovers.sh <worktree> <item>" >&2; exit 2; }
[ -d "$WT" ] || { echo "commit-leftovers: no worktree at $WT" >&2; exit 2; }

# One definition feeds the staged diff, the post-commit check and the printed path list. The add
# cannot carry it (see the header): it relies on .gitignore plus the unstage below.
EXCL=':!web/dist/assets'

remaining() { # uncommitted paths this sweep is responsible for
  $GIT -C "$WT" status --porcelain -- . "$EXCL" 2>/dev/null | wc -l | tr -d ' '
}

record() { # <n> — one line per item; a retried item must not stack identical lines in needs-ceo.md
  local f="$STATE/needs-ceo.md" n="${1:-?}"
  [ -f "$f" ] && grep -qF "leftovers: $ITEM left " "$f" && return 0
  printf 'leftovers: %s left %s path(s) uncommitted in %s\n' "$ITEM" "$n" "$WT" >> "$f" 2>/dev/null || true
}

leftover_fail() { # <reason> — never report a worktree clean while it still holds uncommitted work
  local n; n="$(remaining)"
  record "$n"
  echo "commit-leftovers: $1 ($n path(s) uncommitted in $WT)" >&2
  exit 1
}

# `git add -A` resolves an unresolved conflict by staging its marker text, so a conflicted rework
# worktree must be refused before the sweep can turn markers into a commit.
if [ -n "$($GIT -C "$WT" ls-files -u -- . 2>/dev/null | head -1)" ]; then
  leftover_fail "unmerged index entries; sweeping them would commit conflict markers"
fi

# No exclusion pathspec here: an ignored path named on `add` makes git exit 1. `add -A` skips
# ignored paths by itself, and the reset removes the bundles in a tree without that ignore rule.
$GIT -C "$WT" add -A -- . || leftover_fail "git add failed"
$GIT -C "$WT" reset -q -- web/dist/assets 2>/dev/null || true

# Nothing staged: the common case when the worker committed its own work. No commit, no output.
if $GIT -C "$WT" diff --cached --quiet -- . "$EXCL"; then
  exit 0
fi

# Printed before the commit so a failed sweep still names what it tried; the lane writes these
# lines to lanes/<n>.leftovers.log either way.
SWEPT="$($GIT -C "$WT" diff --cached --name-only -- . "$EXCL")"
[ -n "$SWEPT" ] && printf '%s\n' "$SWEPT"

# Hooks may print; stdout belongs to the path list, so send everything the commit says to stderr.
if ! $GIT -C "$WT" commit -q -m "chore(rsi): commit remaining edits for $ITEM" >&2; then
  leftover_fail "git commit failed; the leftovers are still uncommitted"
fi

[ "$(remaining)" = 0 ] || leftover_fail "the sweep did not take; files are still uncommitted"
exit 0
