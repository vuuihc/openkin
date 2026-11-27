#!/bin/bash
# nas-lane.sh <slug> — run one queued job on the NAS worker container:
# worktree off origin/main -> Claude Code worker (thinking only; no npm ci / full vitest / production build)
# -> git bundle + PR body for the Mac to ingest and self-check.
# This host has a weak CPU; the Mac runs tsc + inventory + full vitest via heavy.sh after fetch.
set -u
BL="${NAS_LANE_BL:-/opt/rsi}"
WORK="${NAS_LANE_WORK:-/work}"
SLUG="$1"
J="$WORK/jobs/$SLUG"
REPO="$WORK/openkin.git"
WT="$WORK/wt/rsi-$SLUG"
BR="rsi/$SLUG"
LOG="$WORK/logs/$SLUG.log"
mkdir -p "$WORK/logs" "$WORK/wt" "$WORK/home"
exec >> "$LOG" 2>&1
export TZ=Asia/Singapore HOME="$WORK/home"
mkdir -p "$HOME/.claude"
if [ -f /opt/rsi/../compose/claude-settings.json ]; then
  cp /opt/rsi/../compose/claude-settings.json "$HOME/.claude/settings.json" 2>/dev/null || true
fi
# settings also shipped next to nas-side on the host and copied at install into /work/home/.claude
[ -f "$WORK/home/.claude/settings.json" ] || [ -f /opt/rsi/claude-settings.json ] && cp /opt/rsi/claude-settings.json "$HOME/.claude/settings.json" 2>/dev/null || true
. "$BL/claude-env.sh"
export GIT_AUTHOR_NAME=vuuihc GIT_AUTHOR_EMAIL=vuuihc@users.noreply.github.com
export GIT_COMMITTER_NAME=vuuihc GIT_COMMITTER_EMAIL=vuuihc@users.noreply.github.com GIT_TERMINAL_PROMPT=0
export BASH_DEFAULT_TIMEOUT_MS=3300000 BASH_MAX_TIMEOUT_MS=3600000
WORKER='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'

st() { python3 - "$J/status.json" "$@" <<'PY'
import json,sys,time,os
p=sys.argv[1]
d=json.load(open(p)) if os.path.exists(p) else {}
for kv in sys.argv[2:]:
    k,v=kv.split("=",1); d[k]=v
d["updated_at"]=time.time()
json.dump(d,open(p+".tmp","w")); os.replace(p+".tmp",p)
PY
}
fail() { echo "[$(date +%T)] FAILED: $*"; st status=failed note="$*"; exit 1; }
echo "[$(date +%T)] nas lane start $SLUG"
st status=running started_at="$(date +%s)" host=nas

[ -f "$J/job.json" ] || fail "missing job.json"
[ -d "$REPO" ] || fail "missing bare repo $REPO"

# The shipped bundle is the only source of the base. nas-base.sh applies it by the head ref it
# carries and prints the ref to build on; a stale refs/remotes/origin/main this bare repo kept from
# an earlier job is never picked, and with no bundle the fallback is refs/heads/main.
BASE="$(bash "$BL/nas-base.sh" "$REPO" "$J")" || fail "no usable base in $REPO"
[ -n "$BASE" ] || fail "no usable base in $REPO"

rm -rf "$WT"
git --git-dir="$REPO" config core.fileMode false
git --git-dir="$REPO" worktree prune
git --git-dir="$REPO" worktree add -q -B "$BR" "$WT" "$BASE" || fail "worktree add"
git -C "$WT" config core.fileMode false

