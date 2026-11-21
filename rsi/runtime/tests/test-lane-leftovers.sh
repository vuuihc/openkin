#!/bin/bash
# test-lane-leftovers.sh — a lane must deliver every file its worker created.
#
# 2026-11-21: lane 1 delivered R-f2-question-leg, whose journeys.json named a new
# rsi/runtime/ux/journeys/J15.json. The file stayed untracked in the worktree, so it never entered
# the commit. The lane's own gate was green because the file was still on that disk; CI checked the
# pushed branch, found no file, and PR #511's journeys check went red. The instance was patched by
# hand (604b0a9d); the cause was lane.sh's tracked-only sweep. The same path silently passes a new
# test file that nothing then runs — a false green, worse than a red one.
#
# Hermetic: one bare origin and one worktree per case under mktemp -d, RSI_CTRL redirected into the
# temp dir so needs-ceo.md lands there. No network, no gh, no npm, no python beyond what
# common.sh's own budget probe attempts (it fails open when the fixture has no runtime tree).
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$RUNTIME/../.." && pwd)"
SWEEP="$RUNTIME/commit-leftovers.sh"
LANE="$RUNTIME/lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
CTRL="$T/ctrl"; mkdir -p "$CTRL/rsi/state"
R=""   # the worktree the current case works on
ONLY="${RSI_TEST_ONLY:-}"
OUT=""; RC=0

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# new_repo <name> — a bare origin inside the temp dir plus a worktree on main with one base commit.
new_repo() {
  local name="$1"
  R="$T/$name"; rm -rf "$R" "$T/$name.git"
  git init -q --bare "$T/$name.git" || fail "$name: bare init failed"
  git init -q -b main "$R" || fail "$name: git init failed"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  printf 'base\n' > "$R/README.md"
  g add -A >/dev/null && g commit -q -m base || fail "$name: base commit failed"
  g remote add origin "$T/$name.git" || fail "$name: remote add failed"
  g push -q -u origin main || fail "$name: push main failed"
  g update-ref refs/remotes/origin/main HEAD
}

# sweep <item> — run the script the lane runs. Sets OUT (stdout) and RC.
sweep() {
  OUT="$(RSI_CTRL="$CTRL" bash "$SWEEP" "$R" "$1" 2>"$T/sweep.err")"; RC=$?
}

committed() { g show --name-only --format= HEAD; }
needs_ceo_lines() { # <item> — 0 when the file or the line is absent
  local n
  n="$(grep -cF "leftovers: $1 left " "$CTRL/rsi/state/needs-ceo.md" 2>/dev/null)"
  echo "${n:-0}"
}
one_commit() { # <case> <base>
  local n; n="$(g rev-list --count "$2"..HEAD)"
  [ "$n" -eq 1 ] || fail "$1: expected exactly one sweep commit, got $n"
}

# --- cases -------------------------------------------------------------------------------------

# The measured defect: a brand-new file must enter the same commit as the tracked edits, and the
# lane log must name it.
test_new_file_is_committed_with_tracked_edits() {
  new_repo newfile
  local base; base="$(g rev-parse HEAD)"
  printf 'tracked-edit\n' >> "$R/README.md"
  mkdir -p "$R/rsi/runtime/ux/journeys"
  printf '{"journeys": []}\n' > "$R/rsi/runtime/ux/journeys/J15.json"
  sweep R-test-newfile
  [ "$RC" -eq 0 ] || fail "newfile: sweep exited $RC ($(cat "$T/sweep.err"))"
  one_commit newfile "$base"
  local files; files="$(committed)"
  grep -qx 'rsi/runtime/ux/journeys/J15.json' <<<"$files" \
    || fail "newfile: the new file is not in the commit: $files"
  grep -qx 'README.md' <<<"$files" || fail "newfile: the tracked edit is not in the commit: $files"
  grep -qx 'rsi/runtime/ux/journeys/J15.json' <<<"$OUT" \
    || fail "newfile: the new file was not printed on stdout: $OUT"
  grep -qx 'README.md' <<<"$OUT" || fail "newfile: the tracked edit was not printed: $OUT"
  [ -z "$(g status --porcelain)" ] || fail "newfile: the worktree is not clean: $(g status --porcelain)"
}

# A lane whose worker committed its own work must not get an empty housekeeping commit.
test_clean_worktree_makes_no_empty_commit() {
  new_repo clean
  local base; base="$(g rev-parse HEAD)"
  sweep R-test-clean
  [ "$RC" -eq 0 ] || fail "clean: sweep exited $RC ($(cat "$T/sweep.err"))"
  [ -z "$OUT" ] || fail "clean: a clean worktree printed: $OUT"
  [ "$(g rev-parse HEAD)" = "$base" ] || fail "clean: HEAD moved on a clean worktree"
  [ "$(needs_ceo_lines R-test-clean)" = 0 ] || fail "clean: a clean worktree warned"
}

