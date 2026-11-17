#!/bin/bash
# test-gate-carry.sh — a gate verified on a PR head may carry forward when origin/main moves in
# paths that cannot affect that PR; it must be thrown away when the move touches the PR's own
# file or package, a shared surface, or when the post-merge UI safety step fails.
#
# Hermetic: temp git repos under mktemp -d, RSI_CTRL redirected into the temp dir, the inventory
# check and the dist build stubbed through RSI_INV_CHECK_CMD / RSI_DIST_BUILD_CMD. No network,
# no npm, no python beyond the stdlib.
#
# Exercises merge.sh --carry-check, which runs the same carry_forward() the land loop calls: on a
# carry it rewrites the gate file with the merged head SHA, on a re-gate it removes it.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
R=""; RC=0; V=""
ONLY="${RSI_TEST_ONLY:-}"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
g() { git -C "$R" "$@"; }

# --- stubs -------------------------------------------------------------------------------------
# The dist build runs with cwd = <repo>/ui, exactly like `npm run build`.
cat > "$T/dist-stub.sh" <<'SH'
#!/bin/bash
set -eu
[ "${STUB_DIST_FAIL:-0}" = 1 ] && exit 1
printf '%s\n' "${STUB_DIST_TEXT:-dist-ok}" > ../web/dist/index.html
exit 0
SH
# The inventory check runs with cwd = the repo root, exactly like
# `python3 scripts/check-ui-inventory.py`.
cat > "$T/inv-stub.sh" <<'SH'
#!/bin/bash
set -eu
[ "${STUB_INV_FAIL:-0}" = 1 ] && exit 1
exit 0
SH

# set_line <path> <line-number> <text> — edit one line so a PR edit and a main edit to the same
# file stay on different lines and git merges them cleanly.
set_line() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, n, text = sys.argv[1], int(sys.argv[2]), sys.argv[3]
lines = open(path, encoding="utf-8").read().splitlines()
while len(lines) < n:
    lines.append("")
lines[n - 1] = text
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
}

# new_repo <name> — a base tree with one file per surface the cases need, `main` committed and
# `refs/remotes/origin/main` pointing at it, checked out on branch `feat`.
new_repo() {
  R="$T/$1"; rm -rf "$R"; mkdir -p "$R"
  g init -q -b main || fail "$1: git init"
  g config user.name tester; g config user.email owner@example.com; g config commit.gpgsign false
  mkdir -p "$R/ui/src/pages" "$R/ui/src/lib" "$R/internal/api" "$R/internal/workspace" \
           "$R/rsi/runtime/tests" "$R/docs/product" "$R/web/dist" "$R/scripts"
  # Three lines: a PR edit on line 1 and a main edit on line 3 leave a context line between them,
  # so a case may move the same file on both sides without manufacturing a source conflict.
  printf 'top\nmiddle\nbottom\n' > "$R/ui/src/pages/SettingsPage.tsx"
  printf 'top\nmiddle\nbottom\n' > "$R/ui/src/pages/ProjectDetailPage.tsx"
  printf 'top\nmiddle\nbottom\n' > "$R/ui/src/lib/useMachines.ts"
  printf 'top\nmiddle\nbottom\n' > "$R/internal/api/tasks.go"
  printf 'top\nmiddle\nbottom\n' > "$R/internal/workspace/diff.go"
  printf 'top\nmiddle\nbottom\n' > "$R/rsi/runtime/release.sh"
  printf 'taste\n' > "$R/docs/product/TASTE.md"
  printf 'dist-ok\n' > "$R/web/dist/index.html"
  printf '{}\n' > "$R/scripts/ui-inventory-baseline.json"
  g add -A >/dev/null && g commit -q -m base || fail "$1: base commit"
  g update-ref refs/remotes/origin/main HEAD
  g checkout -q -b feat
}

# commit_pr <name> — commit the PR edits on feat and snapshot its changed paths the way the land
# loop does (CH = diff origin/main...HEAD) before main moves.
commit_pr() {
  g add -A >/dev/null && g commit -q -m "pr $1" || fail "$1: pr commit"
  g diff --name-only origin/main...HEAD > "$T/$1.ch"
}