PATHS="$(python3 -c "import json;print(', '.join(json.load(open('$J/job.json'))['paths']))")"
ITEM="$(python3 -c "import json;print(json.load(open('$J/job.json'))['item'])")"
PRB="$J/pr-body.md"
{
cat <<HD
# NAS lane worker contract (read first; it overrides anything below that says otherwise)
You are the WORKER for RSI item $ITEM in the git worktree \`$WT\` on branch \`$BR\` (created from the base the Mac shipped: its bundle's head). You run on a Linux NAS container with a WEAK CPU (4-core Celeron) and NO GitHub access.
- Do NOT push, do NOT open a PR, do NOT fetch other branches, do NOT touch anything outside \`$WT\`. If the brief says to push or open the PR, skip that: an automated Mac step does it after you finish.
- Do NOT run \`npm ci\`, \`npm install\`, \`npm run build\`, a full \`vitest\` suite, or any long compile. This machine cannot afford it. Write the tests and the code; a Mac lane will run \`tsc\`, the UI inventory ratchet, and full vitest after you hand over. You may skip running tests if \`node_modules\` is absent (it usually is).
- Budget: about 40 minutes and about \$8. Declared footprint (stay inside): $PATHS. If the slice is too big, deliver the smallest green first slice, commit it, and say what remains in the PR body.
- Size: target ≤800 changed lines, hard cap 1000 — the Mac ingest holds anything bigger (same count the merge lane uses). Measure with \`bash rsi/runtime/diff-size.sh .\` in your worktree — plain git+awk, no installs. Over the cap? Deliver the smallest green first slice and say what remains in the PR body.
- Tests first: add or update FAILING tests, then the implementation. Focus on the declared paths.
- If \`ui/\` would need a production build, say so in the PR body; do not run \`npm run build\` here.
- UI ratchet: do not grow raw \`<button>\`, \`createPortal\`, or numeric \`z-[n]\` unless the brief sanctions \`--update\`. Do not run the ratchet script unless it is a one-liner you already know is instant.
- Commit everything with Conventional Commits (explicit paths). Leave the tree clean.
- Before you finish write the PR body to \`$PRB\` with sections: Summary · What the user sees now · Tests (names; note that NAS did not run the full suite) · Risk · Screenshots (\`Screenshots: none: NAS worker has no desktop browser\`) · and a line \`RSI item: $ITEM\`.
- Final message: files changed, tests added, residual risk.
HD
echo; echo "# Brief (from the director)"; python3 -c "import json;print(json.load(open('$J/job.json'))['brief'])"
} > "$J/worker-prompt.md"

run_worker() {
  ( cd "$WT" && timeout --signal=TERM --kill-after=20 3000 claude -p "$(cat "$1")" --model "$WORKER" \
      --allowedTools Read Write Edit Glob Grep Bash Skill WebFetch WebSearch --permission-mode bypassPermissions \
      --max-budget-usd 9 --output-format stream-json --verbose < /dev/null > "$J/$2.jsonl" 2>&1 )
  return $?
}
cancelled() { python3 -c "import json,sys,os;sys.exit(0 if os.path.exists('$J/status.json') and json.load(open('$J/status.json')).get('cancel') else 1)"; }

st phase=worker
run_worker "$J/worker-prompt.md" worker; WRC=$?
echo "[$(date +%T)] worker rc=$WRC"
cancelled && fail "cancelled"
# Commit everything the worker left, including files it created. The shared sweep is a hard
# requirement: the old tracked-only `else` quietly dropped a new file, and the bundle then reached
# CI missing it while this disk looked clean (2026-11-21, PR #511). The names it prints go into the
# job dir so a hand-over that swept files stays auditable.
if [ ! -f "$WT/rsi/runtime/commit-leftovers.sh" ]; then
  fail "missing $WT/rsi/runtime/commit-leftovers.sh; the lane cannot sweep created files"
fi
SWEPT="$(bash "$WT/rsi/runtime/commit-leftovers.sh" "$WT" "$ITEM")"; SRC=$?
if [ -n "$SWEPT" ]; then
  printf '%s\n' "$SWEPT" >> "$J/swept.txt"
  echo "[$(date +%T)] swept $(printf '%s\n' "$SWEPT" | wc -l | tr -d ' ') file(s) -> $J/swept.txt"
fi
[ "$SRC" -eq 0 ] || fail "leftovers remain uncommitted"
[ "$(git -C "$WT" rev-list --count "$BASE"..HEAD)" -gt 0 ] || fail "worker produced no commits (rc=$WRC)"

# Light typecheck only if ui/node_modules already exists; never npm ci here.
if [ -d "$WT/ui/node_modules" ]; then
  echo "[$(date +%T)] light tsc (node_modules present)"
  ( cd "$WT/ui" && npx --no-install tsc --noEmit ) > "$J/light-tsc.txt" 2>&1 || echo "LIGHT-TSC-FAIL" >> "$J/light-tsc.txt"
else
  echo "[$(date +%T)] skipping light tsc (no ui/node_modules; Mac will run the full self-check)"
  echo "SKIP no node_modules" > "$J/light-tsc.txt"
fi

# Format like CI before bundling only when both prettier (ui/node_modules) and gofmt exist;
# otherwise Mac ingest-nas.sh formats before pushing.
if [ -f "$WT/rsi/runtime/format-changed.sh" ] && [ -d "$WT/ui/node_modules" ] && command -v gofmt >/dev/null 2>&1; then
  bash "$WT/rsi/runtime/format-changed.sh" --write --commit --check "$WT" || fail "format check failed"
fi

[ -s "$PRB" ] || printf 'RSI item: %s\n\nNAS-lane worker output (no PR body was written):\n\n%s\n' "$ITEM" "$(python3 /opt/rsi/lastmsg.py "$J/worker.jsonl" 2>/dev/null | tail -c 3000)" > "$PRB"
grep -q "RSI item:" "$PRB" || printf '\nRSI item: %s\n' "$ITEM" >> "$PRB"
printf '\nNAS lane hand-over: agent thinking only (no full tsc/vitest/build on the NAS). Mac will run the self-check via heavy.sh.\n' >> "$PRB"
TITLE="$(git -C "$WT" log --format=%s "$BASE"..HEAD | grep -vE '^(chore\(rsi\):|style:)' | head -1)"
[ -n "$TITLE" ] || TITLE="$(git -C "$WT" log -1 --format=%s "$BASE"..HEAD | head -1)"
git -C "$WT" bundle create "$J/bundle" "$BASE".."$BR" || fail "bundle"
python3 - "$J" "$TITLE" "$(git -C "$WT" rev-parse "$BASE")" <<'PY'
import json,sys
j,t,base=sys.argv[1:4]
d=json.load(open(j+"/status.json"))
d.update(status="done",pr_title=t,base=base,phase="done",selfcheck="deferred-to-mac")
json.dump(d,open(j+"/status.json","w"))
PY
echo "[$(date +%T)] nas lane done $SLUG"
