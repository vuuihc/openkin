#!/bin/bash
# lane.sh run <n>   — run the claimed worker lane n to completion (worktree → worker → push → PR).
# lane.sh start-claimed — launch every freshly claimed lane in the background (used by the fill pulse).
# lane.sh autofill  — turn merge-lane sendbacks into rework lanes on idle slots (no LLM needed).
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
source "$RSI_DIR/runtime/lane-pr.sh"
CMD="${1:-}"; N="${2:-}"

# A squash-merged (or closed) PR leaves its branch diffing from main, so autofill's fetch/diff
# cannot tell a live rework from a dead one. The PR's lifecycle state decides. The override is a
# test seam (the command reads the slug as $1); empty means the real gh call.
PR_STATE_CMD="${RSI_PR_STATE_CMD:-}"
pr_state() { # <slug> -> prints OPEN|MERGED|CLOSED; non-zero when the state cannot be read
  if [ -n "$PR_STATE_CMD" ]; then bash -c "$PR_STATE_CMD" pr-state "$1"
  else "$GH" pr view "rsi/$1" --repo "$GH_REPO" --json state --jq .state; fi
}

# Oldest sendback first. The glob used to walk them alphabetically, and autofill fills one idle
# lane per pass: a newer rework whose slug sorted earlier took every free slot while an older one
# waited. 2026-11-19: `panel-topmost` (18:32) was claimed at 18:44 and `stale-console` (15:21) had
# been waiting since then. Name breaks an mtime tie so the pick stays deterministic.
sendbacks_by_age() { # prints $STATE/sendback/*.md, oldest mtime first
  python3 - "$STATE/sendback" <<'PY'
import glob, os, sys
files = [p for p in glob.glob(os.path.join(sys.argv[1], "*.md")) if os.path.isfile(p)]
for p in sorted(files, key=lambda f: (os.path.getmtime(f), f)):
    print(p)
PY
}

launch() { # n
  nohup /bin/bash "$SELF" run "$1" >> "$RUNS/$(date +%F-%H%M%S)-lane$1.log" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  echo "launched lane $1 (pid $!)"
}

if [ "$CMD" = start-claimed ]; then
  [ -e "$STATE/PAUSE" ] && { echo paused; exit 0; }
  rsi_allow_workers || { echo "volc budget: not starting new worker lanes until next Asia/Singapore day (¥${RSI_VOLC_CNY:-?} >= ¥${RSI_VOLC_STOP_WORKERS:-560}; $STATE/volc-budget.log)"; exit 0; }
  if ! python3 "$LANES_PY" host-ok; then echo "host pressure: not starting claimed local workers"; exit 0; fi
  for n in $(python3 "$LANES_PY" claimed); do launch "$n"; sleep 2; done; exit 0
fi

