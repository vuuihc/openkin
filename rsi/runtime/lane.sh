#!/bin/bash
# lane.sh run <n>   — run the claimed worker lane n to completion (worktree → worker → push → PR).
# lane.sh start-claimed — launch every freshly claimed lane in the background (used by the fill pulse).
# lane.sh autofill  — turn merge-lane sendbacks into rework lanes on idle slots (no LLM needed).
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
CMD="${1:-}"; N="${2:-}"

launch() { # n
  nohup /bin/bash "$SELF" run "$1" >> "$RUNS/$(date +%F-%H%M%S)-lane$1.log" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  echo "launched lane $1 (pid $!)"
}

if [ "$CMD" = start-claimed ]; then
  [ -e "$STATE/PAUSE" ] && { echo paused; exit 0; }
  rsi_allow_workers || { echo "volc budget: not starting new worker lanes until next Asia/Singapore day (¥${RSI_VOLC_CNY:-?} >= ¥${RSI_VOLC_STOP_WORKERS:-560}; $STATE/volc-budget.log)"; exit 0; }
  for n in $(python3 "$LANES_PY" claimed); do launch "$n"; sleep 2; done; exit 0
fi

if [ "$CMD" = autofill ]; then
  [ -e "$STATE/PAUSE" ] && exit 0
  rsi_allow_workers || { echo "volc budget: not filling rework lanes until next Asia/Singapore day"; exit 0; }
  # Astryx programme first: `autofill astryx` takes only sendbacks whose item is a slice id (or Q3a); `autofill rest` the others.
  SCOPE="${2:-all}"
  for sb in "$STATE"/sendback/*.md; do
    [ -e "$sb" ] || continue
    slug="$(basename "$sb" .md)"
    itm="$(sed -n 's/^item: *//p' "$sb" | head -1)"
    is_astryx=$(python3 -c "import json,sys;ids={s['id'] for s in json.load(open('$RSI_DIR/astryx-slices.json'))['slices']};print(1 if sys.argv[1] in ids else 0)" "$itm" 2>/dev/null || echo 0)
    [ "$SCOPE" = astryx ] && [ "$is_astryx" != 1 ] && continue
    [ "$SCOPE" = rest ] && [ "$is_astryx" = 1 ] && continue
    # skip if some lane already works on it
    python3 "$LANES_PY" slugs | grep -qx "$slug" && continue
    idle="$(python3 "$LANES_PY" idle | head -1)"; [ -z "$idle" ] && { echo "no idle lane for rework $slug"; break; }
    br="rsi/$slug"; $GIT -C "$RSI_CTRL" fetch -q origin "$br" 2>/dev/null
    paths="$($GIT -C "$RSI_CTRL" diff --name-only "origin/main...origin/$br" 2>/dev/null | grep -vx "web/dist/index.html" | head -40)"
    [ -z "$paths" ] && { echo "rework $slug: no diff vs main, skipping"; continue; }
    item="$(sed -n 's/^item: *//p' "$sb" | head -1)"; item="${item:-R-$slug}"
    # shellcheck disable=SC2086
    python3 "$LANES_PY" claim "$idle" --slug "$slug" --item "$item" --brief "$sb" --mode rework --paths $paths && launch "$idle"
  done
  exit 0
fi

[ "$CMD" = run ] && [ -n "$N" ] || { echo "usage: lane.sh run <n> | start-claimed | autofill"; exit 2; }
rsi_allow_workers || { echo "volc budget: deferring lane $N until next Asia/Singapore day"; exit 0; }
eval "$(python3 "$LANES_PY" get "$N")"
[ "$L_STATUS" = claimed ] || { echo "lane $N not in claimed state ($L_STATUS)"; exit 0; }
SLUG="$L_SLUG"; ITEM="$L_ITEM"; BRIEF="$L_BRIEF"; MODE="$L_MODE"
LK="$STATE/lanes/$N.lock"
if ! mkdir "$LK" 2>/dev/null; then
  old="$(cat "$LK/pid" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then echo "lane $N already running (pid $old)"; exit 0; fi
  rm -rf "$LK"; mkdir "$LK" || exit 0
fi
echo $$ > "$LK/pid"; python3 "$LANES_PY" start "$N" $$
FINISHED=0
cleanup() { [ $FINISHED -eq 0 ] && python3 "$LANES_PY" finish "$N" --status crashed --note "lane.sh exited early"; rm -rf "$LK"; }
trap cleanup EXIT
finish() { FINISHED=1; python3 "$LANES_PY" finish "$N" --status "$1" --pr "${2:-}" --note "${3:-}"; }

