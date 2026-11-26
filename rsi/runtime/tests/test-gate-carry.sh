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
# carry it rewrites the gate file with the merged head SHA, on a re-gate it removes it. The queue
# cases exercise --queue-carry-check, the step-1 seam: the same predicate, applied right after the
# verifier merges origin/main into the PR branch, refusing a stale gate and an unmoved main.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
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

# The RN safety step runs with cwd = the repo root, exactly like the default
# `cd mobile-rn && npx tsc --noEmit && npx jest --ci && cd .. && python3 scripts/stories.py`.
cat > "$T/rn-stub.sh" <<'SH'
#!/bin/bash
set -eu
[ -d mobile-rn ] || exit 1
[ "${STUB_RN_FAIL:-0}" = 1 ] && exit 1
[ "${STUB_RN_SLEEP:-0}" = 1 ] && sleep 30
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
           "$R/rsi/runtime/tests" "$R/docs/product" "$R/web/dist" "$R/scripts" \
           "$R/mobile-rn/src/screens" "$R/mobile-rn/scripts"
  # Three lines: a PR edit on line 1 and a main edit on line 3 leave a context line between them,
  # so a case may move the same file on both sides without manufacturing a source conflict.
  printf 'top\nmiddle\nbottom\n' > "$R/ui/src/pages/SettingsPage.tsx"
  printf 'top\nmiddle\nbottom\n' > "$R/ui/src/pages/ProjectDetailPage.tsx"
  printf 'top\nmiddle\nbottom\n' > "$R/ui/src/lib/useMachines.ts"
  printf 'top\nmiddle\nbottom\n' > "$R/internal/api/tasks.go"
  printf 'top\nmiddle\nbottom\n' > "$R/internal/workspace/diff.go"
  printf 'top\nmiddle\nbottom\n' > "$R/rsi/runtime/release.sh"
  printf 'top\nmiddle\nbottom\n' > "$R/mobile-rn/src/screens/Usage.tsx"
  printf 'top\nmiddle\nbottom\n' > "$R/mobile-rn/src/screens/Queue.tsx"
  printf 'top\nmiddle\nbottom\n' > "$R/mobile-rn/src/screens/Queue.test.tsx"
  printf '{\n"name": "rn",\n"private": true\n}\n' > "$R/mobile-rn/package.json"
  printf 'top\nmiddle\nbottom\n' > "$R/mobile-rn/metro.config.js"
  printf '#!/bin/bash\necho rn\n' > "$R/mobile-rn/scripts/sim.sh"
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
  RSI_RN_CHECK_CMD="bash $T/rn-stub.sh" STUB_RN_FAIL="${STUB_RN_FAIL:-0}" \
  RSI_RN_CHECK_TIMEOUT="${RSI_RN_CHECK_TIMEOUT:-900}" STUB_RN_SLEEP="${STUB_RN_SLEEP:-0}" \
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

reset_stubs() { unset STUB_DIST_FAIL STUB_INV_FAIL STUB_DIST_TEXT STUB_RN_FAIL STUB_RN_SLEEP RSI_RN_CHECK_TIMEOUT; }

# --- queue-time seam helpers -------------------------------------------------------------------

