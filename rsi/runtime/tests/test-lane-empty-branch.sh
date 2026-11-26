#!/bin/bash
# test-lane-empty-branch.sh — a half-failed `worktree add -b` must not poison every later lane.
#
# 2026-11-25: lane 2's first dispatch for item rn-gate-timeout died inside
# `git worktree add "$WT" -b "$BR" origin/main`, leaving a local branch rsi/<slug> with 0 commits
# and no worktree. Every later dispatch hit the same `-b` and failed on "branch exists" forever:
# the lane could never recover because the failure path never looked at the leftover. The fix
# reuses the branch only when it holds nothing of its own (`rev-list --count origin/main..$BR`
# is 0): it attaches a worktree on $BR and fast-forwards to origin/main. A branch with real
# commits is not ours to adopt, so the lane keeps failing loudly instead of silently inheriting
# a stranger's work.
#
# Hermetic: a bare origin plus a real git control repo per case under mktemp -d, RSI_CTRL and HOME
# redirected into the temp dir (common.sh derives WT_ROOT/STATE/RSI_DIR from them), stubbed
# dispatch/prep/commit/format/volc scripts, no network, no gh, no model calls. The worker stub
# writes a sentinel and exits non-zero, so the lane stops at "no commits" after worktree setup —
# the cases assert the worktree state directly.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
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
export GIT_AUTHOR_NAME="empty branch test" GIT_AUTHOR_EMAIL=owner@example.com
export GIT_COMMITTER_NAME="empty branch test" GIT_COMMITTER_EMAIL=owner@example.com
mkdir -p "$T/runs" "$T/bin"
printf 'brief\n' > "$T/brief.md"
# lane.sh asks lanes.py host-ok before the guard; pin the probes as the sibling lane suites do.
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

# new_ctrl <name> — a control checkout with a bare origin, a pushed main, and the runtime stubs
# that keep every step after worktree setup hermetic. Prints its path.
new_ctrl() {
  local ctrl="$T/$1" bare="$T/$1.git"
  rm -rf "$ctrl" "$bare"
  git init -q --bare "$bare" || bad "new_ctrl $1: bare init failed"
  git init -q -b main "$ctrl" || bad "new_ctrl $1: git init failed"
  git -C "$ctrl" config user.name tester
  git -C "$ctrl" config user.email owner@example.com
  git -C "$ctrl" config commit.gpgsign false
  mkdir -p "$ctrl/rsi/runtime" "$ctrl/rsi/state/lanes"
  printf 'base\n' > "$ctrl/README.md"
  git -C "$ctrl" add -A && git -C "$ctrl" commit -q -m base || bad "new_ctrl $1: commit failed"
  git -C "$ctrl" remote add origin "$bare" || bad "new_ctrl $1: remote add failed"
  git -C "$ctrl" push -q -u origin main || bad "new_ctrl $1: push main failed"
  git -C "$ctrl" update-ref refs/remotes/origin/main HEAD
  cp "$RUNTIME/lanes.py" "$RUNTIME/lane-pr.sh" "$ctrl/rsi/runtime/" \
    || bad "new_ctrl $1: cannot copy runtime helpers"
  printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$ctrl/rsi/runtime/volc-budget.py"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/prep-worktree.sh"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/commit-leftovers.sh"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/format-changed.sh"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/merge.sh"
  printf '#!/bin/bash\nexit 0\n' > "$ctrl/rsi/runtime/run.sh"
  # The worker step: the sentinel proves the lane reached dispatch; exiting non-zero stops it at
  # the existing "no commits" branch, before push/PR, so no network is touched.
  cat > "$ctrl/rsi/runtime/dispatch.sh" <<'SH'
#!/bin/bash
: > "${SENTINEL:?SENTINEL unset}"
exit 1
SH
  echo "$ctrl"
}