WT="$WT_ROOT/rsi-$SLUG"; BR="rsi/$SLUG"; TAG="lane$N-$SLUG"
echo "[$(date +%T)] lane $N start item=$ITEM slug=$SLUG mode=$MODE wt=$WT"
$GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null
if [ "$MODE" = rework ] || [ -d "$WT/.git" ] || [ -f "$WT/.git" ]; then
  [ -e "$WT" ] || $GIT -C "$RSI_CTRL" worktree add "$WT" "$BR" 2>/dev/null || $GIT -C "$RSI_CTRL" worktree add "$WT" -b "$BR" "origin/$BR"
  $GIT -C "$WT" fetch -q origin 2>/dev/null
  # Same branch as the PR: fast-forward to what is pushed, then merge main (no force-push anywhere).
  [ -z "$($GIT -C "$WT" status --porcelain)" ] && $GIT -C "$WT" merge -q --ff-only "origin/$BR" 2>/dev/null
  if ! $GIT -C "$WT" merge -q --no-edit origin/main >/dev/null 2>&1; then
    CONFLICT="$($GIT -C "$WT" diff --name-only --diff-filter=U | tr '\n' ' ')"
    echo "merge of origin/main left conflicts: $CONFLICT (worker must resolve and commit)"
  fi
else
  $GIT -C "$RSI_CTRL" worktree add "$WT" -b "$BR" origin/main >/dev/null 2>&1 || { finish failed "" "cannot create worktree $WT"; count_fail "lane $N" "worktree $WT"; exit 1; }
fi
BASE_N="$($GIT -C "$WT" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
bash "$RSI_DIR/runtime/prep-worktree.sh" "$WT" 2>&1 | tail -2

