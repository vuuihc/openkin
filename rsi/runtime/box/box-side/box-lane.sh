#!/bin/bash
# box-lane.sh <slug>  — run one queued job end-to-end on the box: worktree -> worker (Claude Code via box gateway) ->
# self-check (typecheck + inventory ratchet + tests, one fix round) -> git bundle + PR body for the Mac to ingest.
# The box has no GitHub credentials: it never pushes. The Mac (ingest-box.sh / box-sync.sh) pushes rsi/<slug> and opens the PR.
set -u
BL=/workspace/box-lane; SLUG="$1"; J="$BL/jobs/$SLUG"; REPO=/workspace/openkin-box; WT="/workspace/wt/rsi-$SLUG"; BR="rsi/$SLUG"
LOG="$BL/logs/$SLUG.log"; exec >> "$LOG" 2>&1
export TZ=Asia/Singapore
. "$BL/claude-env.sh"; export PATH="$BL/shim:$PATH"
export GIT_AUTHOR_NAME=vuuihc GIT_AUTHOR_EMAIL=vuuihc@users.noreply.github.com GIT_COMMITTER_NAME=vuuihc GIT_COMMITTER_EMAIL=vuuihc@users.noreply.github.com GIT_TERMINAL_PROMPT=0
export VITEST_MAX_WORKERS=2 RSI_HEAVY_SLOTS=2 BASH_DEFAULT_TIMEOUT_MS=3300000 BASH_MAX_TIMEOUT_MS=3600000
WORKER='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
st() { python3 - "$J/status.json" "$@" <<'PY'
import json,sys,time
p=sys.argv[1]; d=json.load(open(p)); 
for kv in sys.argv[2:]:
    k,v=kv.split("=",1); d[k]=v
d["updated_at"]=time.time(); json.dump(d,open(p+".tmp","w")); __import__("os").replace(p+".tmp",p)
PY
}
fail() { echo "[$(date +%T)] FAILED: $*"; st status=failed note="$*"; exit 1; }
echo "[$(date +%T)] box lane start $SLUG"; st status=running started_at="$(date +%s)"

# --- worktree (shared object store; origin is the public repo, read-only from here) ---
git -C "$REPO" fetch -q origin main || fail "fetch main"
rm -rf "$WT"; git -C "$REPO" worktree prune
git -C "$REPO" worktree add -q -B "$BR" "$WT" origin/main || fail "worktree"
( cd "$WT/ui" && npm ci --no-audit --no-fund >/dev/null 2>&1 ) || fail "npm ci ui"
[ -f "$WT/desktop/package-lock.json" ] && ( cd "$WT/desktop" && npm ci --no-audit --no-fund >/dev/null 2>&1 )