# move_main <name> — commit the main edits (already written on `main`), publish origin/main,
# merge it into the PR branch, and leave NEWSHA as the merged head.
move_main() {
  g add -A >/dev/null && g commit -q -m "main $1" || fail "$1: main commit"
  g update-ref refs/remotes/origin/main main
  g checkout -q feat || fail "$1: checkout feat"
  g merge -q --no-edit origin/main >/dev/null 2>&1 || fail "$1: merge of origin/main conflicted"
  NEWSHA="$(g rev-parse HEAD)"
}

# check <name> <incoming-paths...> — call the seam with the PR's changed paths, the incoming
# main paths and a gate file that currently holds a PASS for the pre-merge head.
check() {
  local name="$1"; shift
  mkdir -p "$T/state/merge"
  V="$T/state/merge/$name.verified"
  echo "old PASS reviewer" > "$V"
  printf '%s\n' "$@" > "$T/$name.incoming"
  RSI_CTRL="$T/ctrl" \
  RSI_DIST_BUILD_CMD="bash $T/dist-stub.sh" \
  RSI_INV_CHECK_CMD="bash $T/inv-stub.sh" \
  STUB_DIST_FAIL="${STUB_DIST_FAIL:-0}" STUB_INV_FAIL="${STUB_INV_FAIL:-0}" \
  STUB_DIST_TEXT="${STUB_DIST_TEXT:-dist-ok}" \
    bash "$MERGE" --carry-check "$R" "$T/$name.incoming" "$T/$name.ch" "$V" "$NEWSHA" reviewer \
    > "$T/$name.out" 2>&1
  RC=$?
}

expect_carry() { # name
  [ "$RC" -eq 0 ] || fail "$1: re-gated, expected a carry ($(tr '\n' ' ' < "$T/$1.out"))"
  [ "$(cat "$V" 2>/dev/null)" = "$NEWSHA PASS reviewer" ] \
    || fail "$1: gate file is '$(cat "$V" 2>/dev/null)', want '$NEWSHA PASS reviewer'"
}
expect_regate() { # name
  [ "$RC" -ne 0 ] || fail "$1: carried, expected a re-gate ($(tr '\n' ' ' < "$T/$1.out"))"
  [ ! -e "$V" ] || fail "$1: gate file still present after a re-gate"
}

reset_stubs() { unset STUB_DIST_FAIL STUB_INV_FAIL STUB_DIST_TEXT; }

# --- cases -------------------------------------------------------------------------------------

# The motivating case: a PR that only touches rsi/runtime/*.sh is carried past a main move in a
# UI page and an unrelated Go package. Today's blanket CODE_RE re-gates this.
test_carries_loop_infra_pr_past_unrelated_moves() {
  reset_stubs; new_repo c1
  set_line "$R/rsi/runtime/release.sh" 1 pr
  printf 'pr test\n' > "$R/rsi/runtime/tests/test-release.sh"
  commit_pr c1
  g checkout -q main
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 main
  set_line "$R/internal/workspace/diff.go" 1 main
  move_main c1
  check c1 ui/src/pages/SettingsPage.tsx internal/workspace/diff.go
  expect_carry c1
}

# Two UI slices landing together: another page moving in the same directory does not invalidate
# this page's gate. Today the directory-level DISJOINT_LEAF check re-gates this.
test_carries_page_pr_past_another_pages_move() {
  reset_stubs; new_repo c2
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr c2
  g checkout -q main
  set_line "$R/ui/src/pages/ProjectDetailPage.tsx" 1 main
  move_main c2
  check c2 ui/src/pages/ProjectDetailPage.tsx
  expect_carry c2
}

# Main moving the PR's own page invalidates the gate.
test_regates_when_main_moves_the_prs_own_page() {
  reset_stubs; new_repo c3
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr c3
  g checkout -q main
  set_line "$R/ui/src/pages/SettingsPage.tsx" 3 main
  move_main c3
  check c3 ui/src/pages/SettingsPage.tsx
  expect_regate c3
}

