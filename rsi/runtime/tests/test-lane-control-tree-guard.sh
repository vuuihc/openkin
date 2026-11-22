#!/bin/bash
# test-lane-control-tree-guard.sh — a lane must never run git inside the control checkout.
#
# Every lane computes its worktree as $WT_ROOT/rsi-<slug> (lane.sh) and, when that path already
# exists, reuses it in place with `git merge` / `git checkout`-class work. The control checkout can
# itself be a symlink to a directory under WT_ROOT, so a slug that names that directory makes the
# lane run inside the control tree: the gate, the walker, GOAL.md and the live state directory
# silently become that lane's, and every later pulse runs the wrong tree. That is the 2026-11-20
# failure family — one stale line held the control tree 17 commits behind main for six hours while
# every status line read healthy.
#
# The guard resolves both paths (Python's os.path.realpath, because macOS has no GNU realpath) and
# refuses when they are the same directory, before the first git call. A resolution error fails
# closed. Distinct paths, including a worktree that does not exist yet, still run.
#
# Hermetic: temp RSI_CTRL/HOME (common.sh derives WT_ROOT, STATE and RSI_DIR from them), a real
# git control repo, stubbed dispatch/prep/commit/format/volc scripts, no network, no gh, no model
# calls. Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$RUNTIME/../.." && pwd)"
LANE="$RUNTIME/lane.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }
run_case() { [ -z "$ONLY" ] || [ "$1" = "$ONLY" ]; }

REAL_GIT="$(command -v git)" || bad "git is required for this suite"
export GIT_AUTHOR_NAME="control tree guard test" GIT_AUTHOR_EMAIL=owner@example.com
export GIT_COMMITTER_NAME="control tree guard test" GIT_COMMITTER_EMAIL=owner@example.com
mkdir -p "$T/runs" "$T/bin"
printf 'brief\n' > "$T/brief.md"
# lane.sh asks lanes.py host-ok before the guard, and on a pressured Mac that defers the lane with
# exit 0. Pin every probe: the env knobs for load/mem/swap (as the sibling lane suites do) and stubs
# for sysctl/vm_stat, because kern.memorystatus_vm_pressure_level has no env knob and is ≥4 on a
# pressured host. Without this the gate can go red before the guard is ever reached.
cat > "$T/bin/sysctl" <<'SH'
#!/bin/sh
case " $* " in
  *" kern.memorystatus_vm_pressure_level "*) echo 1 ;;
  *" vm.swapusage "*) echo "vm.swapusage: total = 0.00M  used = 0.00M  free = 999999.00M  (encrypted)" ;;
esac
exit 0
SH
cat > "$T/bin/vm_stat" <<'SH'
#!/bin/sh
p=$(( 999999 * 64 )); q=$(( p / 4 ))
cat <<EOF
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               ${q}.
Pages inactive:                           ${q}.
Pages speculative:                        ${q}.
Pages purgeable:                          ${q}.
EOF
SH
chmod +x "$T/bin/sysctl" "$T/bin/vm_stat"

# new_ctrl <name> — a control checkout with runtime stubs. Prints its path. Every long step the
# lane would take after the guard is stubbed, so a case that only reaches the guard costs nothing.
new_ctrl() {
  local ctrl="$T/$1"
  rm -rf "$ctrl"; mkdir -p "$ctrl/rsi/runtime" "$ctrl/rsi/state/lanes"
  git init -q "$ctrl" || bad "new_ctrl $1: git init failed"
  git -C "$ctrl" config user.name tester
  git -C "$ctrl" config user.email owner@example.com
  git -C "$ctrl" config commit.gpgsign false
  printf 'base\n' > "$ctrl/README.md"
  git -C "$ctrl" add -A && git -C "$ctrl" commit -q -m base || bad "new_ctrl $1: commit failed"
  cp "$RUNTIME/lanes.py" "$RUNTIME/lane-pr.sh" "$ctrl/rsi/runtime/" \
    || bad "new_ctrl $1: cannot copy runtime helpers"
  # volc-budget.py is asked for --export at source time and --allow-workers before the run.
  printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$ctrl/rsi/runtime/volc-budget.py"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/prep-worktree.sh"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/commit-leftovers.sh"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/format-changed.sh"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/merge.sh"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/run.sh"
  # The worker step: creating the sentinel proves a lane reached dispatch. Exiting non-zero stops
  # the lane at the existing "no commits" branch, before push/PR, so no network is touched.
  cat > "$ctrl/rsi/runtime/dispatch.sh" <<'SH'
#!/bin/bash
: > "${SENTINEL:?SENTINEL unset}"
exit 1
SH
  echo "$ctrl"
}

