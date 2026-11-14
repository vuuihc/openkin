#!/bin/bash
# gate.sh <worktree>  — the merge gate. Prints GATE_RESULT=PASS|FAIL with the reasons.
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
WT="$1"; cd "$WT" || { echo "GATE_RESULT=FAIL no worktree"; exit 1; }
fail=0; why=""
step() { # name cmd...
  local n="$1"; shift
  echo "--- $n"
  if "$@" > "$RUNS/gate-$$-$n.log" 2>&1; then echo "ok: $n"; else echo "FAIL: $n (see $RUNS/gate-$$-$n.log)"; tail -25 "$RUNS/gate-$$-$n.log"; fail=1; why="$why $n"; fi
}
mkdir -p "$RUNS"
$GIT fetch -q origin main 2>/dev/null
changed="$($GIT diff --name-only origin/main...HEAD)"
echo "changed files: $(echo "$changed" | grep -c .)"
lines="$($GIT diff --shortstat origin/main...HEAD -- . ':!web/dist/index.html' ':!*package-lock.json')"
echo "diff size: $lines"
echo "$changed" | grep -qE '^(web/dist/assets/|\.env|.*secret)' && { echo "FAIL: forbidden path in diff"; fail=1; why="$why forbidden-path"; }
[ -n "$($GIT status --porcelain)" ] && { echo "FAIL: working tree not clean (commit or discard)"; $GIT status --short | head; fail=1; why="$why dirty-tree"; }
[ -x scripts/check.sh ] && step check ./scripts/check.sh
if echo "$changed" | grep -q '^ui/'; then
  [ -d ui/node_modules ] || step npm-ci bash -c 'cd ui && npm ci'
  step typecheck bash -c 'cd ui && npm run typecheck'
  step lint bash -c 'cd ui && npm run lint'
  step test bash -c 'cd ui && npm test'
  step build bash -c 'cd ui && npm run build'
  [ -n "$($GIT status --porcelain -- . ':!web/dist/index.html')" ] && { echo "FAIL: build left uncommitted changes"; fail=1; why="$why dirty-after-build"; }
  $GIT diff --quiet -- web/dist/index.html || { echo "FAIL: web/dist/index.html stale — commit the rebuilt file"; fail=1; why="$why stale-dist"; }
fi
echo "--- ratchet"; python3 "$RSI_DIR/runtime/ratchet.py" check "$WT" || { fail=1; why="$why ratchet"; }
if [ $fail -eq 0 ]; then echo "GATE_RESULT=PASS"; exit 0; else echo "GATE_RESULT=FAIL:$why"; exit 1; fi
