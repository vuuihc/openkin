#!/bin/bash
# test-merge-sync-abort.sh — a sync of origin/main into a verifier worktree must end in exactly one
# of two states: the merge is COMMITTED (HEAD is the merge, tree clean) or ABORTED (tree identical
# to before the sync). A third state is today's defect: a verifier killed between the failed
# `git merge` and gen_resolve's commit leaves MERGE_HEAD, unmerged `UU` entries and the sync's
# other files staged while HEAD is still the pre-merge head. The next gate/review then judges an
# old head over a dirty index, and a later commit from that worktree can sweep another PR's files
# in (2026-11-21: PR #506's worktree carried 9 of #504's staged files and MERGE_HEAD=3c328fa7).
#
# Hermetic: temp git repos under mktemp -d, a bare origin inside the temp dir, RSI_CTRL redirected
# into the temp dir, the dist build stubbed through RSI_DIST_BUILD_CMD, the PR state stubbed through
# RSI_PR_STATE_CMD. No network, no gh, no npm, no python beyond the stdlib.
#
# Exercises merge.sh --sync-main, which runs exactly the sync_main() the per-PR verifier runs.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
R=""   # the repo the current case works on
ONLY="${RSI_TEST_ONLY:-}"
# A PAUSE flag covers the red run on an unmodified merge.sh: before the seam exists the dispatcher
# falls through to its PAUSE check, so no gh, fetch or dispatch ever runs from a test invocation.
mkdir -p "$T/ctrl/rsi/state/merge" "$T/ctrl/rsi/state/sendback"
: > "$T/ctrl/rsi/state/PAUSE"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# --- stubs -------------------------------------------------------------------------------------
# The dist build runs with cwd = <repo>/ui, exactly like `npm run build`. The blocking stub marks
# that the merge is in flight (gen_resolve runs it only after the conflicted merge started) and
# then blocks until the signal under test kills it.
cat > "$T/dist-block.sh" <<SH
#!/bin/bash
trap 'kill "\$sp" 2>/dev/null; exit 143' TERM
: > "$T/dist-blocked"
sleep 300 & sp=\$!
wait "\$sp"
exit 143
SH
# The success stub writes the regenerated entry exactly where `npm run build` would.
cat > "$T/dist-write.sh" <<'SH'
#!/bin/bash
printf 'dist-built\n' > ../web/dist/index.html
SH

# new_repo <name> — a bare origin inside the temp dir; `feat` changes web/dist/index.html and
# ui/App.tsx, then origin/main moves web/dist/index.html differently. Merging origin/main into
# `feat` therefore conflicts only in the generated entry.
new_repo() {
  local name="$1"
  R="$T/$name"; rm -rf "$R" "$T/$name.git"
  git init -q --bare "$T/$name.git" || fail "$name: bare init failed"
  mkdir -p "$R/web/dist" "$R/ui"
  g init -q -b main || fail "$name: git init failed"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  printf 'dist-base\n' > "$R/web/dist/index.html"
  printf 'app-base\n' > "$R/ui/App.tsx"
  g add -A >/dev/null && g commit -q -m base || fail "$name: base commit failed"
  g remote add origin "$T/$name.git" || fail "$name: remote add failed"
  g push -q -u origin main || fail "$name: push main failed"
  g update-ref refs/remotes/origin/main HEAD
  g checkout -q -b feat
  printf 'dist-feat\n' > "$R/web/dist/index.html"
  printf 'app-feat\n' > "$R/ui/App.tsx"
  g add -A >/dev/null && g commit -q -m "pr" || fail "$name: pr commit failed"
  g push -q -u origin feat || fail "$name: push feat failed"
  g update-ref refs/remotes/origin/feat HEAD
  g checkout -q main
  printf 'dist-main\n' > "$R/web/dist/index.html"
  g add -A >/dev/null && g commit -q -m "main moves dist" || fail "$name: main commit failed"
  g push -q origin main || fail "$name: push main move failed"
  g update-ref refs/remotes/origin/main main
  g checkout -q feat
}

