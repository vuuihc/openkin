#!/bin/bash
# test-control-sync.sh — run.sh's control-tree sync must adopt origin/main even when the
# tracked worktree is dirty but already byte-identical to it (the state a landed loop PR
# leaves behind), while a real local change or an unpublished local commit still blocks.
# A tree it cannot move is never silent: `--sync-check` exits 1 and names the lag and the paths.
# It also pins `--status`'s merge-lane line: it must count the per-PR verifier locks
# (state/merge/<slug>.lock holding a live pid, merge.sh's convention) and the legacy
# state/.merge.lock as `legacy`, instead of reading the legacy lock alone.
#
# Hermetic: temp bare origin + work clone per case, fixed git identities, temp HOME,
# RSI_CTRL points at the work clone, and run.sh is invoked as `--sync-check`/`--status`
# so no lock, daemon fetch or launchd check runs. Prints "PASS <case>" per case; exits
# non-zero on the first failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$HERE/../run.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export HOME="$T/home"; mkdir -p "$HOME"

# pair <name> [extra...] — a bare origin and a work clone one commit behind origin/main.
# The seed's second commit adds next.txt plus one file per extra argument (content = name).
# Sets WORK to the clone and ORIGIN_SHA to origin/main's tip.
pair() {
  local d="$T/$1" n; shift
  mkdir -p "$d"
  git init -q -b main "$d/seed"
  ( cd "$d/seed"
    echo base > tracked.txt; git add tracked.txt; git commit -q -m "chore: base"
    echo rt > runtime.sh; git add runtime.sh; git commit -q -m "feat: runtime" )
  git init -q --bare -b main "$d/origin.git"
  git -C "$d/seed" remote add origin "$d/origin.git"
  git -C "$d/seed" push -q origin main
  git clone -q "$d/origin.git" "$d/work"
  ( cd "$d/seed" && echo next > next.txt
    for n in "$@"; do echo "$n" > "$n"; done
    git add -A && git commit -q -m "feat: next" && git push -q origin main )
  WORK="$d/work"
  ORIGIN_SHA="$(git -C "$d/origin.git" rev-parse main)"
}

# sync [env assignments...] — run only the control-tree sync against $WORK.
# Sets RC, OUT and ERR.
sync() {
  env RSI_CTRL="$WORK" "$@" bash "$RUN" --sync-check >"$T/out" 2>"$T/err"; RC=$?
  OUT="$(cat "$T/out")"; ERR="$(cat "$T/err")"
}

head_now() { git -C "$WORK" rev-parse HEAD; }

# 1. A clean tree behind origin/main is fast-forwarded, silently.
pair clean
sync
[ "$RC" = 0 ] || { printf '%s\n' "$ERR" >&2; fail "clean-behind: expected exit 0, got $RC"; }
[ "$(head_now)" = "$ORIGIN_SHA" ] || fail "clean-behind: HEAD did not become origin/main"
[ -z "$ERR" ] || fail "clean-behind: expected silence, got: $ERR"
pass "clean-behind-ff"

# 2. An unpublished local loop commit while origin/main moved on: the commit survives, and the tree
#    is behind, so the sync pins loudly instead of pretending to be synced.
pair local-commit
( cd "$WORK" && echo mine > mine.txt && git add mine.txt && git commit -q -m "fix: local loop commit" )
before="$(head_now)"
sync
[ "$RC" = 1 ] || fail "local-commit: expected exit 1 from a diverged tree, got $RC"
[ "$(head_now)" = "$before" ] || fail "local-commit: HEAD moved and lost the unpublished commit"
[ -f "$WORK/mine.txt" ] || fail "local-commit: the local commit's file disappeared"
grep -q 'local loop commits are unpublished; land or merge them to resume syncing' <<<"$ERR" \
  || fail "local-commit: the pin did not name the unpublished commits: $ERR"
grep -q 'commits behind origin/main' <<<"$ERR" || fail "local-commit: the pin did not name the lag: $ERR"
pass "local-commit-survives"

# 2b. Dirty and content-equal to origin/main, but HEAD carries an unpublished commit: the
#     adopt must not run, or the commit (not just its content) would be discarded. It is behind,
#     so it is pinned like case 2.
pair local-same-content
( cd "$WORK" && echo wrong > tracked.txt && git add tracked.txt \
  && git commit -q -m "fix: unpublished local edit" )