# diff_hash — the review key the merge lane computes for the PR's own diff (step 4's DH).
diff_hash() { g diff origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json' | shasum | cut -c1-16; }

# write_gate <name> <head> — the state a previous cycle leaves behind: a gate verified on <head>
# and a PASS review keyed by the PR's diff hash. Must run on feat at the PR head.
write_gate() {
  mkdir -p "$T/state/merge"
  QUEUE_V="$T/state/merge/$1.verified"; QUEUE_RV="$T/state/merge/$1.reviewed"; QUEUE_DH="$(diff_hash)"
  [ -n "$QUEUE_DH" ] || fail "$1: no diff hash (shasum missing?)"
  echo "$2 PASS reviewer" > "$QUEUE_V"
  echo "$QUEUE_DH PASS $2 reviewer" > "$QUEUE_RV"
}

# queue_check <name> <pre-sync-head> [incoming-paths...] — call the step-1 seam with the gate and
# reviewed files write_gate left behind, the PR's changed paths and the main move's paths.
queue_check() {
  local name="$1" old="$2"; shift 2
  printf '%s\n' "$@" > "$T/$name.qincoming"
  RSI_CTRL="$T/ctrl" \
  RSI_DIST_BUILD_CMD="bash $T/dist-stub.sh" \
  RSI_INV_CHECK_CMD="bash $T/inv-stub.sh" \
  RSI_RN_CHECK_CMD="bash $T/rn-stub.sh" STUB_RN_FAIL="${STUB_RN_FAIL:-0}" \
  RSI_RN_CHECK_TIMEOUT="${RSI_RN_CHECK_TIMEOUT:-900}" STUB_RN_SLEEP="${STUB_RN_SLEEP:-0}" \
  STUB_DIST_FAIL="${STUB_DIST_FAIL:-0}" STUB_INV_FAIL="${STUB_INV_FAIL:-0}" \
  STUB_DIST_TEXT="${STUB_DIST_TEXT:-dist-ok}" \
    bash "$MERGE" --queue-carry-check "$R" "$old" "$NEWSHA" "$T/$name.qincoming" "$T/$name.ch" \
      "$QUEUE_V" "$QUEUE_RV" reviewer > "$T/$name.qout" 2>&1
  RC=$?
}

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

# A PR that changes neither scripts/ nor ui/ is unaffected by main creating a script the gate does
# not run. Today's blanket scripts/ shared-dir rule re-gates this.
test_carries_backend_pr_past_an_unrelated_scripts_move() {
  reset_stubs; new_repo c9
  set_line "$R/internal/workspace/diff.go" 1 pr
  commit_pr c9
  g checkout -q main
  printf '#!/bin/bash\necho desktop\n' > "$R/scripts/desktop-startup.sh"
  move_main c9
  check c9 scripts/desktop-startup.sh
  expect_carry c9
}

# scripts/check.sh is the whole gate body: a move to it changes what every PR's verification means.
test_regates_when_main_moves_check_sh() {
  reset_stubs; new_repo c10
  set_line "$R/internal/workspace/diff.go" 1 pr
  commit_pr c10
  g checkout -q main
  printf '#!/bin/bash\necho gate\n' > "$R/scripts/check.sh"
  move_main c10
  check c10 scripts/check.sh
  expect_regate c10
}

# A script the gate starts (here the inventory ratchet) is gate-relevant even for a PR far from it.
test_regates_when_main_moves_a_gate_script() {
  reset_stubs; new_repo c11
  set_line "$R/internal/workspace/diff.go" 1 pr
  commit_pr c11
  g checkout -q main
  printf '#!/usr/bin/env python3\n' > "$R/scripts/check-ui-inventory.py"
  move_main c11
  check c11 scripts/check-ui-inventory.py
  expect_regate c11
}

# A PR that edits scripts/ is in the surface itself: any script move may change what its own gate
# or runtime behaviour means, so it re-gates even when the moved script is not one the gate runs.
test_regates_when_the_pr_touches_scripts_for_a_scripts_move() {
  reset_stubs; new_repo c12
  printf '#!/bin/bash\npr\n' > "$R/scripts/foo.sh"
  commit_pr c12
  g checkout -q main
  printf '#!/bin/bash\necho desktop\n' > "$R/scripts/desktop-startup.sh"
  move_main c12
  check c12 scripts/desktop-startup.sh
  expect_regate c12
}

# A UI PR's gate ends in the inventory, lint-guard and vitest jobs the gate scripts drive, so a
# script move can change how its tree is judged: never carry a UI PR past one.
test_regates_when_the_pr_touches_ui_for_a_scripts_move() {
  reset_stubs; new_repo c13
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr c13
  g checkout -q main
  printf '#!/bin/bash\necho desktop\n' > "$R/scripts/desktop-startup.sh"
  move_main c13
  check c13 scripts/desktop-startup.sh
  expect_regate c13
}

# The deny-list's completeness pin: every scripts/ path the real gate body mentions must re-gate.
# A script the gate starts later and nobody adds to GATE_SCRIPTS fails here instead of silently
# carrying. Comments are scanned too: extra tokens only make the deny-list stricter, a miss is
# what would let a real gate script carry. The gate also starts scripts that start or import other
# scripts, so every script named by the gate body or the deny-list is scanned one level down as
# well; trailing prose punctuation is stripped and only .sh/.py/.mjs files are followed, because the
# inventory baseline and the fake-agent binary are not scripts the gate starts.
test_regates_every_script_the_gate_runs() {
  reset_stubs; new_repo c14
  set_line "$R/internal/workspace/diff.go" 1 pr
  commit_pr c14
  g checkout -q main
  printf '#!/bin/bash\necho desktop\n' > "$R/scripts/desktop-startup.sh"
  move_main c14
  local p seen=0
  {
    grep -oE 'scripts/[A-Za-z0-9._/-]+' "$ROOT/scripts/check.sh"
    sed -n '/^GATE_SCRIPTS = {$/,/^}$/p' "$MERGE" | grep -oE 'scripts/[A-Za-z0-9._/-]+'
  } | sort -u > "$T/gate-named.txt"
  while IFS= read -r p; do
    [ -f "$ROOT/$p" ] && grep -oE 'scripts/[A-Za-z0-9._/-]+' "$ROOT/$p"
  done < "$T/gate-named.txt" > "$T/gate-onelevel.txt"
  grep -qxF 'scripts/ui-inventory-baseline.json' "$T/gate-onelevel.txt" \
    || fail "c14: the one-level scan did not follow check-ui-inventory.py to its baseline; the scan is broken"
  cat "$T/gate-named.txt" "$T/gate-onelevel.txt" \
    | sed -e 's/[.,;:)]*$//' | grep -E '\.(sh|py|mjs)$' | sort -u > "$T/gate-scripts.txt"
  grep -qxF 'scripts/check.sh' "$T/gate-scripts.txt" \
    || fail "c14: the gate-body scan did not find scripts/check.sh; the scan is broken"
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    check c14 "$p"
    expect_regate c14
    seen=$(( seen + 1 ))
  done < "$T/gate-scripts.txt"
  [ "$seen" -ge 11 ] \
    || fail "c14: scanned only $seen gate scripts; the scan is broken or scripts/check.sh lost a job"
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

# The queue-time carry has the same hazard: step 1 pushed the merged head, so seconds later the
# step-6 land loop's ci_state would read an empty check list as green and could squash-merge the
# carried head before CI ran. The success branch must record the carry, and the process must exit
# before the land loop — mirroring the land-time carry pinned above.
test_queue_carry_exits_before_the_land_loop() {
  local setline guardline loopline
  grep -A1 -F 'if queue_carry_step "$WT"' "$MERGE" | grep -qF 'QUEUE_CARRIED=1' \
    || fail "the queue carry success branch does not set QUEUE_CARRIED=1"
  setline="$(grep -nF 'QUEUE_CARRIED=1' "$MERGE" | head -1 | cut -d: -f1)"
  guardline="$(grep -nF '${QUEUE_CARRIED:-0}' "$MERGE" | head -1 | cut -d: -f1)"
  loopline="$(grep -nF 'for round in 1 2 3; do' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$guardline" ] || fail "no QUEUE_CARRIED guard exits before the step-6 land loop"
  [ -n "$loopline" ] || fail "no step-6 land loop in $MERGE"
  [ "$setline" -lt "$guardline" ] && [ "$guardline" -lt "$loopline" ] \
    || fail "the queue-carry exit ($guardline) is not between the carry ($setline) and the land loop ($loopline)"
  sed -n "${guardline},${loopline}p" "$MERGE" | grep -qF 'exit 0' \
    || fail "a queue-carried gate falls through into the step-6 land loop"
}

# --- queue-time carry cases --------------------------------------------------------------------

# The motivating case: step 1 merged a disjoint main move into a PR whose gate was verified on the
# pre-sync head. The gate must move to the merged head and the DH-keyed review cache too, so the
# PR does not pay for a full fresh gate.
test_queue_carries_disjoint_main_move() {
  reset_stubs; new_repo q1
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr q1
  OLD="$(g rev-parse HEAD)"; write_gate q1 "$OLD"
  g checkout -q main
  set_line "$R/ui/src/pages/ProjectDetailPage.tsx" 1 main
  set_line "$R/internal/workspace/diff.go" 1 main
  move_main q1
  queue_check q1 "$OLD" ui/src/pages/ProjectDetailPage.tsx internal/workspace/diff.go
  [ "$RC" -eq 0 ] || fail "q1: re-gated, expected a carry ($(tr '\n' ' ' < "$T/q1.qout"))"
  [ "$(cat "$QUEUE_V" 2>/dev/null)" = "$NEWSHA PASS reviewer" ] \
    || fail "q1: gate file is '$(cat "$QUEUE_V" 2>/dev/null)', want '$NEWSHA PASS reviewer'"
  [ "$(cat "$QUEUE_RV" 2>/dev/null)" = "$QUEUE_DH PASS $NEWSHA reviewer" ] \
    || fail "q1: reviewed file is '$(cat "$QUEUE_RV" 2>/dev/null)', want '$QUEUE_DH PASS $NEWSHA reviewer'"
}

# The same scripts-leaf case through the step-1 seam: a backend PR carries past a main move in a
# script the gate does not run, and the DH-keyed review cache moves with it.
test_queue_carries_backend_pr_past_an_unrelated_scripts_move() {
  reset_stubs; new_repo q7
  set_line "$R/internal/workspace/diff.go" 1 pr
  commit_pr q7
  OLD="$(g rev-parse HEAD)"; write_gate q7 "$OLD"
  g checkout -q main
  printf '#!/bin/bash\necho desktop\n' > "$R/scripts/desktop-startup.sh"
  move_main q7
  queue_check q7 "$OLD" scripts/desktop-startup.sh
  [ "$RC" -eq 0 ] || fail "q7: re-gated, expected a carry ($(tr '\n' ' ' < "$T/q7.qout"))"
  [ "$(cat "$QUEUE_V" 2>/dev/null)" = "$NEWSHA PASS reviewer" ] \
    || fail "q7: gate file is '$(cat "$QUEUE_V" 2>/dev/null)', want '$NEWSHA PASS reviewer'"
  [ "$(cat "$QUEUE_RV" 2>/dev/null)" = "$QUEUE_DH PASS $NEWSHA reviewer" ] \
    || fail "q7: reviewed file is '$(cat "$QUEUE_RV" 2>/dev/null)', want '$QUEUE_DH PASS $NEWSHA reviewer'"
}

# Main moving the PR's own file invalidates the gate: gated on the merged tree it may now behave
# differently, and the review cache is left alone (the review path re-decides from DH).
test_queue_regates_when_main_moves_the_prs_own_file() {
  reset_stubs; new_repo q2
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr q2
  OLD="$(g rev-parse HEAD)"; write_gate q2 "$OLD"; BEFORE_RV="$(cat "$QUEUE_RV")"
  g checkout -q main
  set_line "$R/ui/src/pages/SettingsPage.tsx" 3 main
  move_main q2
  queue_check q2 "$OLD" ui/src/pages/SettingsPage.tsx
  [ "$RC" -ne 0 ] || fail "q2: carried, expected a re-gate ($(tr '\n' ' ' < "$T/q2.qout"))"
  [ ! -e "$QUEUE_V" ] || fail "q2: gate file still present after a re-gate"
  [ "$(cat "$QUEUE_RV" 2>/dev/null)" = "$BEFORE_RV" ] || fail "q2: reviewed file changed on a re-gate"
}

# A shared UI surface can change what the PR's own tests mean: never carry past it.
test_queue_regates_when_main_moves_a_shared_surface() {
  reset_stubs; new_repo q3
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr q3
  OLD="$(g rev-parse HEAD)"; write_gate q3 "$OLD"
  g checkout -q main
  set_line "$R/ui/src/lib/useMachines.ts" 1 main
  move_main q3
  queue_check q3 "$OLD" ui/src/lib/useMachines.ts
  [ "$RC" -ne 0 ] || fail "q3: carried past a shared surface ($(tr '\n' ' ' < "$T/q3.qout"))"
  [ ! -e "$QUEUE_V" ] || fail "q3: gate file still present after a re-gate"
}

# A gate that names an older head is not evidence for the pre-sync head, so even a disjoint move
# must not carry it. Nothing is rewritten: the normal gate path decides.
test_queue_no_carry_when_head_is_stale() {
  reset_stubs; new_repo q4
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr q4
  OLD="$(g rev-parse HEAD)"; STALE="$(g rev-parse HEAD~1)"
  mkdir -p "$T/state/merge"
  QUEUE_V="$T/state/merge/q4.verified"; QUEUE_RV="$T/state/merge/q4.reviewed"
  echo "$STALE PASS reviewer" > "$QUEUE_V"
  echo "$(diff_hash) PASS $STALE reviewer" > "$QUEUE_RV"
  g checkout -q main
  set_line "$R/ui/src/pages/ProjectDetailPage.tsx" 1 main
  move_main q4
  queue_check q4 "$OLD" ui/src/pages/ProjectDetailPage.tsx
  [ "$RC" -ne 0 ] || fail "q4: carried a gate that names $STALE, not the pre-sync head ($(tr '\n' ' ' < "$T/q4.qout"))"
  [ "$(cat "$QUEUE_V" 2>/dev/null)" = "$STALE PASS reviewer" ] || fail "q4: a stale gate was rewritten"
}

# No main move means there is nothing to carry: the gate already names the head, so it must be
# left where the normal NEED_GATE check finds it.
test_queue_no_carry_when_main_did_not_move() {
  reset_stubs; new_repo q5
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr q5
  OLD="$(g rev-parse HEAD)"; write_gate q5 "$OLD"; NEWSHA="$OLD"
  queue_check q5 "$OLD"
  [ "$RC" -ne 0 ] || fail "q5: carried without a main move ($(tr '\n' ' ' < "$T/q5.qout"))"
  [ "$(cat "$QUEUE_V" 2>/dev/null)" = "$OLD PASS reviewer" ] || fail "q5: gate was rewritten without a main move"
}

# The ui-leaf safety step is part of the predicate: when the merged tree fails the inventory
# ratchet or the dist rebuild changes web/dist/index.html, step 1 must propagate the re-gate.
test_queue_ui_leaf_safety_failure_regates() {
  reset_stubs; new_repo q6
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr q6
  OLD="$(g rev-parse HEAD)"; write_gate q6 "$OLD"
  g checkout -q main
  set_line "$R/ui/src/pages/ProjectDetailPage.tsx" 1 main
  move_main q6
  STUB_INV_FAIL=1; queue_check q6 "$OLD" ui/src/pages/ProjectDetailPage.tsx
  [ "$RC" -ne 0 ] || fail "q6: carried although the inventory check failed ($(tr '\n' ' ' < "$T/q6.qout"))"
  [ ! -e "$QUEUE_V" ] || fail "q6: gate file still present after the inventory check failed"
  reset_stubs
  write_gate q6 "$OLD"
  STUB_DIST_TEXT=dist-other; queue_check q6 "$OLD" ui/src/pages/ProjectDetailPage.tsx
  [ "$RC" -ne 0 ] || fail "q6: carried although the dist rebuild changed web/dist/index.html ($(tr '\n' ' ' < "$T/q6.qout"))"
  [ ! -e "$QUEUE_V" ] || fail "q6: gate file still present after the dist check failed"
  g diff --quiet -- web/dist/index.html || fail "q6: a changed dist was not restored"
  reset_stubs
}

# --- mobile-rn cases ---------------------------------------------------------------------------

# The motivating RN case: one RN screen's PR is carried past another RN screen and its test landing,
# once the RN safety step (tsc+jest+stories) passes on the merged tree. Before, every mobile-rn path
# was "unclassified" and re-gated.
test_carries_rn_pr_past_another_rn_screen_move() {
  reset_stubs; new_repo r1
  set_line "$R/mobile-rn/src/screens/Usage.tsx" 1 pr
  commit_pr r1
  g checkout -q main
  set_line "$R/mobile-rn/src/screens/Queue.tsx" 1 main
  set_line "$R/mobile-rn/src/screens/Queue.test.tsx" 1 main
  move_main r1
  check r1 mobile-rn/src/screens/Queue.tsx mobile-rn/src/screens/Queue.test.tsx
  expect_carry r1
  grep -q 'mobile-rn tsc+jest+stories green' "$T/r1.out" || fail "r1: carry reason does not name the RN step ($(cat "$T/r1.out"))"
}

# Main moving the RN PR's own file invalidates the gate.
test_regates_when_main_moves_the_rn_prs_own_file() {
  reset_stubs; new_repo r2
  set_line "$R/mobile-rn/src/screens/Usage.tsx" 1 pr
  commit_pr r2
  g checkout -q main
  set_line "$R/mobile-rn/src/screens/Usage.tsx" 3 main
  move_main r2
  check r2 mobile-rn/src/screens/Usage.tsx
  expect_regate r2
}

# The RN toolchain changes how every RN file compiles and runs: never carry past it.
test_regates_when_main_moves_the_rn_toolchain() {
  local f
  for f in mobile-rn/package.json mobile-rn/metro.config.js mobile-rn/scripts/sim.sh; do
    reset_stubs; new_repo r3
    set_line "$R/mobile-rn/src/screens/Usage.tsx" 1 pr
    commit_pr r3
    g checkout -q main
    set_line "$R/$f" 2 main
    move_main r3
    check r3 "$f"
    expect_regate r3
    grep -q 'RN toolchain moved' "$T/r3.out" || fail "r3: $f re-gated for the wrong reason ($(cat "$T/r3.out"))"
  done
}

# The RN safety step is the gate's own evidence: a red tsc/jest/stories on the merged tree re-gates.
test_regates_when_the_rn_safety_step_fails() {
  reset_stubs; new_repo r4
  set_line "$R/mobile-rn/src/screens/Usage.tsx" 1 pr
  commit_pr r4
  g checkout -q main
  set_line "$R/mobile-rn/src/screens/Queue.tsx" 1 main
  move_main r4
  STUB_RN_FAIL=1; check r4 mobile-rn/src/screens/Queue.tsx; expect_regate r4
  grep -q 'rn safety step failed' "$T/r4.out" || fail "r4: re-gate reason does not name the RN step ($(cat "$T/r4.out"))"
  reset_stubs
}

# The RN safety step is bounded: a hung tsc/jest on the merged tree must re-gate inside the timeout
# window instead of wedging the land loop (AGENTS.md rule 13).
test_regates_when_the_rn_safety_step_times_out() {
  reset_stubs; new_repo r7
  set_line "$R/mobile-rn/src/screens/Usage.tsx" 1 pr
  commit_pr r7
  g checkout -q main
  set_line "$R/mobile-rn/src/screens/Queue.tsx" 1 main
  move_main r7
  RSI_RN_CHECK_TIMEOUT=1 STUB_RN_SLEEP=1
  check r7 mobile-rn/src/screens/Queue.tsx
  expect_regate test_regates_when_the_rn_safety_step_times_out
  grep -q 'rn safety step failed' "$T/r7.out" \
    || fail "test_regates_when_the_rn_safety_step_times_out: re-gate reason does not name the RN step ($(cat "$T/r7.out"))"
  reset_stubs
}

# A ui leaf and an RN leaf landing together need both safety steps: either one red re-gates.
test_carry_ui_rn_runs_both_steps() {
  reset_stubs; new_repo r5
  set_line "$R/mobile-rn/src/screens/Usage.tsx" 1 pr
  commit_pr r5
  g checkout -q main
  set_line "$R/ui/src/pages/ProjectDetailPage.tsx" 1 main
  set_line "$R/mobile-rn/src/screens/Queue.tsx" 1 main
  move_main r5
  STUB_RN_FAIL=1; check r5 ui/src/pages/ProjectDetailPage.tsx mobile-rn/src/screens/Queue.tsx; expect_regate r5
  reset_stubs
  STUB_INV_FAIL=1; check r5 ui/src/pages/ProjectDetailPage.tsx mobile-rn/src/screens/Queue.tsx; expect_regate r5
  reset_stubs
  check r5 ui/src/pages/ProjectDetailPage.tsx mobile-rn/src/screens/Queue.tsx; expect_carry r5
  grep -q 'inventory+build green.*mobile-rn tsc+jest+stories green' "$T/r5.out" \
    || fail "r5: carry reason does not name both steps ($(cat "$T/r5.out"))"
}

# A ui-only PR is carried past an RN leaf move once the RN step re-proves the merged tree (mobile-rn
# imports ui/src, so the step is not skipped for a ui PR).
test_carries_ui_pr_past_an_rn_leaf_move() {
  reset_stubs; new_repo r6
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr r6
  g checkout -q main
  set_line "$R/mobile-rn/src/screens/Queue.tsx" 1 main
  move_main r6
  check r6 mobile-rn/src/screens/Queue.tsx; expect_carry r6
  STUB_RN_FAIL=1; echo "old PASS reviewer" > "$V"; check r6 mobile-rn/src/screens/Queue.tsx; expect_regate r6
  reset_stubs
}

# The same RN safety step guards the step-1 seam.
test_queue_rn_leaf_safety_failure_regates() {
  reset_stubs; new_repo q8
  set_line "$R/mobile-rn/src/screens/Usage.tsx" 1 pr
  commit_pr q8
  OLD="$(g rev-parse HEAD)"; write_gate q8 "$OLD"
  g checkout -q main
  set_line "$R/mobile-rn/src/screens/Queue.tsx" 1 main
  move_main q8
  STUB_RN_FAIL=1; queue_check q8 "$OLD" mobile-rn/src/screens/Queue.tsx
  [ "$RC" -ne 0 ] || fail "q8: carried although the RN step failed ($(tr '\n' ' ' < "$T/q8.qout"))"
  [ ! -e "$QUEUE_V" ] || fail "q8: gate file still present after the RN step failed"
  reset_stubs
  write_gate q8 "$OLD"
  queue_check q8 "$OLD" mobile-rn/src/screens/Queue.tsx
  [ "$RC" -eq 0 ] || fail "q8: re-gated although the RN step passed ($(tr '\n' ' ' < "$T/q8.qout"))"
  [ "$(cat "$QUEUE_V" 2>/dev/null)" = "$NEWSHA PASS reviewer" ] \
    || fail "q8: gate file is '$(cat "$QUEUE_V" 2>/dev/null)', want '$NEWSHA PASS reviewer'"
}

# --- reverify_reason: WHY a gate that already ran is paid for again -----------------------------

# rr <prior-gate-sha> <prior-diff-key> <current-diff-key> <prior-reachable> <incoming> <carry-reason> [current-head]
# — the pure classifier the gate-start accounting line writes into state/merge/cycles.log. It labels
# the re-verification only; no gate, lock or verdict reads it back. The optional current head lets a
# head moved by a main sync read as land-sync; an omitted head fails closed to rework.
rr() { RSI_CTRL="$T/ctrl" bash "$MERGE" --reverify-reason-check "$@"; }

# pc <pr> <verified-file> <reviewed-file> <gate-head-file> — the capture step 1 feeds the accounting
# line with, over files on disk.
pc() { RSI_CTRL="$T/ctrl" bash "$MERGE" --prior-gate-check "$@"; }

want_rr() { # <want> <args...>
  local want="$1" got; shift
  got="$(rr "$@")" || fail "reverify_reason $* exited non-zero"
  [ "$got" = "$want" ] || fail "reverify_reason $* -> '$got', want '$want'"
}

# No prior gate head: the denominator, not a re-verification.
test_reverify_reason_first_gate() {
  want_rr first-gate "" "" c0ffee11deadbeef 1 "ui/src/pages/X.tsx" "the PR's own file moved: ui/src/pages/X.tsx"
}

# The PR's own code changed between gates: a genuine rework, whatever main did.
test_reverify_reason_rework_when_the_pr_diff_changed() {
  want_rr rework aaaa1111 bbbb2222 cccc3333 1 "ui/src/pages/X.tsx" "the PR's own file moved: ui/src/pages/X.tsx"
}

# The branch was rewritten (force-push/rebase): the old gate head is no longer an ancestor.
test_reverify_reason_rework_when_the_branch_was_rewritten() {
  want_rr rework aaaa1111 cccc3333 cccc3333 0 "ui/src/pages/X.tsx" "the PR's own file moved: ui/src/pages/X.tsx"
}

# main moved a script the gate itself starts: every PR's verification now means something else.
test_reverify_reason_shared_surface_when_a_script_the_gate_runs_moved() {
  want_rr shared-surface aaaa1111 cccc3333 cccc3333 1 "scripts/check.sh" "the gate runs this script: scripts/check.sh"
}

# A PR in scripts/ or ui/ is the surface a moved script judges, so its gate is re-bought too.
test_reverify_reason_shared_surface_when_the_pr_touches_ui() {
  want_rr shared-surface aaaa1111 cccc3333 cccc3333 1 "scripts/desktop-startup.sh" "the PR touches scripts/ or ui/: ui/src/pages/X.tsx"
}

# main moved a path the PR does not verify, yet the carry refused, so the gate ran again: main-moved.
# (A move onto the PR's own file changes the three-dot diff key in production, so that records rework;
# this fixture is the pure-branch case.)
test_reverify_reason_main_moved_when_the_carry_refused() {
  want_rr main-moved aaaa1111 cccc3333 cccc3333 1 "ui/src/pages/X.tsx" "the gate names aaaa1111 (PASS), not the pre-sync head bbbb2222; not a carry candidate"
}

# Same head, same diff, no incoming paths: the earlier gate/verifier did not finish or did not pass.
test_reverify_reason_rework_when_nothing_else_moved() {
  want_rr rework aaaa1111 cccc3333 cccc3333 1 "" "origin/main did not move under the PR" aaaa1111
}

# The land loop merged origin/main into the branch during a CI hold: the head moved, the PR's own
# diff key did not, and no path came in. The gate a main sync bought is not a rework.
test_reverify_reason_land_sync_after_a_main_sync() {
  want_rr land-sync aaaa1111 cccc3333 cccc3333 1 "" "origin/main did not move under the PR" bbbb2222
}

# land-sync needs both halves of the evidence: a moved head is not enough when the diff key moved
# (the PR's own code changed) or the prior gate head is no longer an ancestor (rewritten branch).
test_reverify_reason_land_sync_requires_an_unchanged_diff_key() {
  want_rr rework aaaa1111 bbbb2222 cccc3333 1 "" "origin/main did not move under the PR" cccc3333
  want_rr rework aaaa1111 cccc3333 cccc3333 0 "" "origin/main did not move under the PR" cccc3333
}

# An empty prior review key is not evidence of a rework: it must not outrank the main-move rules.
test_reverify_reason_ignores_an_empty_prior_diff_key() {
  want_rr main-moved aaaa1111 "" cccc3333 1 "ui/src/pages/X.tsx" "the PR's own file moved: ui/src/pages/X.tsx"
}

# A gate that FAILED writes no verified/reviewed PASS line. The next cycle must still see the head
# that gate ran on and label the re-run rework, not first-gate (which would bias the retro's
# denominator and undercount rework).
test_reverify_reason_after_a_gate_fail_is_rework() {
  local v="$T/fa.verified" rv="$T/fa.reviewed" gh="$T/fa.gate-head" out
  rm -f "$v" "$rv"
  printf '4242 aaaa1111 dddd4444\n' > "$gh"
  out="$(pc 4242 "$v" "$rv" "$gh")" || fail "prior-gate capture exited non-zero"
  [ "$out" = "aaaa1111 dddd4444" ] || fail "gate-fail capture -> '$out', want 'aaaa1111 dddd4444'"
  # Six arguments: the current head is unknown, so act on the diff key alone. An unknown head must
  # never be read as "the head moved": fail closed to rework, not land-sync.
  want_rr rework "${out%% *}" "${out#* }" "${out#* }" 1 "" "origin/main did not move under the PR"
}

# A reused slug must not inherit a dead PR's gate head.
test_prior_gate_capture_ignores_another_prs_marker() {
  local v="$T/fa2.verified" rv="$T/fa2.reviewed" gh="$T/fa2.gate-head" out
  rm -f "$v" "$rv"
  printf '1111 aaaa1111 dddd4444\n' > "$gh"
  out="$(pc 4242 "$v" "$rv" "$gh")" || fail "prior-gate capture exited non-zero"
  [ "$out" = " " ] || fail "capture from PR #1111's marker -> '$out', want empty"
}

# The producer (queue carry) and the classifier (reverify_reason) must agree on the reason strings:
# a renamed 'shared surface moved' would silently degrade every such move to main-moved.
test_queue_regate_reason_classifies_as_shared_surface() {
  reset_stubs; new_repo q7
  set_line "$R/ui/src/pages/SettingsPage.tsx" 1 pr
  commit_pr q7
  OLD="$(g rev-parse HEAD)"; write_gate q7 "$OLD"
  g checkout -q main
  set_line "$R/ui/src/lib/useMachines.ts" 1 main
  move_main q7
  queue_check q7 "$OLD" ui/src/lib/useMachines.ts
  [ "$RC" -ne 0 ] || fail "q7: carried, expected a re-gate ($(tr '\n' ' ' < "$T/q7.qout"))"
  local reason; reason="$(sed -e 's/^REGATE[[:space:]]*//' "$T/q7.qout")"
  case "$reason" in
    *"shared surface moved"*) ;;
    *) fail "q7: REGATE reason '$reason' is not a shared-surface move" ;;
  esac
  want_rr shared-surface "$OLD" "$QUEUE_DH" "$QUEUE_DH" 1 "ui/src/lib/useMachines.ts" "$reason"
}