# --- contract + brief ---
PATHS="$(python3 -c "import json;print(', '.join(json.load(open('$J/job.json'))['paths']))")"
ITEM="$(python3 -c "import json;print(json.load(open('$J/job.json'))['item'])")"
PRB="$J/pr-body.md"
{
cat <<HD
# Box lane worker contract (read first; it overrides anything below that says otherwise)
You are the WORKER for RSI item $ITEM in the git worktree \`$WT\` on branch \`$BR\` (created from current origin/main). You run on a Linux box with NO GitHub access.
- Do NOT push, do NOT open a PR, do NOT fetch other branches, do NOT touch anything outside \`$WT\`. If the brief says to push or open the PR, skip that: an automated step does it after you finish.
- Budget: about 40 minutes and about \$8. Declared footprint (stay inside): $PATHS (plus \`web/dist/index.html\` if you run the UI build). If the slice is too big, deliver the smallest green first slice, commit it, and say what remains in the PR body.
- Tests first. Focused checks while iterating (\`cd ui && npx vitest run <files>\`, \`npx tsc --noEmit\`). Use \`VITEST_MAX_WORKERS=2\`. Builds/tests are queued by a shim; waiting is normal.
- If \`ui/\` changed: \`cd ui && npm run build\`, commit \`web/dist/index.html\` only (never \`web/dist/assets/\`).
- UI ratchet: \`python3 scripts/check-ui-inventory.py\` must not grow (see the brief for the sanctioned \`--update\` case). Also run \`cd ui && npx vitest run src/design/tokens.test.ts\`.
- Commit everything with Conventional Commits (explicit paths). Leave the tree clean.
- Before you finish write the PR body to \`$PRB\` with sections: Summary · What the user sees now · Tests (names + results) · Risk · Screenshots (\`Screenshots: none: <reason>\` if you cannot produce them; this box has no desktop browser for you) · and a line \`RSI item: $ITEM\`.
- Final message: files changed, tests added, commands run with results, residual risk.
HD
echo; echo "# Brief (from the director)"; python3 -c "import json;print(json.load(open('$J/job.json'))['brief'])"
} > "$J/worker-prompt.md"

run_worker() { # prompt-file tag
  ( cd "$WT" && timeout --signal=TERM --kill-after=20 3000 claude -p "$(cat "$1")" --model "$WORKER" \
      --allowedTools Read Write Edit Glob Grep Bash Skill WebFetch WebSearch --permission-mode bypassPermissions \
      --max-budget-usd 9 --output-format stream-json --verbose < /dev/null > "$J/$2.jsonl" 2>&1 )
  return $?
}
cancelled() { python3 -c "import json,sys;sys.exit(0 if json.load(open('$J/status.json')).get('cancel') else 1)"; }

st phase=worker
run_worker "$J/worker-prompt.md" worker; WRC=$?
echo "[$(date +%T)] worker rc=$WRC"
cancelled && fail "cancelled"
[ -n "$(git -C "$WT" status --porcelain --untracked-files=no)" ] && git -C "$WT" add -u -- . ':!web/dist/assets' && git -C "$WT" commit -q -m "chore(rsi): commit remaining tracked edits for $ITEM"
[ "$(git -C "$WT" rev-list --count origin/main..HEAD)" -gt 0 ] || fail "worker produced no commits (rc=$WRC)"

# --- self-check with one fix round ---
selfcheck() {
  { echo "== tsc"; ( cd "$WT/ui" && npx tsc --noEmit ) || { echo "TSC-FAIL"; }
    echo "== inventory"; ( cd "$WT" && python3 scripts/check-ui-inventory.py ) || echo "INV-FAIL"
    echo "== vitest (full)"; ( cd "$WT/ui" && npx vitest run --maxWorkers=2 ) || echo "VITEST-FAIL"
  } > "$J/selfcheck.txt" 2>&1
  ! grep -qE '^(TSC|INV|VITEST)-FAIL' "$J/selfcheck.txt"
}
st phase=selfcheck
if ! selfcheck; then
  echo "[$(date +%T)] self-check failed; one fix round"
  { echo "# Fix round: your branch fails the self-check below. Fix exactly these failures (do not push; commit; keep PR body $PRB accurate). If a failure is clearly pre-existing on origin/main and unrelated to your change, say so in the PR body Risk section instead of touching it."
    echo '```'; grep -vE '^\s+at ' "$J/selfcheck.txt" | tail -c 9000; echo '```'; } > "$J/fix-prompt.md"
  st phase=fix; run_worker "$J/fix-prompt.md" fix
  [ -n "$(git -C "$WT" status --porcelain --untracked-files=no)" ] && git -C "$WT" add -u -- . ':!web/dist/assets' && git -C "$WT" commit -q -m "chore(rsi): commit remaining tracked edits for $ITEM"
  selfcheck && echo "self-check green after fix" || echo "self-check still failing; handing over anyway (merge lane will send back)"
fi
SC="green"; grep -qE '^(TSC|INV|VITEST)-FAIL' "$J/selfcheck.txt" && SC="FAILING (see selfcheck.txt)"

# --- hand over: bundle + PR body ---
[ -s "$PRB" ] || printf 'RSI item: %s\n\nBox-lane worker output (no PR body was written):\n\n%s\n' "$ITEM" "$(python3 "$BL/lastmsg.py" "$J/worker.jsonl" 2>/dev/null | tail -c 3000)" > "$PRB"
grep -q "RSI item:" "$PRB" || printf '\nRSI item: %s\n' "$ITEM" >> "$PRB"
printf '\nBox lane self-check at hand-over: %s (tsc, UI inventory ratchet, full vitest on the box).\n' "$SC" >> "$PRB"
TITLE="$(git -C "$WT" log -1 --format=%s origin/main..HEAD | head -1)"
git -C "$WT" bundle create "$J/bundle" "origin/main..$BR" || fail "bundle"
python3 - "$J" "$TITLE" "$SC" "$(git -C "$WT" rev-parse origin/main)" <<'PY'
import json,sys
j,t,sc,base=sys.argv[1:5]; d=json.load(open(j+"/status.json"))
d.update(status="done",pr_title=t,selfcheck=sc,base=base,phase="done"); json.dump(d,open(j+"/status.json","w"))
PY
echo "[$(date +%T)] box lane done $SLUG ($SC)"