# sync_seam — run the same sync_main() the verifier runs, synchronously. Sets RC.
sync_seam() {
  RSI_CTRL="$T/ctrl" RSI_PR_STATE_CMD='echo OPEN' "$@" \
    bash "$MERGE" --sync-main "$R" t 1 R-test > "$T/sync.log" 2>&1
  RC=$?
}

# no_half_merge <case> — the post-condition every sync return path must satisfy.
no_half_merge() {
  local case="$1" u bad
  if g rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    fail "$case: MERGE_HEAD is still present"
  fi
  u="$(g ls-files -u)"
  [ -z "$u" ] || fail "$case: unmerged index entries remain: $u"
  bad="$(g status --porcelain | grep -E '^(UU|AA|DD)' || true)"
  [ -z "$bad" ] || fail "$case: status still marks an unmerged path: $bad"
}

clean_tree() { # <case>
  local out; out="$(g status --porcelain)"
  [ -z "$out" ] || fail "$1: the worktree is not the pre-sync tree: $out"
}

# --- cases -------------------------------------------------------------------------------------

# The motivating case: TERM lands while the merge is in flight (the dist build is running). The
# sync must abort the merge before it exits; today's verifier leaves MERGE_HEAD and the staged
# sync behind.
test_termed_sync_leaves_no_half_merge() {
  new_repo termed
  local before; before="$(g rev-parse HEAD)"
  rm -f "$T/dist-blocked" "$T/sync.log"
  # Job control gives the sync its own process group, so the TERM reaches the verifier and the
  # stub it is blocked in, exactly as a killed verifier and its child are signalled together.
  set -m
  RSI_CTRL="$T/ctrl" RSI_PR_STATE_CMD='echo OPEN' RSI_DIST_BUILD_CMD="bash $T/dist-block.sh" \
    bash "$MERGE" --sync-main "$R" t 1 R-test > "$T/sync.log" 2>&1 &
  local pid=$!
  set +m
  local i=0
  while [ ! -e "$T/dist-blocked" ]; do
    i=$((i+1))
    if [ "$i" -ge 300 ]; then
      kill -KILL -- "-$pid" 2>/dev/null || true
      fail "termed: the dist stub never ran ($(tail -5 "$T/sync.log" 2>/dev/null | tr '\n' ' '))"
    fi
    sleep 0.05
  done
  g rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 \
    || { kill -KILL -- "-$pid" 2>/dev/null || true; fail "termed: no merge was in flight when the stub started"; }
  ( sleep 20; kill -KILL -- "-$pid" 2>/dev/null || true ) & local wd=$!
  kill -TERM -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null; local rc=$?
  kill "$wd" 2>/dev/null || true; wait "$wd" 2>/dev/null || true
  [ "$rc" -ne 137 ] || fail "termed: the sync had to be SIGKILLed; it did not honour TERM"
  no_half_merge termed
  [ "$(g rev-parse HEAD)" = "$before" ] || fail "termed: HEAD moved without a merge commit"
  clean_tree termed
}

# A refused generated-file conflict: the dist stub fails, so the resolver refuses and the sync
# aborts before writing the mechanical sendback.
test_refused_generated_conflict_ends_aborted() {
  new_repo refused
  local before; before="$(g rev-parse HEAD)"
  rm -f "$T/ctrl/rsi/state/sendback/t.md" "$T/ctrl/rsi/state/merge/t.mech"
  sync_seam env RSI_DIST_BUILD_CMD='false'
  [ "$RC" -ne 0 ] || fail "refused: the sync reported ok over a refused conflict"
  no_half_merge refused
  clean_tree refused
  [ "$(g rev-parse HEAD)" = "$before" ] || fail "refused: HEAD moved"
  [ -s "$T/ctrl/rsi/state/sendback/t.md" ] || fail "refused: no mechanical sendback was written"
  grep -q 'merge of origin/main conflicts in' "$T/ctrl/rsi/state/sendback/t.md" \
    || fail "refused: the sendback does not name the conflict"
}

