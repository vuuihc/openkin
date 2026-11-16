#!/bin/bash
# run.sh <pulse|daily|dream> [--force] [--dry-run]   |   run.sh --check | --status
# Runner for the Kin RSI loop (parallel lanes, CEO 2026-11-15).
#   pulse = FILL: a short director run (DeepSeek V4.1 Flash --effort max) that assigns tasks to idle worker lanes, then launches them detached.
#           Cadence: launchd every 20 min + whenever a lane finishes / the merge lane acts. Quick no-op when no lane is idle.
#   daily/dream = planner regroom / nightly consolidation + morning report. They wait (bounded) for the fill lock only,
#           never for lane or merge locks, and still run if the wait times out.
# Worker lanes live in lane.sh, the merge/review lane in merge.sh (own launchd job).
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
MODE=""; FORCE=0; DRY=0; CHECK=0; STAT=0
for a in "$@"; do case "$a" in pulse|daily|dream) MODE="$a";; --force) FORCE=1;; --dry-run) DRY=1;; --check) CHECK=1;; --status) STAT=1;; *) echo "unknown arg $a"; exit 2;; esac; done

if [ $CHECK -eq 1 ] || [ $STAT -eq 1 ]; then
  if [ $CHECK -eq 1 ]; then
    echo "ctrl: $RSI_CTRL"; for t in "$CLAUDE" "$GIT" "$GH"; do [ -x "$t" ] && echo "ok $t" || echo "MISSING $t"; done
    for t in node npm go python3; do command -v $t >/dev/null && echo "ok $t" || echo "MISSING $t"; done
    for p in fill daily dream; do [ -s "$RSI_DIR/runtime/prompts/$p.md" ] && echo "prompt $p ok" || echo "prompt $p MISSING"; done
    for m in pulse merge dream daily; do launchctl print "gui/$(id -u)/com.ethan.kin-rsi-$m" >/dev/null 2>&1 && echo "launchd $m loaded" || echo "launchd $m NOT loaded"; done
  fi
  python3 "$LANES_PY" status
  for f in PAUSE NO_MERGE VOLC_NO_KIMI VOLC_STOP_WORKERS; do [ -e "$STATE/$f" ] && echo "$f set: $(cat "$STATE/$f")"; done
  python3 "$RSI_DIR/runtime/volc-budget.py" --apply >/dev/null 2>&1 || true
  [ -s "$STATE/volc-budget.json" ] && python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print('volc list CNY today: ¥%.2f (%s); Kimi ¥%.2f / ¥%.0f'%(d['cny'],d['level'],d.get('kimi_cny') or 0,d.get('kimi_day_max') or 80))" "$STATE/volc-budget.json" 2>/dev/null
  echo "consec_fail=$(cat "$STATE/consec_fail" 2>/dev/null || echo 0) consec_timeout=$(cat "$STATE/consec_timeout" 2>/dev/null || echo 0)"
  echo "merge lane: $([ -d "$STATE/.merge.lock" ] && echo "running pid $(cat "$STATE/.merge.lock/pid")" || echo idle)"
  [ -e "$STATE/merged.log" ] && { echo "--- merged.log (tail)"; tail -5 "$STATE/merged.log"; }
  exit 0
fi
[ -z "$MODE" ] && { echo "usage: run.sh <pulse|daily|dream> [--force] [--dry-run] | --check | --status"; exit 2; }

# Keep the control worktree on origin/main once the loop itself has landed there (it is owned by the loop).
# Only ever fast-forward: unmerged local loop commits on rsi/ceo-loop must survive.
if [ -z "${RSI_SYNCED:-}" ]; then
  $GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null
  if [ -z "$($GIT -C "$RSI_CTRL" status --porcelain --untracked-files=no)" ] \
     && $GIT -C "$RSI_CTRL" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    $GIT -C "$RSI_CTRL" merge -q --ff-only origin/main 2>/dev/null
  fi
  RSI_SYNCED=1 exec /bin/bash "$SELF" "$@"
fi

mkdir -p "$STATE/reports" "$STATE/outbox" "$STATE/briefs" "$RUNS"
[ -e "$STATE/STATUS.md" ] || cp "$RSI_DIR/STATUS.md" "$STATE/STATUS.md"
[ -e "$STATE/scorecard.md" ] || cp "$RSI_DIR/scorecard.md" "$STATE/scorecard.md"
[ -e "$STATE/PAUSE" ] && [ $FORCE -eq 0 ] && { echo "paused ($STATE/PAUSE)"; exit 0; }