# Ignored files are the developer's, not the lane's: never committed, never a warning.
test_ignored_file_is_not_committed() {
  new_repo ignored
  printf '*.log\n' > "$R/.gitignore"
  g add .gitignore >/dev/null && g commit -q -m 'ignore logs' || fail "ignored: gitignore commit failed"
  local base; base="$(g rev-parse HEAD)"
  printf 'tracked-edit\n' >> "$R/README.md"
  printf 'noise\n' > "$R/debug.log"
  sweep R-test-ignored
  [ "$RC" -eq 0 ] || fail "ignored: sweep exited $RC ($(cat "$T/sweep.err"))"
  one_commit ignored "$base"
  g ls-tree -r --name-only HEAD | grep -qx 'debug.log' && fail "ignored: debug.log was committed"
  [ "$(needs_ceo_lines R-test-ignored)" = 0 ] || fail "ignored: an ignored file raised the leftovers warning"
}

# web/dist/assets is generated and gitignored in the real repo, but a fixture without that rule
# proves the sweep itself never stages it. Belt and braces for a fresh clone.
test_dist_assets_are_never_committed() {
  new_repo distassets
  mkdir -p "$R/web/dist/assets"
  printf 'tracked-edit\n' >> "$R/README.md"
  printf 'bundle\n' > "$R/web/dist/assets/index-abc.js"
  local base; base="$(g rev-parse HEAD)"
  sweep R-test-distassets
  [ "$RC" -eq 0 ] || fail "distassets: sweep exited $RC ($(cat "$T/sweep.err"))"
  one_commit distassets "$base"
  g ls-tree -r --name-only HEAD | grep -q '^web/dist/assets/' \
    && fail "distassets: a generated bundle was committed: $(g ls-tree -r --name-only HEAD | tr '\n' ' ')"
  [ "$(needs_ceo_lines R-test-distassets)" = 0 ] || fail "distassets: the excluded bundle raised the leftovers warning"
}

# The sweep depends on the root .gitignore naming the vitest cache: a lane that ran vitest leaves
# .vitest/json/, and without the rule `git add -A` would commit that cache into every lane's PR.
test_vitest_cache_is_never_committed() {
  new_repo vitest
  cp "$REPO/.gitignore" "$R/.gitignore" || fail "vitest: cannot copy the repo's .gitignore"
  g add .gitignore >/dev/null && g commit -q -m 'root gitignore' || fail "vitest: gitignore commit failed"
  local base; base="$(g rev-parse HEAD)"
  printf 'tracked-edit\n' >> "$R/README.md"
  mkdir -p "$R/.vitest/json"
  printf '{"cache": true}\n' > "$R/.vitest/json/cache.json"
  sweep R-test-vitest
  [ "$RC" -eq 0 ] || fail "vitest: sweep exited $RC ($(cat "$T/sweep.err"))"
  one_commit vitest "$base"
  g ls-tree -r --name-only HEAD | grep -q '^\.vitest/' \
    && fail "vitest: the cache was committed: $(g ls-tree -r --name-only HEAD | tr '\n' ' ')"
  [ "$(needs_ceo_lines R-test-vitest)" = 0 ] || fail "vitest: the ignored cache raised the leftovers warning"
}

# A sweep that did not take must never look clean: non-zero, one needs-ceo line, and the same line
# is not repeated when the item is retried.
test_failed_sweep_is_loud() {
  new_repo failed
  local base; base="$(g rev-parse HEAD)"
  printf '#!/bin/sh\nexit 1\n' > "$R/.git/hooks/pre-commit"; chmod +x "$R/.git/hooks/pre-commit"
  printf 'tracked-edit\n' >> "$R/README.md"
  sweep R-test-failed
  [ "$RC" -ne 0 ] || fail "failed: a failed commit reported success"
  [ "$(g rev-parse HEAD)" = "$base" ] || fail "failed: HEAD moved although the commit failed"
  [ "$(needs_ceo_lines R-test-failed)" = 1 ] || fail "failed: expected exactly one needs-ceo line, got $(needs_ceo_lines R-test-failed)"
  [ -n "$OUT" ] || fail "failed: the attempted paths were not printed for the lane log"
  sweep R-test-failed
  [ "$RC" -ne 0 ] || fail "failed: the retry reported success"
  [ "$(needs_ceo_lines R-test-failed)" = 1 ] \
    || fail "failed: the retry duplicated the needs-ceo line ($(needs_ceo_lines R-test-failed))"
}

# The other shape of "did not take": the commit lands, yet a file is still uncommitted afterwards
# (a hook wrote one). Silence here would be the same false green in a new costume.
test_post_commit_leftover_is_loud() {
  new_repo postleft
  local base; base="$(g rev-parse HEAD)"
  printf '#!/bin/sh\n: > late.txt\n' > "$R/.git/hooks/post-commit"; chmod +x "$R/.git/hooks/post-commit"
  printf 'tracked-edit\n' >> "$R/README.md"
  sweep R-test-postleft
  [ "$RC" -ne 0 ] || fail "postleft: a worktree left dirty after the commit reported success"
  [ "$(g rev-parse HEAD)" != "$base" ] || fail "postleft: the fixture did not commit"
  [ "$(needs_ceo_lines R-test-postleft)" = 1 ] || fail "postleft: expected one needs-ceo line, got $(needs_ceo_lines R-test-postleft)"
}