if [ "$CMD" = autofill ]; then
  [ -e "$STATE/PAUSE" ] && exit 0
  rsi_allow_workers || { echo "volc budget: not filling rework lanes until next Asia/Singapore day"; exit 0; }
  # Astryx programme first: `autofill astryx` takes only sendbacks whose item is a slice id (or Q3a); `autofill rest` the others.
  SCOPE="${2:-all}"
  while IFS= read -r sb; do
    [ -e "$sb" ] || continue
    slug="$(basename "$sb" .md)"
    # A size-only sendback must not open a rework lane while its waiver stands: the cap it asks
    # to fit is gone, and a rework lane trims real content to obey it (2026-11-18: #296's round
    # deleted 879 lines of a signed story before it was killed; #299 was waived before a lane
    # claimed it). See state/merge/<slug>.size-ok.
    src="$(sed -n 's/^source: *//p' "$sb" | head -1)"
    if [ "$src" = "hold-size" ] && [ -f "$STATE/merge/$slug.size-ok" ]; then
      echo "autofill: $slug: hold-size waived (merge/$slug.size-ok), not opening a rework lane"
      continue
    fi
    itm="$(sed -n 's/^item: *//p' "$sb" | head -1)"
    is_astryx=$(python3 -c "import json,sys;ids={s['id'] for s in json.load(open('$RSI_DIR/astryx-slices.json'))['slices']};print(1 if sys.argv[1] in ids else 0)" "$itm" 2>/dev/null || echo 0)
    [ "$SCOPE" = astryx ] && [ "$is_astryx" != 1 ] && continue
    [ "$SCOPE" = rest ] && [ "$is_astryx" = 1 ] && continue
    # skip if some lane already works on it
    python3 "$LANES_PY" slugs | grep -qx "$slug" && continue
    # Terminal PR, no rework: after a squash merge the branch commits stay out of main, so the
    # fetch/diff below still finds a diff and would claim a lane for a PR that is already done
    # (2026-11-19, lane 3: "cancelled: stale sendback"). MERGED/CLOSED archive the file; OPEN
    # keeps today's path. An unreadable state fails open — a rare phantom costs less than a real
    # rework stalled by a gh outage.
    pstate="$(pr_state "$slug" 2>/dev/null || true)"
    case "$pstate" in
      MERGED|CLOSED)
        mkdir -p "$STATE/sendback/done"
        mv "$STATE/sendback/$slug.md" "$STATE/sendback/done/$slug-merged-$(date +%H%M%S).md"
        echo "rework $slug: PR $pstate, sendback archived (no rework lane)"
        continue ;;
      OPEN) ;;
      *) echo "autofill: $slug: PR state '${pstate:-unreadable}', claiming as before" ;;
    esac
    idle="$(python3 "$LANES_PY" idle --ignore-pressure | head -1)"; [ -z "$idle" ] && { echo "no idle lane for rework $slug"; break; }
    br="rsi/$slug"; $GIT -C "$RSI_CTRL" fetch -q origin "$br" 2>/dev/null
    paths="$($GIT -C "$RSI_CTRL" -c core.fileMode=false diff --no-renames --raw "origin/main...origin/$br" 2>/dev/null | awk '$3 != $4 {sub(/^[^\t]*\t/, ""); print}' | grep -vx "web/dist/index.html" | head -40)"
    [ -z "$paths" ] && { echo "rework $slug: no diff vs main, skipping"; continue; }
    paths_arr=()
    while IFS= read -r _p; do
      [ -n "$_p" ] && paths_arr+=("$_p")
    done <<< "$paths"
    [ "${#paths_arr[@]}" -gt 0 ] || { echo "rework $slug: no paths, skipping"; continue; }
    item="$(sed -n 's/^item: *//p' "$sb" | head -1)"; item="${item:-R-$slug}"
    python3 "$LANES_PY" claim "$idle" --slug "$slug" --item "$item" --brief "$sb" --mode rework --paths "${paths_arr[@]}" && launch "$idle"
  done < <(sendbacks_by_age)
  exit 0
fi

[ "$CMD" = run ] && [ -n "$N" ] || { echo "usage: lane.sh run <n> | start-claimed | autofill"; exit 2; }
rsi_allow_workers || { echo "volc budget: deferring lane $N until next Asia/Singapore day"; exit 0; }
eval "$(python3 "$LANES_PY" get "$N")"
[ "$L_STATUS" = claimed ] || { echo "lane $N not in claimed state ($L_STATUS)"; exit 0; }
SLUG="$L_SLUG"; ITEM="$L_ITEM"; BRIEF="$L_BRIEF"; MODE="$L_MODE"
# Host pressure defers NEW work only: a targeted rework runs 2-11 minutes and swap-free never recovers
# on its own (macOS keeps swapped pages), so gating reworks starves the queue forever (2026-11-16).
if [ "$MODE" != rework ] && ! python3 "$LANES_PY" host-ok; then echo "host pressure: deferring lane $N"; exit 0; fi
LK="$STATE/lanes/$N.lock"
if ! mkdir "$LK" 2>/dev/null; then
  old="$(cat "$LK/pid" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then echo "lane $N already running (pid $old)"; exit 0; fi
  rm -rf "$LK"; mkdir "$LK" || exit 0