# Locks: pulse (fill) uses .fill.lock; daily/dream use .lock (docs/report lock) and first wait, bounded, for a running
# fill so STATUS.md edits do not interleave. Lanes and the merge lane have their own locks and nobody waits on them.
if [ "$MODE" = pulse ]; then LOCK="$STATE/.fill.lock"; else LOCK="$STATE/.lock"; fi
HAVE_LOCK=0
holder_alive() { [ -d "$1" ] && kill -0 "$(cat "$1/pid" 2>/dev/null || echo 0)" 2>/dev/null; }
if [ "$MODE" != pulse ]; then w=0; while { holder_alive "$STATE/.lock" || holder_alive "$STATE/.fill.lock"; } && [ $w -lt 1500 ]; do sleep 30; w=$((w+30)); done; fi
if mkdir "$LOCK" 2>/dev/null; then HAVE_LOCK=1
else
  OLD="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OLD" ] && ! kill -0 "$OLD" 2>/dev/null; then rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null && HAVE_LOCK=1; fi
  if [ $HAVE_LOCK -eq 0 ]; then
    if [ "$MODE" = pulse ]; then echo "skip: another fill holds the lock (pid ${OLD:-?})"; exit 0; fi
    echo "warning: $MODE proceeding without the lock (holder pid ${OLD:-?} still busy after wait)"
  fi
fi
[ $HAVE_LOCK -eq 1 ] && { echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT; }

TODAY="$(date +%F)"; STAMP="$(date +%F-%H%M%S)"
IDLE=""; LANES_TXT=""
case "$MODE" in
  pulse)
    MAXSECS="$FILL_SECS"; PROMPT_FILE="$RSI_DIR/runtime/prompts/fill.md"
    # debounce: lane-finish / merge triggers + the 20-min tick must not stack director runs
    if [ $FORCE -eq 0 ] && [ -e "$STATE/last_fill" ] && [ $(( $(date +%s) - $(cat "$STATE/last_fill") )) -lt 480 ]; then echo "skip: fill ran <8 min ago"; exit 0; fi
    if [ $DRY -eq 0 ] && rsi_allow_workers; then
      bash "$RSI_DIR/runtime/lane.sh" autofill astryx   # Astryx sendbacks -> rework lanes first, no LLM
      bash "$RSI_DIR/runtime/lane.sh" autofill rest     # non-Astryx reworks take remaining idle slots before exit
    fi
    IDLE="$(python3 "$LANES_PY" idle | tr '\n' ' ')"
    LANES_TXT="$(python3 "$LANES_PY" status)"
    CLOUD_PENDING="$(python3 "$RSI_DIR/runtime/slices.py" cloud-pending 2>/dev/null | wc -l | tr -d ' ')"
    if [ -z "${IDLE// }" ] && [ "${CLOUD_PENDING:-0}" -eq 0 ]; then
      if [ $DRY -eq 0 ] && rsi_allow_workers && [ -x "$RSI_DIR/runtime/nas/pulse-nas.sh" ]; then
        nohup /bin/bash "$RSI_DIR/runtime/nas/pulse-nas.sh" >> "$RUNS/launchd-nas.log" 2>&1 < /dev/null & disown 2>/dev/null || true
      fi
      echo "no idle lane and no cloud brief pending. $LANES_TXT"; exit 0
    fi
    date +%s > "$STATE/last_fill";;
  daily) [ $FORCE -eq 0 ] && ls "$RUNS"/${TODAY}*-daily.jsonl >/dev/null 2>&1 && { echo "skip: daily already ran today"; exit 0; }; MAXSECS=5400; PROMPT_FILE="$RSI_DIR/runtime/prompts/daily.md";;
  dream) [ $FORCE -eq 0 ] && [ -s "$STATE/reports/$TODAY-morning.md" ] && { echo "skip: report exists"; exit 0; }; MAXSECS=5400; PROMPT_FILE="$RSI_DIR/runtime/prompts/dream.md";;