echo base > "$WORK/tracked.txt"       # hand-restored to origin/main's content
echo next > "$WORK/next.txt"          # origin/main's other path, also matching
git -C "$WORK" add next.txt
git -C "$WORK" fetch -q origin main
[ -n "$(git -C "$WORK" status --porcelain --untracked-files=no)" ] || fail "local-same: setup is not dirty"
git -C "$WORK" diff --quiet origin/main || fail "local-same: setup content does not match origin/main"
before="$(head_now)"
sync
[ "$RC" = 1 ] || fail "local-same: expected exit 1 from a diverged tree, got $RC"
[ "$(head_now)" = "$before" ] || fail "local-same: HEAD moved and discarded an unpublished commit"
grep -q 'local loop commits are unpublished; land or merge them to resume syncing' <<<"$ERR" \
  || fail "local-same: the pin did not name the unpublished commits: $ERR"
grep -q 'commits behind origin/main' <<<"$ERR" || fail "local-same: the pin did not name the lag: $ERR"
pass "local-commit-same-content-survives"

# 3. A real local edit blocks the sync, stays intact, and is reported: the tree is one commit behind,
#    so --sync-check names the lag and the path in the way and exits non-zero. (2026-11-18: a draft of
#    rsi/GOAL.md pinned the live tree 7 commits behind main while --sync-check printed nothing, exit 0.)
pair dirty-real
echo "local edit" >> "$WORK/tracked.txt"
before="$(head_now)"
sync
[ "$RC" = 1 ] || fail "dirty-real: expected exit 1 from a pinned tree, got $RC"
[ "$(head_now)" = "$before" ] || fail "dirty-real: HEAD moved over a real local change"
grep -q "local edit" "$WORK/tracked.txt" || fail "dirty-real: the local edit was discarded"
grep -q 'control tree pinned at .* (1 commits behind origin/main): uncommitted tracked changes differ' <<<"$ERR" \
  || fail "dirty-real: the pin did not name the lag: $ERR"
grep -q 'tracked\.txt' <<<"$ERR" || fail "dirty-real: the pin did not name the path in the way: $ERR"
pass "dirty-real-change-blocks-loudly"

# 3b. Dirty with content differing from origin/main but HEAD level with it: the in-place hotfix shape.
#     Nothing is behind, so it is not a pin: --sync-check exits 0, names the sha, and never resets.
pair dirty-level
git -C "$WORK" fetch -q origin main && git -C "$WORK" reset -q --hard origin/main
echo "hotfix in place" >> "$WORK/tracked.txt"
before="$(head_now)"
sync
[ "$RC" = 0 ] || { printf '%s\n' "$ERR" >&2; fail "dirty-level: expected exit 0, got $RC"; }
[ "$(head_now)" = "$before" ] || fail "dirty-level: HEAD moved under an in-place hotfix"
grep -q "hotfix in place" "$WORK/tracked.txt" || fail "dirty-level: the hotfix was reverted"
grep -q 'control tree dirty at .* (at origin/main); leaving it alone' <<<"$ERR" \
  || fail "dirty-level: the non-pin line was missing: $ERR"
! grep -q 'control tree pinned' <<<"$ERR" || fail "dirty-level: a level tree was reported as pinned: $ERR"
pass "dirty-level-at-origin-main-left-alone"

# 4. Dirty but every tracked path already equals origin/main: adopt it. This is the shape a
#    landed loop PR leaves in the control tree (a staged runtime file matching main, HEAD behind).
pair dirty-equal
echo next > "$WORK/next.txt"          # byte-identical to the file origin/main added
git -C "$WORK" add next.txt
git -C "$WORK" fetch -q origin main
[ -n "$(git -C "$WORK" status --porcelain --untracked-files=no)" ] || fail "dirty-equal: setup is not dirty"
git -C "$WORK" diff --quiet origin/main || fail "dirty-equal: setup content does not match origin/main"
sync
[ "$RC" = 0 ] || { printf '%s\n' "$ERR" >&2; fail "dirty-equal: expected exit 0, got $RC"; }
[ "$(head_now)" = "$ORIGIN_SHA" ] || fail "dirty-equal: HEAD did not become origin/main"
[ -z "$(git -C "$WORK" status --porcelain --untracked-files=no)" ] || fail "dirty-equal: tracked tree still dirty after the sync"
grep -q 'control tree synced to' <<<"$ERR" || fail "dirty-equal: the sync did not say it moved HEAD: $ERR"
pass "dirty-equal-content-adopts"