# claim_lane <ctrl> <slug> — a claimed fresh lane 1 record, the same shape lanes.py writes.
claim_lane() {
  python3 - "$1/rsi/state/lanes/1.json" "$2" "$T/brief.md" <<'PY'
import json, sys, time
path, slug, brief = sys.argv[1:4]
json.dump({"lane": 1, "slug": slug, "item": "R-" + slug, "brief": brief, "mode": "new",
           "paths": ["rsi/runtime/x.sh"], "status": "claimed", "claimed_at": time.time()},
          open(path, "w"))
PY
}

# lane_status <ctrl> — prints the status field of the lane record (or MISSING).
lane_status() {
  python3 - "$1/rsi/state/lanes/1.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("status", "MISSING"))
except Exception:
    print("MISSING")
PY
}

# lane_note <ctrl> — prints the recorded note.
lane_note() {
  python3 - "$1/rsi/state/lanes/1.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("note", ""))
except Exception:
    print("")
PY
}

# run_lane <case> <ctrl> <home> <git-binary> — run the claimed lane hermetically.
run_lane() {
  local case="$1" ctrl="$2" home="$3" gitbin="$4"
  HOME="$home" RSI_CTRL="$ctrl" GIT="$gitbin" RSI_MAX_LANES=2 RSI_LOAD_MAX=9999 \
    RSI_MEM_AVAIL_MIN_MB=0 RSI_SWAP_USED_MAX_MB=999999999 \
    RSI_LANE2_MEM_MIN_MB=0 RSI_LANE2_PRESSURE_MAX=99 RSI_LANE2_SWAP_FREE_MIN_MB=0 \
    PATH="$T/bin:$PATH" \
    RSI_RUNS="$T/runs" bash "$LANE" run 1 >"$T/$case.out" 2>"$T/$case.err"
  RC=$?
}

# A realpath from the same tool the guard uses; /tmp is a symlink on macOS and the note must
# contain the resolved spelling.
real() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

# --- 1. a worktree that resolves to the control checkout is refused --------------------------
if run_case case_refuses_worktree_that_resolves_to_control_tree; then
  C=case_refuses_worktree_that_resolves_to_control_tree
  CTRL="$(new_ctrl ctrl-refuse)"
  HOME_DIR="$T/home-refuse"; mkdir -p "$HOME_DIR/.kin/worktrees"
  SLUG="ctrl-refuse"
  WT="$HOME_DIR/.kin/worktrees/rsi-$SLUG"
  ln -s "$CTRL" "$WT" || bad "$C: cannot create the colliding symlink"
  claim_lane "$CTRL" "$SLUG"
  export SENTINEL="$T/sentinel-refuse"; rm -f "$SENTINEL"
  HEAD_BEFORE="$(git -C "$CTRL" rev-parse HEAD)"
  BR_BEFORE="$(git -C "$CTRL" rev-parse --abbrev-ref HEAD)"
  run_lane "$C" "$CTRL" "$HOME_DIR" "$REAL_GIT"
  [ "$RC" -ne 0 ] || bad "$C: the lane exited 0"
  [ "$(lane_status "$CTRL")" = blocked ] || bad "$C: status is $(lane_status "$CTRL"), not blocked"
  NOTE="$(lane_note "$CTRL")"
  grep -Fq "$WT" <<<"$NOTE" || bad "$C: note does not name the worktree path: $NOTE"
  grep -Fq "$(real "$CTRL")" <<<"$NOTE" || bad "$C: note does not name the resolved control path: $NOTE"
  [ ! -e "$SENTINEL" ] || bad "$C: a worker was launched"
  [ "$(git -C "$CTRL" rev-parse HEAD)" = "$HEAD_BEFORE" ] || bad "$C: control HEAD moved"
  [ "$(git -C "$CTRL" rev-parse --abbrev-ref HEAD)" = "$BR_BEFORE" ] || bad "$C: control branch changed"
  ok "$C"
fi

# --- 2. a genuinely separate worktree still runs ---------------------------------------------
# This is the control for the guard: every normal lane has a distinct path and must reach dispatch.
if run_case case_distinct_worktree_still_runs; then
  C=case_distinct_worktree_still_runs
  CTRL="$(new_ctrl ctrl-separate)"
  HOME_DIR="$T/home-separate"; mkdir -p "$HOME_DIR/.kin/worktrees"
  SLUG="separate-lane"
  claim_lane "$CTRL" "$SLUG"
  export SENTINEL="$T/sentinel-separate"; rm -f "$SENTINEL"
  # Every git step after the guard is a no-op stub: the worktree need not exist, and no origin,
  # fetch, worktree add or push may be required to prove dispatch was reached.
  cat > "$T/bin/git-stub" <<'SH'