esac
LOG="$RUNS/$STAMP-$MODE.jsonl"
FLAGS="NO_MERGE=$([ -e "$STATE/NO_MERGE" ] && echo yes || echo no) DRY_RUN=$DRY"
PROMPT="$(sed -e "s#{{MODE}}#$MODE#g" -e "s#{{NOW}}#$(date '+%F %H:%M %Z')#g" -e "s#{{CTRL}}#$RSI_CTRL#g" -e "s#{{STATE}}#$STATE#g" -e "s#{{WT_ROOT}}#$WT_ROOT#g" -e "s#{{FLAGS}}#$FLAGS#g" -e "s#{{GH_REPO}}#$GH_REPO#g" -e "s#{{IDLE}}#${IDLE% }#g" -e "s#{{MAXLANES}}#$RSI_MAX_LANES#g" "$PROMPT_FILE")"
if [ $DRY -eq 1 ]; then TOOLS=(Read Glob Grep); else TOOLS=(Read Write Edit Glob Grep Bash Agent Skill WebFetch WebSearch); fi
GUARD=$BUDGET_GUARD; [ "$MODE" = pulse ] && GUARD=8

run_once() { # model [effort]
  local model="$1" effort="${2:-}"
  local args=( -p "$PROMPT" --model "$model"
      --allowedTools "${TOOLS[@]}" --permission-mode bypassPermissions
      --add-dir "$WT_ROOT" "$MAIN_CHECKOUT"
      --max-budget-usd "$GUARD"
      --output-format stream-json --verbose )
  [ -n "$effort" ] && args+=( --effort "$effort" )
  ( cd "$RSI_CTRL" && "$CLAUDE" "${args[@]}" < /dev/null >> "$LOG" 2>&1 ) &
  local pid=$!
  ( sleep "$MAXSECS"; echo '{"type":"runner","note":"watchdog timeout, terminating"}' >> "$LOG"; kill -TERM "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid"; local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  return $rc
}
echo "run=$MODE start=$(date +%T) log=$LOG model=$M_DIRECTOR effort=$M_DIRECTOR_EFFORT idle_lanes=[${IDLE% }]"
run_once "$M_DIRECTOR" "$M_DIRECTOR_EFFORT"; RC=$?
python3 "$RSI_DIR/runtime/parse_result.py" "$LOG" > "$LOG.result.txt" 2>&1; PR=$?
if { [ $RC -ne 0 ] || [ $PR -ne 0 ]; } && tail -c 4000 "$LOG" | grep -qiE '403|forbidden|quota|rate.?limit|overloaded|Failed to authenticate|credit'; then
  echo '{"type":"runner","note":"API error, retrying on fallback model"}' >> "$LOG"
  run_once "$M_ALT"; RC=$?
  python3 "$RSI_DIR/runtime/parse_result.py" "$LOG" > "$LOG.result.txt" 2>&1; PR=$?
fi
echo "run=$MODE exit=$RC result_ok=$([ $PR -eq 0 ] && echo yes || echo no) log=$LOG"

# Lanes the director claimed are launched even if its final message failed (claims expire after 25 min otherwise).
if [ "$MODE" = pulse ] && [ $DRY -eq 0 ]; then
  if rsi_allow_workers; then
    bash "$RSI_DIR/runtime/lane.sh" start-claimed
    bash "$RSI_DIR/runtime/lane.sh" autofill rest   # non-Astryx reworks only take leftover lanes
    # Pack untaken cloud claims for the box first (marks taker=box). CopyToBox is
    # done by an agent with Mac+box tools; the box has no inbound route.
    # CEO 2026-11-16: state/BOX_OFF stops packing for the box while the box sync routine is paused (claims went zombie).
    if [ -x "$RSI_DIR/runtime/box/box-pack.sh" ] && [ ! -e "$STATE/BOX_OFF" ]; then
      /bin/bash "$RSI_DIR/runtime/box/box-pack.sh" >> "$RUNS/launchd-box.log" 2>&1 || true
    fi
    [ -x "$RSI_DIR/runtime/nas/pulse-nas.sh" ] && nohup /bin/bash "$RSI_DIR/runtime/nas/pulse-nas.sh" >> "$RUNS/launchd-nas.log" 2>&1 < /dev/null & disown 2>/dev/null || true
  else
    echo "volc budget: not starting new worker lanes until next Asia/Singapore day (¥${RSI_VOLC_CNY:-?} >= ¥${RSI_VOLC_STOP_WORKERS:-560})"
  fi
fi

if [ $RC -eq 143 ] && grep -q '"note":"watchdog timeout' "$LOG"; then count_timeout "$MODE" "log: ${LOG##*/}"; exit 1; fi
if [ $RC -ne 0 ] || [ $PR -ne 0 ]; then count_fail "$MODE" "$(tail -c 200 "$LOG.result.txt" | tr '\n' ' ')  log: ${LOG##*/}"; exit 1; fi
count_ok
[ "$MODE" = dream ] && notify "Kin RSI morning report ready" "$STATE/reports/$TODAY-morning.md"
exit 0