fi
echo $$ > "$LK/pid"; python3 "$LANES_PY" start "$N" $$
FINISHED=0
WORKER_PID=""
cleanup() {
  # Reap the worker process group and any test/build descendants left behind.
  if [ -n "${WORKER_PID:-}" ]; then
    rsi_kill_tree "$WORKER_PID"
    kill -TERM -"$WORKER_PID" 2>/dev/null || true
    sleep 0.4
    kill -KILL -"$WORKER_PID" 2>/dev/null || true
  fi
  for kid in $(pgrep -P $$ 2>/dev/null || true); do
    rsi_kill_tree "$kid"
  done
  [ $FINISHED -eq 0 ] && python3 "$LANES_PY" finish "$N" --status crashed --note "lane.sh exited early"
  rm -rf "$LK"
}
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
- UI ratchet: \`python3 scripts/check-ui-inventory.py\` must not grow. If your change IS the sanctioned primitive/facade (its own raw \`<button>\`, \`createPortal\`, \`role="dialog"\`, \`useAnchoredPanel\` use is the point), run \`python3 scripts/check-ui-inventory.py --update\`, commit the baseline, and say so in the PR body (Risk section). Also run \`cd ui && npx vitest run src/design/tokens.test.ts\` (design-token tests: e.g. focus ring must use \`outline-kin-focus-ring\`) and \`./scripts/check.sh\` before you finish.\n- Commit everything with Conventional Commits and explicit paths. Do NOT push, do NOT open the PR, do NOT touch other worktrees.
- Before you finish write the PR body to \`$STATUS_NOTE_FILE\` with sections: Symptom · Change · Verification (commands + results) · Screenshots (paths, or "none: not visible") · Risk · \`RSI item: $ITEM\`.
- Final message: files changed, tests added (names), commands run with results, residual risk.
HD
if [ "$MODE" = rework ]; then
  echo; echo "## This is a REWORK: the merge lane sent the branch back. Fix exactly the findings below (all at once), then re-run the focused checks."
  echo "REWORK RULES (targeted, not a rewrite): make MINIMAL edits. Work through the 'Fix list' table row by row (file:line, issue, required change); edit only the lines/files a row names (plus the test that proves it). Do NOT regenerate, reformat or restructure files, do NOT re-implement the slice. If a row is wrong, say so with evidence in the PR body instead of changing code. If the brief says 'MECHANICAL', fix only that (conflict/format) and change nothing else."
  [ -n "${CONFLICT:-}" ] && echo "Merging origin/main into the branch left conflicts in: $CONFLICT. Resolve them (keep both sides' intent; \`web/dist/index.html\` is regenerated by \`npm run build\`), \`git add\`, commit."
  echo; cat "$BRIEF"
else
  echo; echo "# Brief"; cat "$BRIEF"
fi
} > "$HDR"

export BUDGET_GUARD="$LANE_BUDGET_USD" DISPATCH_MAX_SECS="$LANE_WORKER_SECS"
W_START=$(date +%s)
# Run the worker in its own process group so timeout/exit can reap vitest/go/node/agy.
python3 -c 'import os,sys; os.setpgrp(); os.execvp(sys.argv[1], sys.argv[1:])' \
  /bin/bash "$RSI_DIR/runtime/dispatch.sh" worker "$WT" "$HDR" "$TAG-worker" \
  > "$STATE/lanes/$N.worker.txt" 2>&1 &
WORKER_PID=$!
wait "$WORKER_PID"; WRC=$?
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

# A new PR takes its title — and therefore the squash-merge subject on main —
# from the tip commit. Capture the worker's subject before the format commit
# moves the tip, or every lane that needed formatting lands as "style: format
# changed UI and Go files". Skip the loop's own housekeeping commits.
WORKER_TITLE="$($GIT -C "$WT" log --format=%s origin/main..HEAD 2>/dev/null \
  | awk '!/^style: format changed UI and Go files$/ && !/^chore\(rsi\): commit remaining tracked edits/ { print; exit }')"

count_format_fail() { # not a runner failure: after --write this is a parse/env problem (missing ui/node_modules, npx/gofmt), so count it apart
  local n=$(( $(cat "$STATE/consec_format" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/consec_format"
  notify "Kin RSI: $1 failed ($n in a row)" "${2:-}"
  [ $n -ge 6 ] && echo "6 consecutive format-check failures $(date) — check worker env (ui/node_modules, npx/gofmt)" > "$STATE/PAUSE"
  return 0
}

# Format changed UI/Go files the way CI checks them; commit; refuse to push on failure.
FMT_ERR="$STATE/lanes/$N.format.err"
if ! bash "$RSI_DIR/runtime/format-changed.sh" --write --commit --check "$WT" >"$FMT_ERR" 2>&1; then
  FMT_DETAIL="$(tail -c 300 "$FMT_ERR" 2>/dev/null | tr '\n' ' ')"
  count_format_fail "lane $N format" "${FMT_DETAIL:-no output}"
  finish failed "" "format check failed: ${FMT_DETAIL:-see $FMT_ERR}; not pushing"
  exit 1
fi
echo 0 > "$STATE/consec_format"
[ -s "$FMT_ERR" ] && tail -3 "$FMT_ERR"

# push + PR (normal push only)
if ! $GIT -C "$WT" push -q -u origin "$BR" 2>"$STATE/lanes/$N.push.err"; then
  count_fail "lane $N push" "$(tail -c 150 "$STATE/lanes/$N.push.err")"; finish failed "" "push failed"; exit 1
fi
PRN="$($GH pr list --repo "$GH_REPO" --head "$BR" --state open --json number --jq '.[0].number' 2>/dev/null)"
if [ -z "$PRN" ]; then
  TITLE="$WORKER_TITLE"; [ -n "$TITLE" ] || TITLE="$($GIT -C "$WT" log -1 --format=%s origin/main..HEAD 2>/dev/null | head -1)"; TITLE="${TITLE:-chore(rsi): $ITEM $SLUG}"
  BODY="$STATUS_NOTE_FILE"; [ -s "$BODY" ] || { BODY="$STATE/lanes/$N.pr-body.fallback.md"; printf 'RSI lane %s, item %s.\n\nWorker summary:\n\n%s\n\nRSI item: %s\n' "$N" "$ITEM" "$(tail -c 3000 "$STATE/lanes/$N.worker.txt")" "$ITEM" > "$BODY"; }
  # A transient GitHub failure must not throw away a finished round; the helper
  # retries and checks whether the PR already exists (see lane-pr.sh).
  if ! PRURL="$(gh_pr_create "$GH_REPO" main "$BR" "$TITLE" "$BODY" 2>"$STATE/lanes/$N.pr.err")"; then
    PR_DETAIL="$(tail -c 300 "$STATE/lanes/$N.pr.err" 2>/dev/null | tr '\n' ' ')"
    count_fail "lane $N PR" "${PR_DETAIL:-no output}"
    finish failed "" "pr create failed: ${PR_DETAIL:-see $STATE/lanes/$N.pr.err}"
    exit 1
  fi
  PRN="$(echo "$PRURL" | sed -n 's#.*/pull/\([0-9]*\).*#\1#p')"
else
  PRURL="https://github.com/$GH_REPO/pull/$PRN"
  if [ -s "$STATUS_NOTE_FILE" ] && [ "$STATUS_NOTE_FILE" -nt "$HDR" ]; then
    $GH pr edit "$PRN" --repo "$GH_REPO" --body-file "$STATUS_NOTE_FILE" >/dev/null 2>&1 || true
  fi
  $GH pr comment "$PRN" --repo "$GH_REPO" --body "RSI lane $N pushed a rework for the merge lane's findings ($(date '+%F %H:%M %Z'))." >/dev/null 2>&1
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