STATUS_NOTE_FILE="$STATE/lanes/$SLUG.pr-body.md"
HDR="$STATE/lanes/$N.worker-brief.md"
{
cat <<HD
# Lane worker contract (read first)
You are the WORKER for RSI item $ITEM in worktree \`$WT\` on branch \`$BR\`. Mode: $MODE.
- Budget: finish in about 45 minutes and at most about \$8 (Astryx programme slices are up to ~800 changed lines). If the slice is bigger than that, deliver the smallest green first slice, commit it, and list what remains in \`$STATE/followups.md\` (append).
- Stay inside your declared paths; do not touch files other lanes may be editing. Declared paths: $(python3 -c "import json;print(', '.join(json.load(open('$STATE/lanes/$N.json'))['paths']))")
- Test first. Run FOCUSED checks only (typecheck, lint on changed files, the tests you wrote/touched, \`go test\` for touched packages). The merge lane runs the full gate (\`gate.sh\`) and an independent review afterwards. Use \`VITEST_MAX_WORKERS=2\` for vitest; other lanes are running on the same machine.
- If \`ui/\` changed: \`cd ui && npm run build\`, commit \`web/dist/index.html\` only (never \`web/dist/assets/\`). For visible UI also save 390×844 and 1100×760 before/after screenshots under \`$STATE/shots/$SLUG/\`.
- UI ratchet: \`python3 scripts/check-ui-inventory.py\` must not grow. If your change IS the sanctioned primitive/facade (its own raw \`<button>\`, \`createPortal\`, \`role="dialog"\`, \`useAnchoredPanel\` use is the point), run \`python3 scripts/check-ui-inventory.py --update\`, commit the baseline, and say so in the PR body (Risk section). Also run \`cd ui && npx vitest run src/design/tokens.test.ts\` (design-token tests: e.g. focus ring must use \`outline-kin-focus-ring\`) and \`./scripts/check.sh\` before you finish.\n- Commit everything with Conventional Commits and explicit paths. Do NOT push, do NOT open the PR, do NOT touch the main checkout or other worktrees.
- Before you finish write the PR body to \`$STATUS_NOTE_FILE\` with sections: Symptom · Change · Verification (commands + results) · Screenshots (paths, or "none: not visible") · Risk · \`RSI item: $ITEM\`.
- Final message: files changed, tests added (names), commands run with results, residual risk.
HD
if [ "$MODE" = rework ]; then
  echo; echo "## This is a REWORK: the merge lane sent the branch back. Fix exactly the findings below (all at once), then re-run the focused checks."
  [ -n "${CONFLICT:-}" ] && echo "Merging origin/main into the branch left conflicts in: $CONFLICT. Resolve them (keep both sides' intent; \`web/dist/index.html\` is regenerated by \`npm run build\`), \`git add\`, commit."
  echo; cat "$BRIEF"
else
  echo; echo "# Brief"; cat "$BRIEF"
fi
} > "$HDR"

export BUDGET_GUARD="$LANE_BUDGET_USD" DISPATCH_MAX_SECS="$LANE_WORKER_SECS"
W_START=$(date +%s)
"$RSI_DIR/runtime/dispatch.sh" worker "$WT" "$HDR" "$TAG-worker" > "$STATE/lanes/$N.worker.txt" 2>&1; WRC=$?
W_MIN=$(( ($(date +%s) - W_START) / 60 ))
LASTLOG="$(ls -t "$RUNS"/*-dispatch-$TAG-worker.jsonl 2>/dev/null | head -1)"
COST="$(tail -c 400 "$STATE/lanes/$N.worker.txt" | sed -n 's/.*cost_usd=\([0-9.]*\).*/\1/p' | tail -1)"
TIMEDOUT=0; [ $WRC -eq 143 ] && TIMEDOUT=1
echo "[$(date +%T)] worker rc=$WRC min=$W_MIN cost=${COST:-?} log=${LASTLOG##*/}"

# Track modified files the worker forgot to commit (untracked files are left for the gate to flag).
[ -n "$($GIT -C "$WT" status --porcelain --untracked-files=no)" ] && $GIT -C "$WT" add -u -- . ':!web/dist/assets' && $GIT -C "$WT" commit -q -m "chore(rsi): commit remaining tracked edits for $ITEM" || true
AHEAD="$($GIT -C "$WT" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
if [ "$MODE" != rework ] && [ "$AHEAD" -eq 0 ]; then
  [ $TIMEDOUT -eq 1 ] && count_timeout "lane $N ($SLUG)" "no commits; log ${LASTLOG##*/}" || count_fail "lane $N ($SLUG)" "no commits; ${LASTLOG##*/}"
  scorecard_row "$ITEM $SLUG (lane $N)" "$M_WORKER" "-" "no commits (rc=$WRC, ${W_MIN}m)" "-" "failed" "slice smaller"
  finish failed "" "worker produced no commits rc=$WRC after ${W_MIN}m"; exit 1
fi

# Format changed UI/Go files the way CI checks them; commit; refuse to push on failure.
if ! bash "$RSI_DIR/runtime/format-changed.sh" --write --commit --check "$WT"; then
  count_fail "lane $N format" "changed-files prettier/gofmt check failed"
  finish failed "" "format check failed; not pushing"
  exit 1
fi

# push + PR (normal push only)
if ! $GIT -C "$WT" push -q -u origin "$BR" 2>"$STATE/lanes/$N.push.err"; then
  count_fail "lane $N push" "$(tail -c 150 "$STATE/lanes/$N.push.err")"; finish failed "" "push failed"; exit 1
fi
PRN="$($GH pr list --repo "$GH_REPO" --head "$BR" --state open --json number --jq '.[0].number' 2>/dev/null)"
if [ -z "$PRN" ]; then
  TITLE="$($GIT -C "$WT" log -1 --format=%s origin/main..HEAD 2>/dev/null | head -1)"; TITLE="${TITLE:-chore(rsi): $ITEM $SLUG}"
  BODY="$STATUS_NOTE_FILE"; [ -s "$BODY" ] || { BODY="$STATE/lanes/$N.pr-body.fallback.md"; printf 'RSI lane %s, item %s.\n\nWorker summary:\n\n%s\n\nRSI item: %s\n' "$N" "$ITEM" "$(tail -c 3000 "$STATE/lanes/$N.worker.txt")" "$ITEM" > "$BODY"; }
  PRURL="$($GH pr create --repo "$GH_REPO" --base main --head "$BR" --title "$TITLE" --body-file "$BODY" 2>&1 | tail -1)"
  PRN="$(echo "$PRURL" | sed -n 's#.*/pull/\([0-9]*\).*#\1#p')"
else
  PRURL="https://github.com/$GH_REPO/pull/$PRN"; $GH pr comment "$PRN" --repo "$GH_REPO" --body "RSI lane $N pushed a rework for the merge lane's findings ($(date '+%F %H:%M %Z'))." >/dev/null 2>&1
fi
[ -n "$PRN" ] || { count_fail "lane $N PR" "$PRURL"; finish failed "" "pr create failed: $PRURL"; exit 1; }
[ "$MODE" = rework ] && mkdir -p "$STATE/sendback/done" && mv "$STATE/sendback/$SLUG.md" "$STATE/sendback/done/$SLUG-$(date +%H%M%S).md" 2>/dev/null

if [ $TIMEDOUT -eq 1 ]; then count_timeout "lane $N ($SLUG)" "partial work pushed as PR #$PRN"; else count_ok; fi
scorecard_row "$ITEM $SLUG (lane $N, $MODE)" "$M_WORKER" "pending (merge lane)" "PR opened (${W_MIN}m, \$${COST:-?})$([ $TIMEDOUT -eq 1 ] && echo ', worker hit watchdog')" "[#$PRN]($PRURL)" "pending" "-"
finish done "$PRN" "PR #$PRN ${W_MIN}m \$${COST:-?}"
echo "[$(date +%T)] lane $N done PR #$PRN"
rm -rf "$LK"; trap - EXIT

# hand over: merge lane now, refill idle lanes right after
nohup /bin/bash "$RSI_DIR/runtime/merge.sh" >> "$RUNS/launchd-merge.log" 2>&1 < /dev/null & disown 2>/dev/null || true
nohup /bin/bash "$RSI_DIR/runtime/run.sh" pulse >> "$RUNS/launchd-pulse.log" 2>&1 < /dev/null & disown 2>/dev/null || true
exit 0