# Wiring pin, not the rule: the pure cases above prove the rule; this only proves the gate-start
# block calls it and writes the field before mklock, and that the seam exists. A string test proves
# a string (Watch 53) — do not read this case as evidence for the classifier.
test_reverify_reason_is_written_at_gate_start() {
  grep -qF -- '--reverify-reason-check' "$MERGE" || fail "no --reverify-reason-check seam in merge.sh"
  local gate lock
  gate="$(grep -nF 'if [ $NEED_GATE -eq 1 ]; then' "$MERGE" | head -1 | cut -d: -f1)"
  [ -n "$gate" ] || fail "no NEED_GATE block in merge.sh"
  lock="$(awk -v s="$gate" 'NR > s && /mklock /{ print NR; exit }' "$MERGE")"
  [ -n "$lock" ] || fail "no mklock after the NEED_GATE block"
  sed -n "${gate},${lock}p" "$MERGE" | grep -qF 'reverify_reason=' \
    || fail "the NEED_GATE block does not append reverify_reason= to cycles.log"
  sed -n "${gate},${lock}p" "$MERGE" | grep -qF 'reverify_reason "$PRIOR_GATE_SHA"' \
    || fail "the NEED_GATE block does not call reverify_reason with the captured prior gate"
  sed -n "${gate},${lock}p" "$MERGE" | grep -F 'reverify_reason ' | grep -qF '"$SHA"' \
    || fail "the NEED_GATE block does not pass the head it is about to gate (\$SHA) as the current head"
  sed -n "${gate},${lock}p" "$MERGE" | grep -qF -- '$SLUG.gate-head' \
    || fail "the NEED_GATE block does not write the gate-head marker before mklock"
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
run test_carries_backend_pr_past_an_unrelated_scripts_move
run test_regates_when_main_moves_check_sh
run test_regates_when_main_moves_a_gate_script
run test_regates_when_the_pr_touches_scripts_for_a_scripts_move
run test_regates_when_the_pr_touches_ui_for_a_scripts_move
run test_regates_every_script_the_gate_runs
run test_carry_exits_the_land_loop_before_ci_state
run test_queue_carry_exits_before_the_land_loop
run test_queue_carries_disjoint_main_move
run test_queue_carries_backend_pr_past_an_unrelated_scripts_move
run test_queue_regates_when_main_moves_the_prs_own_file
run test_queue_regates_when_main_moves_a_shared_surface
run test_queue_no_carry_when_head_is_stale
run test_queue_no_carry_when_main_did_not_move
run test_queue_ui_leaf_safety_failure_regates
run test_carries_rn_pr_past_another_rn_screen_move
run test_regates_when_main_moves_the_rn_prs_own_file
run test_regates_when_main_moves_the_rn_toolchain
run test_regates_when_the_rn_safety_step_fails
run test_regates_when_the_rn_safety_step_times_out
run test_carry_ui_rn_runs_both_steps
run test_carries_ui_pr_past_an_rn_leaf_move
run test_queue_rn_leaf_safety_failure_regates
run test_reverify_reason_first_gate
run test_reverify_reason_rework_when_the_pr_diff_changed
run test_reverify_reason_rework_when_the_branch_was_rewritten
run test_reverify_reason_shared_surface_when_a_script_the_gate_runs_moved
run test_reverify_reason_shared_surface_when_the_pr_touches_ui
run test_reverify_reason_main_moved_when_the_carry_refused
run test_reverify_reason_rework_when_nothing_else_moved
run test_reverify_reason_land_sync_after_a_main_sync
run test_reverify_reason_land_sync_requires_an_unchanged_diff_key
run test_reverify_reason_ignores_an_empty_prior_diff_key
run test_reverify_reason_after_a_gate_fail_is_rework
run test_prior_gate_capture_ignores_another_prs_marker
run test_queue_regate_reason_classifies_as_shared_surface
run test_reverify_reason_is_written_at_gate_start
echo ALL-PASS