# 5. Untracked files are not the sync's business: they survive the adopt.
pair untracked
echo next > "$WORK/next.txt"
git -C "$WORK" add next.txt
echo "keep me" > "$WORK/scratch.txt"
sync
[ "$RC" = 0 ] || fail "untracked: expected exit 0, got $RC"
[ "$(head_now)" = "$ORIGIN_SHA" ] || fail "untracked: HEAD did not become origin/main"
grep -q "keep me" "$WORK/scratch.txt" 2>/dev/null || fail "untracked: an untracked file was lost"
pass "untracked-survives"

# 6. No origin remote: the fetch fails silently and nothing moves.
NOr="$T/no-origin"; mkdir -p "$NOr"
git init -q -b main "$NOr"
( cd "$NOr" && echo base > tracked.txt && git add tracked.txt && git commit -q -m "chore: base" )
WORK="$NOr"
before="$(head_now)"
sync
[ "$RC" = 0 ] || fail "no-origin: expected exit 0, got $RC"
[ "$(head_now)" = "$before" ] || fail "no-origin: HEAD moved without a remote"
[ -z "$ERR" ] || fail "no-origin: expected silence, got: $ERR"
pass "no-origin-is-silent"

# 7. An untracked path that main now tracks blocks the fast-forward; identical bytes are adopted,
#    so the tree still reaches origin/main (2026-11-18: a stale draft of reviewer-misses.py pinned it).
pair untracked-same
( cd "$WORK" && echo next > next.txt )   # untracked, byte-identical to main's copy
sync
[ "$RC" = 0 ] || fail "untracked-same: expected exit 0, got $RC"
[ "$(head_now)" = "$ORIGIN_SHA" ] || fail "untracked-same: HEAD did not become origin/main: $ERR"
grep -q 'adopted untracked next.txt' <<<"$ERR" || fail "untracked-same: the adopt was not reported: $ERR"
[ "$(cat "$WORK/next.txt")" = next ] || fail "untracked-same: next.txt content changed"
pass "untracked-collision-identical-adopts"

# 8. The same collision with different bytes must not be destroyed and must say why it pinned.
pair untracked-diff
( cd "$WORK" && echo "my draft" > next.txt )
before="$(head_now)"
sync
[ "$RC" = 1 ] || fail "untracked-diff: expected exit 1 from a pinned tree, got $RC"
[ "$(head_now)" = "$before" ] || fail "untracked-diff: HEAD moved over a differing untracked draft"
grep -q 'my draft' "$WORK/next.txt" || fail "untracked-diff: the untracked draft was discarded"
grep -q 'untracked next.txt differs' <<<"$ERR" || fail "untracked-diff: the pin was silent: $ERR"
pass "untracked-collision-different-pins-loudly"

# 9. Dirty-but-identical tracked content plus a differing untracked draft: the tree must stay pinned
#    with a line naming the draft — `reset --hard` is only safe when every tracked path matches, and an
#    untracked path main now tracks would be overwritten by it.
pair untracked-diff-dirty other.txt
( cd "$WORK" && echo "my other draft" > other.txt )   # untracked draft of a path main just added
( cd "$WORK" && echo next > next.txt && git add next.txt )
git -C "$WORK" fetch -q origin main
before="$(head_now)"
sync
[ "$RC" = 1 ] || fail "untracked-diff-dirty: expected exit 1 from a pinned tree, got $RC"
[ "$(head_now)" = "$before" ] || fail "untracked-diff-dirty: HEAD moved and overwrote the draft"
[ "$(cat "$WORK/other.txt")" = "my other draft" ] || fail "untracked-diff-dirty: other.txt was clobbered"
grep -q 'untracked other.txt differs' <<<"$ERR" || fail "untracked-diff-dirty: the pin was silent: $ERR"
[ "$RC" = 1 ] || fail "untracked-diff-dirty: expected exit 1 from a pinned tree, got $RC"
pass "untracked-collision-blocks-adopt"

# 10. A clean tracked tree whose fast-forward still fails for another reason must say so. A broken
#     symlink at the added path is skipped by adopt's `[ -f ]`, yet `merge --ff-only` refuses to
#     overwrite it. (An empty directory does not work: git replaces it and the ff succeeds.)
pair untracked-symlink
ln -s /nonexistent-target "$WORK/next.txt"
before="$(head_now)"
sync
[ "$RC" = 1 ] || fail "untracked-symlink: expected exit 1 from a pinned tree, got $RC"
[ "$(head_now)" = "$before" ] || fail "untracked-symlink: HEAD moved over the broken symlink"
grep -q 'fast-forward to origin/main failed' <<<"$ERR" || fail "untracked-symlink: the ff failure was silent: $ERR"
pass "fast-forward-failure-is-loud"