# Conflict markers are never content: an unresolved rework must be refused before `git add -A`
# stages the marker text into a commit.
test_unmerged_entries_are_refused() {
  new_repo unmerged
  printf 'base\n' > "$R/conflict.txt"
  g add -A >/dev/null && g commit -q -m 'conflict base' || fail "unmerged: base commit failed"
  g checkout -q -b side
  printf 'side\n' > "$R/conflict.txt"
  g add -A >/dev/null && g commit -q -m side || fail "unmerged: side commit failed"
  g checkout -q main
  printf 'main\n' > "$R/conflict.txt"
  g add -A >/dev/null && g commit -q -m main || fail "unmerged: main commit failed"
  local base; base="$(g rev-parse HEAD)"
  g merge side >/dev/null 2>&1 || true
  [ -n "$(g ls-files -u)" ] || fail "unmerged: the fixture did not leave unmerged entries"
  sweep R-test-unmerged
  [ "$RC" -ne 0 ] || fail "unmerged: the sweep committed a conflicted worktree"
  [ "$(g rev-parse HEAD)" = "$base" ] || fail "unmerged: HEAD moved over a conflict"
  [ -n "$(g ls-files -u)" ] || fail "unmerged: the sweep staged the conflict away"
  [ "$(needs_ceo_lines R-test-unmerged)" = 1 ] || fail "unmerged: the refusal was not surfaced in needs-ceo.md"
}

# The sweep is only a fix if the lane calls it, before the AHEAD check, and drops the old
# tracked-only sweep. A standalone script nothing calls is not a wiring (Watch 66).
test_lane_calls_the_sweep_before_the_ahead_check() {
  [ -f "$LANE" ] || fail "wiring: $LANE missing"
  local inv ahead
  inv="$(grep -nF 'commit-leftovers.sh' "$LANE" | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1)"
  [ -n "$inv" ] || fail "wiring: lane.sh never invokes commit-leftovers.sh"
  ahead="$(grep -n '^AHEAD=' "$LANE" | head -1 | cut -d: -f1)"
  [ -n "$ahead" ] || fail "wiring: lane.sh has no AHEAD= line"
  [ "$inv" -lt "$ahead" ] \
    || fail "wiring: the sweep (line $inv) runs after the AHEAD check (line $ahead)"
  grep -qF 'add -u --' "$LANE" && fail "wiring: lane.sh still carries the old tracked-only add -u sweep"
  grep -qF -- '--untracked-files=no' "$LANE" && fail "wiring: lane.sh still carries the old tracked-only status probe"
  grep -qF 'swept=' "$LANE" || fail "wiring: the lane's done note does not report swept=<n>"
  return 0
}

# The bundle lanes hand the Mac a bundle of commits, so a file they leave untracked is simply not
# in the hand-over. Both must call the shared sweep at every site that used to run the tracked-only
# one, and a failing sweep must stop the lane rather than bundle a branch missing files.
test_bundle_lanes_call_the_sweep() {
  local f call='bash "$WT/rsi/runtime/commit-leftovers.sh" "$WT" "$ITEM" || fail "leftovers remain uncommitted"'
  local guard='if [ -f "$WT/rsi/runtime/commit-leftovers.sh" ]; then'
  for f in "$RUNTIME/nas/nas-side/nas-lane.sh" "$RUNTIME/box/box-side/box-lane.sh"; do
    [ -f "$f" ] || fail "bundle wiring: $f missing"
    [ "$(grep -cF "$call" "$f")" -eq "$(grep -cF -- '--untracked-files=no' "$f")" ] \
      || fail "bundle wiring: $f calls the sweep at fewer sites than it keeps a tracked-only fallback"
    [ "$(grep -cF "$guard" "$f")" -eq "$(grep -cF -- '--untracked-files=no' "$f")" ] \
      || fail "bundle wiring: $f has a tracked-only sweep without the sweep guard"
  done
  [ "$(grep -cF "$call" "$RUNTIME/box/box-side/box-lane.sh")" -eq 2 ] \
    || fail "bundle wiring: box-lane.sh must call the sweep after the worker and after the fix round"
  return 0
}

run() {
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || return 0
  "$1" || exit 1
  pass "$1"
}

run test_new_file_is_committed_with_tracked_edits
run test_clean_worktree_makes_no_empty_commit
run test_ignored_file_is_not_committed
run test_dist_assets_are_never_committed
run test_vitest_cache_is_never_committed
run test_failed_sweep_is_loud
run test_post_commit_leftover_is_loud
run test_unmerged_entries_are_refused
run test_lane_calls_the_sweep_before_the_ahead_check
run test_bundle_lanes_call_the_sweep
echo ALL-PASS
