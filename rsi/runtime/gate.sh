#!/bin/bash
# gate.sh <worktree>  — the merge gate. Prints GATE_RESULT=PASS|FAIL with the reasons.
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
source "$(cd "$(dirname "$0")" && pwd)/node-stamp.sh"
WT="$1"; cd "$WT" || { echo "GATE_RESULT=FAIL no worktree"; exit 1; }
fail=0; why=""
step() { # name cmd...
  local n="$1"; shift
  echo "--- $n"
  if "$@" > "$RUNS/gate-$$-$n.log" 2>&1; then echo "ok: $n"; else echo "FAIL: $n (see $RUNS/gate-$$-$n.log)"; tail -25 "$RUNS/gate-$$-$n.log"; fail=1; why="$why $n"; fi
}
# Changed-file Prettier, not a repo-wide check: 55 historical UI files fail
# `prettier --check`, so a grep over the whole tree would be permanently red
# and would hide the files this branch actually wrote. The committed range is
# `origin/main...HEAD`; uncommitted UI edits are included too, so reviewing a
# dirty tree still catches an unformatted file. `npx prettier` reads
# `ui/.prettierignore` through its own config discovery.
prettier_ui_changed() {
  local files=()
  local f list
  # A range we cannot resolve is a gate failure, not an empty change set: a
  # clone without the remote ref would otherwise print "nothing to check".
  if ! $GIT rev-parse --verify --quiet origin/main >/dev/null; then
    echo "origin/main is not available; cannot select the changed-file range"
    return 1
  fi
  # NUL-delimited git output keeps spaces in paths intact; newline is a safe
  # separator here because NULs become newlines before the read loop and a
  # newline in a UI filename is not a case this repository carries.
  #
  # The listing goes through a temporary file rather than `< <(...)` because a
  # process substitution reports success even when `git diff` fails, which
  # would turn a broken selection into "no changed UI files to format-check".
  list="$(mktemp "${TMPDIR:-/tmp}/gate-ui-paths.XXXXXX")" || {
    echo "cannot create a temporary file for the changed-file list"
    return 1
  }
  if ! {
    $GIT diff --name-only -z --diff-filter=ACMR origin/main...HEAD -- ui &&
      $GIT diff --name-only -z --diff-filter=ACMR HEAD -- ui &&
      $GIT ls-files --others --exclude-standard -z -- ui
  } >"$list"; then
    echo "cannot list changed UI files"
    rm -f "$list"
    return 1
  fi
  while IFS= read -r f; do
    [ -n "$f" ] && [ -f "ui/$f" ] && files+=("$f")
  done < <(tr '\0' '\n' <"$list" | sed 's|^ui/||' |
    grep -E '\.(ts|tsx|js|jsx|css|json|md)$' | sort -u)
  rm -f "$list"
  if [ ${#files[@]} -eq 0 ]; then
    echo "no changed UI files to format-check"
    return 0
  fi
  echo "checking ${#files[@]} changed UI file(s)"
  ( cd ui && npx prettier --check --ignore-unknown "${files[@]}" )
}

mkdir -p "$RUNS"
trap 'for kid in $(pgrep -P $$ 2>/dev/null || true); do rsi_kill_tree "$kid"; done' EXIT
export GOMAXPROCS="${GOMAXPROCS:-2}" GO_TEST_P="${GO_TEST_P:-2}" VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-2}"
# Repair ui/node_modules before the first console compile, not after it. A bare directory-existence
# test was true for a symlink into another worktree and for an install older than its own lockfile,
# so the repair never ran and tsc/vitest/build failed on a tree that was not the PR's fault.
ui_node_stamp() { node_stamp_ensure ui; }
$GIT fetch -q origin main 2>/dev/null
changed="$($GIT diff --name-only origin/main...HEAD)"
echo "changed files: $(echo "$changed" | grep -c .)"
lines="$($GIT diff --shortstat origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json')"
echo "diff size: $lines"
echo "$changed" | grep -qE '^(web/dist/assets/|\.env|.*secret)' && { echo "FAIL: forbidden path in diff"; fail=1; why="$why forbidden-path"; }
[ -n "$($GIT status --porcelain)" ] && { echo "FAIL: working tree not clean (commit or discard)"; $GIT status --short | head; fail=1; why="$why dirty-tree"; }
echo "$changed" | grep -q '^ui/' && step node-stamp ui_node_stamp
[ -x scripts/check.sh ] && step check ./scripts/check.sh
if echo "$changed" | grep -q '^ui/'; then
  step typecheck bash -c 'cd ui && npm run typecheck'
  step lint bash -c 'cd ui && npm run lint'
  step test bash -c 'cd ui && npm test -- --maxWorkers="${VITEST_MAX_WORKERS:-2}"'
  step build bash -c 'cd ui && npm run build'
  [ -n "$($GIT status --porcelain -- . ':!web/dist/index.html')" ] && { echo "FAIL: build left uncommitted changes"; fail=1; why="$why dirty-after-build"; }
  $GIT diff --quiet -- web/dist/index.html || { echo "FAIL: web/dist/index.html stale — commit the rebuilt file"; fail=1; why="$why stale-dist"; }
fi
step prettier prettier_ui_changed
echo "--- ratchet"; python3 "$RSI_DIR/runtime/ratchet.py" check "$WT" || { fail=1; why="$why ratchet"; }
if [ $fail -eq 0 ]; then echo "GATE_RESULT=PASS"; exit 0; else echo "GATE_RESULT=FAIL:$why"; exit 1; fi