# 11. A rename in origin/main: its destination only appears in `git diff --diff-filter=A` with
#     --no-renames (default detection reports the pair as R). A byte-identical untracked draft at
#     the destination is adopted, so the tree still reaches origin/main instead of pinning.
pair rename-dest
( cd "$T/rename-dest/seed" && git mv runtime.sh renamed.sh \
  && git commit -q -m "refactor: rename runtime" && git push -q origin main )
ORIGIN_SHA="$(git -C "$T/rename-dest/origin.git" rev-parse main)"
( cd "$WORK" && echo rt > renamed.sh )   # untracked, byte-identical to the rename destination
sync
[ "$RC" = 0 ] || fail "rename-dest: expected exit 0, got $RC"
[ "$(head_now)" = "$ORIGIN_SHA" ] || fail "rename-dest: HEAD did not become origin/main: $ERR"
grep -q 'adopted untracked renamed.sh' <<<"$ERR" || fail "rename-dest: the adopt was not reported: $ERR"
pass "rename-destination-identical-adopts"

# 12. `--status`'s merge-lane line must report what is actually running: one lock per PR under
#     state/merge/<slug>.lock holding the verifier's pid (merge.sh's mkdir + `echo $$ > pid`),
#     plus the legacy state/.merge.lock named `legacy`. Dead-pid or pid-less locks are not
#     running. (2026-11-19 16:55: two `merge.sh --one` verifications were live (#390 gate in
#     npm test, #384 journey walk) while the line read `idle`, so a patrol could stack a
#     `pulse --force` on top of them — the overlap showed up as fake reds and reworked PRs.)
pair status
STATE="$WORK/rsi/state"
mkdir -p "$STATE" "$WORK/rsi/runtime"
printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$WORK/rsi/runtime/lanes.py"
# status [env...] — run only `--status` against $WORK; RSI_MAX_OPEN_PRS=0 keeps it off `gh`.
# Sets RC, SOUT and SERR.
status() {
  env RSI_CTRL="$WORK" RSI_MAX_OPEN_PRS=0 "$@" bash "$RUN" --status >"$T/sout" 2>"$T/serr"; RC=$?
  SOUT="$(cat "$T/sout")"; SERR="$(cat "$T/serr")"
}
merge_line() { grep '^merge lane: ' "$T/sout"; }

# 12a. No locks at all: exactly `merge lane: idle`.
status
[ "$RC" = 0 ] || { printf '%s\n' "$SERR" >&2; fail "status-idle: expected exit 0, got $RC"; }
[ "$(merge_line)" = "merge lane: idle" ] \
  || fail "status-idle: expected 'merge lane: idle', got: $(merge_line)"
pass "status-idle-with-no-locks"

# 12b. Two live per-PR locks: counted, and both slugs named alphabetically.
mkdir -p "$STATE/merge/panel-exit.lock" "$STATE/merge/doc-open-external.lock"
sleep 300 & lp1=$!
sleep 300 & lp2=$!
echo "$lp1" > "$STATE/merge/panel-exit.lock/pid"
echo "$lp2" > "$STATE/merge/doc-open-external.lock/pid"
status
line="$(merge_line)"
kill "$lp1" "$lp2" 2>/dev/null; wait "$lp1" "$lp2" 2>/dev/null
[ "$line" = "merge lane: 2 running (doc-open-external, panel-exit)" ] \
  || fail "status-live: expected 2 running (doc-open-external, panel-exit), got: $line"
pass "status-names-two-live-verifications"

# 12c. A reaped pid and a lock with no pid file are not running.
mkdir -p "$STATE/merge/dead.lock" "$STATE/merge/nopid.lock"
( : ) & dp=$!; wait "$dp" 2>/dev/null
echo "$dp" > "$STATE/merge/dead.lock/pid"
status
[ "$(merge_line)" = "merge lane: idle" ] \
  || fail "status-dead: a dead pid was counted, got: $(merge_line)"
rm -rf "$STATE/merge"
pass "status-ignores-a-dead-pid"

# 12d. The legacy single-instance lock stays visible, named `legacy`.
mkdir -p "$STATE/.merge.lock"
echo $$ > "$STATE/.merge.lock/pid"
status
[ "$(merge_line)" = "merge lane: 1 running (legacy)" ] \
  || fail "status-legacy: expected 1 running (legacy), got: $(merge_line)"
rm -rf "$STATE/.merge.lock"
pass "status-counts-the-legacy-lock"

echo "all cases passed"