# advance_main <ctrl> — one more commit on main, pushed, so a stale branch is strictly behind.
advance_main() {
  printf 'more\n' >> "$1/README.md"
  git -C "$1" add -A && git -C "$1" commit -q -m 'main advances' || bad "advance_main $1: commit failed"
  git -C "$1" push -q origin main || bad "advance_main $1: push failed"
  git -C "$1" update-ref refs/remotes/origin/main HEAD
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

lane_status() {
  python3 - "$1/rsi/state/lanes/1.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("status", "MISSING"))
except Exception:
    print("MISSING")
PY
}

lane_note() {
  python3 - "$1/rsi/state/lanes/1.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("note", ""))
except Exception:
    print("")
PY
}

# run_lane <case> <ctrl> <home> — run the claimed lane hermetically.
run_lane() {
  local case="$1" ctrl="$2" home="$3"
  mkdir -p "$home/.local/bin" && cp "$T/bin/sysctl" "$T/bin/vm_stat" "$home/.local/bin/" \
    || bad "$case: cannot install the host-pressure stubs"
  HOME="$home" RSI_CTRL="$ctrl" GIT="$REAL_GIT" RSI_MAX_LANES=2 RSI_LOAD_MAX=9999 \
    RSI_MEM_AVAIL_MIN_MB=0 RSI_SWAP_USED_MAX_MB=999999999 \
    RSI_LANE2_MEM_MIN_MB=0 RSI_LANE2_PRESSURE_MAX=99 RSI_LANE2_SWAP_FREE_MIN_MB=0 \
    RSI_RUNS="$T/runs" bash "$LANE" run 1 >"$T/$case.out" 2>"$T/$case.err"
  RC=$?
}

# --- A. a leftover 0-commit branch is reused: worktree created on $BR at origin/main ----------
if run_case case_leftover_empty_branch_is_reused; then
  C=case_leftover_empty_branch_is_reused
  CTRL="$(new_ctrl ctrl-reuse)"
  HOME_DIR="$T/home-reuse"; mkdir -p "$HOME_DIR/.kin/worktrees"
  SLUG="reuse-me"; BR="rsi/$SLUG"; WT="$HOME_DIR/.kin/worktrees/rsi-$SLUG"
  STALE="$(git -C "$CTRL" rev-parse HEAD)"
  advance_main "$CTRL"
  MAIN_TIP="$(git -C "$CTRL" rev-parse origin/main)"
  [ "$STALE" != "$MAIN_TIP" ] || bad "$C: fixture did not advance main"
  # The half-failed first dispatch: a branch the worktree was never created for, behind main.
  git -C "$CTRL" branch "$BR" "$STALE" || bad "$C: cannot plant the leftover branch"
  [ "$(git -C "$CTRL" rev-list --count "origin/main..$BR")" = 0 ] \
    || bad "$C: fixture branch is not empty vs origin/main"
  claim_lane "$CTRL" "$SLUG"
  export SENTINEL="$T/sentinel-reuse"; rm -f "$SENTINEL"
  run_lane "$C" "$CTRL" "$HOME_DIR"
  grep -Fq "reusing leftover empty branch $BR" "$T/$C.out" \
    || bad "$C: no reuse line in lane output: $(tr '\n' ' ' < "$T/$C.out")"
  [ -e "$WT/.git" ] || bad "$C: no worktree at $WT (lane out: $(tail -3 "$T/$C.out"))"
  [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "$BR" ] \
    || bad "$C: worktree is on $(git -C "$WT" rev-parse --abbrev-ref HEAD), not $BR"
  [ "$(git -C "$WT" rev-parse HEAD)" = "$MAIN_TIP" ] \
    || bad "$C: worktree did not fast-forward to origin/main"
  [ -e "$SENTINEL" ] || bad "$C: the lane never reached dispatch (rc=$RC; $(tr '\n' ' ' < "$T/$C.err"))"
  ok "$C"
fi

# --- B. a branch with real commits is not adopted: the lane still fails loudly ----------------
if run_case case_branch_ahead_still_fails; then
  C=case_branch_ahead_still_fails
  CTRL="$(new_ctrl ctrl-ahead)"
  HOME_DIR="$T/home-ahead"; mkdir -p "$HOME_DIR/.kin/worktrees"
  SLUG="ahead-me"; BR="rsi/$SLUG"; WT="$HOME_DIR/.kin/worktrees/rsi-$SLUG"
  # A leftover that is not ours: one commit ahead of origin/main.
  git -C "$CTRL" checkout -q -b "$BR" || bad "$C: cannot create $BR"
  printf 'not ours\n' > "$CTRL/stray.txt"
  git -C "$CTRL" add stray.txt && git -C "$CTRL" commit -q -m 'stray work' || bad "$C: stray commit failed"
  git -C "$CTRL" checkout -q main || bad "$C: cannot return to main"
  [ "$(git -C "$CTRL" rev-list --count "origin/main..$BR")" = 1 ] \
    || bad "$C: fixture branch is not 1 ahead of origin/main"
  claim_lane "$CTRL" "$SLUG"
  export SENTINEL="$T/sentinel-ahead"; rm -f "$SENTINEL"
  run_lane "$C" "$CTRL" "$HOME_DIR"
  [ "$RC" -ne 0 ] || bad "$C: the lane exited 0"
  [ "$(lane_status "$CTRL")" = failed ] || bad "$C: status is $(lane_status "$CTRL"), not failed"
  grep -Fq "cannot create worktree" <<<"$(lane_note "$CTRL")" \
    || bad "$C: note does not report the worktree failure: $(lane_note "$CTRL")"
  [ ! -e "$WT" ] || bad "$C: a worktree was created on a branch that is not ours"
  [ ! -e "$SENTINEL" ] || bad "$C: a worker was launched"
  ok "$C"
fi

# --- C. no leftover: the normal -b path still works -------------------------------------------
if run_case case_fresh_branch_path_unchanged; then
  C=case_fresh_branch_path_unchanged
  CTRL="$(new_ctrl ctrl-fresh)"
  HOME_DIR="$T/home-fresh"; mkdir -p "$HOME_DIR/.kin/worktrees"
  SLUG="fresh-lane"; BR="rsi/$SLUG"; WT="$HOME_DIR/.kin/worktrees/rsi-$SLUG"
  claim_lane "$CTRL" "$SLUG"
  export SENTINEL="$T/sentinel-fresh"; rm -f "$SENTINEL"
  run_lane "$C" "$CTRL" "$HOME_DIR"
  ! grep -Fq "reusing leftover empty branch" "$T/$C.out" \
    || bad "$C: the reuse line fired with no leftover branch"
  [ -e "$WT/.git" ] || bad "$C: no worktree at $WT (lane out: $(tail -3 "$T/$C.out"))"
  [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "$BR" ] \
    || bad "$C: worktree is on $(git -C "$WT" rev-parse --abbrev-ref HEAD), not $BR"
  [ "$(git -C "$WT" rev-parse HEAD)" = "$(git -C "$CTRL" rev-parse origin/main)" ] \
    || bad "$C: fresh worktree is not at origin/main"
  [ -e "$SENTINEL" ] || bad "$C: the lane never reached dispatch (rc=$RC; $(tr '\n' ' ' < "$T/$C.err"))"
  ok "$C"
fi

# --- D. the suite is wired into the gate -------------------------------------------------------
if run_case case_wiring_names_the_suite; then
  C=case_wiring_names_the_suite
  BODY="$(sed 's/#.*//' "$REPO/scripts/check.sh" | sed -n '/^job_shell_test()/,/^}/p')"
  grep -q 'rsi/runtime/tests/test-lane-empty-branch.sh' <<<"$BODY" \
    || bad "$C: job_shell_test() does not name the suite"
  ok "$C"
fi