#!/bin/sh
case " $* " in *" rev-list "*) echo 0 ;; esac
exit 0
SH
  chmod +x "$T/bin/git-stub"
  run_lane "$C" "$CTRL" "$HOME_DIR" "$T/bin/git-stub"
  [ -e "$SENTINEL" ] || bad "$C: the worker step was never reached (rc=$RC; $(tr '\n' ' ' < "$T/$C.err"))"
  [ "$(lane_status "$CTRL")" != blocked ] || bad "$C: a distinct worktree was marked blocked"
  ok "$C"
fi

# --- 3. a different spelling of the same directory is refused --------------------------------
# An extra symlink hop: the worktree path is neither the control path nor a direct symlink to it,
# so only a resolved-path comparison can see the collision.
if run_case case_symlinked_spelling_refused_via_realpath; then
  C=case_symlinked_spelling_refused_via_realpath
  CTRL="$(new_ctrl ctrl-hop)"
  HOME_DIR="$T/home-hop"; mkdir -p "$HOME_DIR/.kin/worktrees"
  ln -s "$CTRL" "$T/hop" || bad "$C: cannot create the intermediate symlink"
  SLUG="ctrl-hop"
  WT="$HOME_DIR/.kin/worktrees/rsi-$SLUG"
  ln -s "$T/hop" "$WT" || bad "$C: cannot create the worktree symlink"
  claim_lane "$CTRL" "$SLUG"
  export SENTINEL="$T/sentinel-hop"; rm -f "$SENTINEL"
  run_lane "$C" "$CTRL" "$HOME_DIR" "$REAL_GIT"
  [ "$RC" -ne 0 ] || bad "$C: the lane exited 0"
  [ "$(lane_status "$CTRL")" = blocked ] || bad "$C: status is $(lane_status "$CTRL"), not blocked"
  [ ! -e "$SENTINEL" ] || bad "$C: a worker was launched"
  ok "$C"
fi

# --- 4. the guard fires before any git mutation ----------------------------------------------
# `git worktree list` and the control branch are the state the existing worktree add/merge block
# would change; both must be byte-identical after a refused run.
if run_case case_guard_runs_before_any_git_mutation; then
  C=case_guard_runs_before_any_git_mutation
  CTRL="$(new_ctrl ctrl-before-git)"
  HOME_DIR="$T/home-before-git"; mkdir -p "$HOME_DIR/.kin/worktrees"
  SLUG="ctrl-before-git"
  WT="$HOME_DIR/.kin/worktrees/rsi-$SLUG"
  ln -s "$CTRL" "$WT" || bad "$C: cannot create the colliding symlink"
  claim_lane "$CTRL" "$SLUG"
  export SENTINEL="$T/sentinel-before-git"; rm -f "$SENTINEL"
  WORKTREES_BEFORE="$(git -C "$CTRL" worktree list --porcelain)"
  BR_BEFORE="$(git -C "$CTRL" rev-parse --abbrev-ref HEAD)"
  run_lane "$C" "$CTRL" "$HOME_DIR" "$REAL_GIT"
  [ "$RC" -ne 0 ] || bad "$C: the lane exited 0"
  [ "$(git -C "$CTRL" worktree list --porcelain)" = "$WORKTREES_BEFORE" ] \
    || bad "$C: the worktree list changed"
  [ "$(git -C "$CTRL" rev-parse --abbrev-ref HEAD)" = "$BR_BEFORE" ] \
    || bad "$C: the control branch changed"
  [ ! -e "$SENTINEL" ] || bad "$C: a worker was launched"
  ok "$C"
fi

# --- 5. the suite is wired into the gate -----------------------------------------------------
if run_case case_wiring_names_the_suite; then
  C=case_wiring_names_the_suite
  # Strip comments so a prose mention cannot satisfy the check, then look inside job_shell_test.
  BODY="$(sed 's/#.*//' "$REPO/scripts/check.sh" | sed -n '/^job_shell_test()/,/^}/p')"
  grep -q 'rsi/runtime/tests/test-lane-control-tree-guard.sh' <<<"$BODY" \
    || bad "$C: job_shell_test() does not name the suite"
  ok "$C"
fi