# A shared UI surface can change what the PR's own tests mean: never carry past it.
test_regates_when_main_moves_a_shared_surface() {
  reset_stubs; new_repo c4
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr c4
  g checkout -q main
  set_line "$R/ui/src/lib/useMachines.ts" 1 main
  move_main c4
  check c4 ui/src/lib/useMachines.ts
  expect_regate c4
}

# A Go package the PR itself changes re-gates when main moves that package (directory-level rule).
test_regates_when_main_moves_the_prs_own_go_package() {
  reset_stubs; new_repo c5
  set_line "$R/internal/workspace/diff.go" 1 pr
  commit_pr c5
  g checkout -q main
  set_line "$R/internal/workspace/diff.go" 3 main
  move_main c5
  check c5 internal/workspace/diff.go
  expect_regate c5
}

# internal/api/ is a shared Go surface: it re-gates even for a PR in another area.
test_regates_when_main_moves_the_shared_go_api() {
  reset_stubs; new_repo c6
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr c6
  g checkout -q main
  set_line "$R/internal/api/tasks.go" 1 main
  move_main c6
  check c6 internal/api/tasks.go
  expect_regate c6
}

# The post-merge UI safety step is the gate's own evidence: if the merged tree no longer checks
# the inventory ratchet, no longer builds, or no longer reproduces the committed dist, re-gate.
test_regates_when_the_ui_safety_step_fails() {
  reset_stubs; new_repo c7
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr c7
  g checkout -q main
  set_line "$R/ui/src/pages/ProjectDetailPage.tsx" 1 main
  move_main c7
  STUB_DIST_FAIL=1; check c7 ui/src/pages/ProjectDetailPage.tsx; expect_regate c7
  reset_stubs
  STUB_INV_FAIL=1; check c7 ui/src/pages/ProjectDetailPage.tsx; expect_regate c7
  reset_stubs
  STUB_DIST_TEXT=dist-other; check c7 ui/src/pages/ProjectDetailPage.tsx; expect_regate c7
  g diff --quiet -- web/dist/index.html || fail "c7: a changed dist was not restored"
  reset_stubs
}

# Regression guard: non-code main moves were already carried; they still are.
test_keeps_the_non_code_carry() {
  reset_stubs; new_repo c8
  set_line "$R/rsi/runtime/release.sh" 1 pr
  commit_pr c8
  g checkout -q main
  set_line "$R/docs/product/TASTE.md" 1 main
  move_main c8
  check c8 docs/product/TASTE.md rsi/runtime/merge.sh web/dist/index.html
  expect_carry c8
}

# The land loop must not continue into ci_state after a carry: seconds after sync_main pushed the
# carried head there are no checks yet, and ci_state reads an empty check list as green, so the same
# process could squash-merge the carried head before CI ever ran. The loop itself needs gh and a
# remote, so pin its control flow in the source, as node-stamp-test.sh does for its own guards.
test_carry_exits_the_land_loop_before_ci_state() {
  grep -qF 'SHA="$NEWSHA"; continue' "$MERGE" \
    && fail "carry still continues into ci_state in the same process"
  grep -qF 'SHA="$NEWSHA"; exit 0' "$MERGE" \
    || fail "carry does not exit the land loop for CI to report on the next cycle"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$1" || exit 1
  pass "$1"
}

run test_carries_loop_infra_pr_past_unrelated_moves
run test_carries_page_pr_past_another_pages_move
run test_regates_when_main_moves_the_prs_own_page
run test_regates_when_main_moves_a_shared_surface
run test_regates_when_main_moves_the_prs_own_go_package
run test_regates_when_main_moves_the_shared_go_api
run test_regates_when_the_ui_safety_step_fails
run test_keeps_the_non_code_carry
run test_carry_exits_the_land_loop_before_ci_state
echo ALL-PASS