# A completed generated-file merge: the stub writes the regenerated entry, gen_resolve commits,
# and the sync pushes the merge.
test_completed_generated_merge_ends_committed() {
  new_repo completed
  local before; before="$(g rev-parse HEAD)"
  sync_seam env RSI_DIST_BUILD_CMD="bash $T/dist-write.sh"
  [ "$RC" -eq 0 ] || fail "completed: the sync returned $RC ($(tail -5 "$T/sync.log" | tr '\n' ' '))"
  no_half_merge completed
  [ "$(g rev-parse HEAD^1)" = "$before" ] || fail "completed: HEAD's first parent is not the pre-sync head"
  [ "$(g rev-parse HEAD^2)" = "$(g rev-parse origin/main)" ] \
    || fail "completed: HEAD is not a merge of origin/main"
  grep -qx 'dist-built' "$R/web/dist/index.html" || fail "completed: the regenerated dist did not land"
  clean_tree completed
  [ "$(git -C "$T/completed.git" rev-parse refs/heads/rsi/t 2>/dev/null)" = "$(g rev-parse HEAD)" ] \
    || fail "completed: the merge commit was not pushed"
}

# A half-merged worktree left by an earlier killed run is not a base this cycle can report ok on:
# the sync must abort it, refuse, and leave no MERGE_HEAD or unmerged entries behind. Refusing
# rather than sending back matters: this is infrastructure state, not a defect in the PR's diff,
# and a mechanical rework round would burn one of its three attempts.
test_sync_refuses_with_merge_head_present() {
  new_repo halfmerge
  local before; before="$(g rev-parse HEAD)"
  rm -f "$T/ctrl/rsi/state/sendback/t.md" "$T/ctrl/rsi/state/needs-ceo.md"
  g merge -q --no-edit origin/main >/dev/null 2>&1 || true
  g rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 \
    || fail "halfmerge: the fixture did not leave a half-merge"
  sync_seam env RSI_DIST_BUILD_CMD='false'
  [ "$RC" -ne 0 ] || fail "halfmerge: the sync reported ok with MERGE_HEAD present"
  no_half_merge halfmerge
  clean_tree halfmerge
  [ "$(g rev-parse HEAD)" = "$before" ] || fail "halfmerge: HEAD moved"
  [ ! -e "$T/ctrl/rsi/state/sendback/t.md" ] \
    || fail "halfmerge: a pre-existing half-merge queued a rework round for the PR"
  grep -q 'half-applied' "$T/ctrl/rsi/state/needs-ceo.md" 2>/dev/null \
    || fail "halfmerge: the refusal was not surfaced in needs-ceo.md"
}

# When `git merge --abort` itself cannot run (an index.lock held by a dead child is the recorded
# shape), the sync must not report a usable worktree: non-zero, and a needs-ceo line naming the
# failure. It must never fall back to `reset --hard`, which would destroy the lane's own work.
test_unabortable_merge_is_refused_and_surfaced() {
  new_repo unabortable
  local before; before="$(g rev-parse HEAD)"
  rm -f "$T/ctrl/rsi/state/sendback/t.md" "$T/ctrl/rsi/state/needs-ceo.md"
  g merge -q --no-edit origin/main >/dev/null 2>&1 || true
  g rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 \
    || fail "unabortable: the fixture did not leave a half-merge"
  : > "$R/.git/index.lock"
  sync_seam env RSI_DIST_BUILD_CMD='false'
  [ "$RC" -ne 0 ] || fail "unabortable: the sync reported ok although the merge could not be aborted"
  g rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 \
    || fail "unabortable: the fixture's index.lock did not block git merge --abort"
  grep -q 'git merge --abort failed' "$T/ctrl/rsi/state/needs-ceo.md" 2>/dev/null \
    || fail "unabortable: the abort failure was not surfaced in needs-ceo.md"
  [ "$(g rev-parse HEAD)" = "$before" ] || fail "unabortable: HEAD moved"
  rm -f "$R/.git/index.lock"
}

run() {
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || return 0
  "$1" || exit 1
  pass "$1"
}

run test_termed_sync_leaves_no_half_merge
run test_refused_generated_conflict_ends_aborted
run test_completed_generated_merge_ends_committed
run test_sync_refuses_with_merge_head_present
run test_unabortable_merge_is_refused_and_surfaced
echo ALL-PASS
