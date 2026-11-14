#!/bin/bash
# run.sh <pulse|daily|dream> [--force] [--dry-run]   |   run.sh --check
# Night runner for the Kin RSI loop. Modeled on overseas-10k-sprint/runtime/run-director.sh:
# lock + idempotency + logs + headless `claude -p` per role + failure notification.
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
MODE=""; FORCE=0; DRY=0; CHECK=0
for a in "$@"; do case "$a" in pulse|daily|dream) MODE="$a";; --force) FORCE=1;; --dry-run) DRY=1;; --check) CHECK=1;; *) echo "unknown arg $a"; exit 2;; esac; done

if [ $CHECK -eq 1 ]; then
  echo "ctrl: $RSI_CTRL"; for t in "$CLAUDE" "$GIT" "$GH"; do [ -x "$t" ] && echo "ok $t" || echo "MISSING $t"; done
  for t in node npm go python3; do command -v $t >/dev/null && echo "ok $t" || echo "MISSING $t"; done
  [ -s "$RSI_DIR/runtime/prompts/pulse.md" ] && echo "prompts ok" || echo "prompts MISSING"
  for m in pulse daily dream; do launchctl print "gui/$(id -u)/com.ethan.kin-rsi-$m" >/dev/null 2>&1 && echo "launchd $m loaded" || echo "launchd $m NOT loaded"; done
  [ -e "$STATE/PAUSE" ] && echo "PAUSED" ; [ -e "$STATE/NO_MERGE" ] && echo "NO_MERGE set"; exit 0
fi
[ -z "$MODE" ] && { echo "usage: run.sh <pulse|daily|dream> [--force] [--dry-run]"; exit 2; }

# Keep the control worktree on origin/main once the loop itself has landed there (it is owned by the loop).
if [ -z "${RSI_SYNCED:-}" ]; then
  $GIT -C "$RSI_CTRL" fetch -q origin main 2>/dev/null
  if $GIT -C "$RSI_CTRL" cat-file -e origin/main:rsi/runtime/run.sh 2>/dev/null \
     && [ -z "$($GIT -C "$RSI_CTRL" status --porcelain --untracked-files=no)" ]; then
    $GIT -C "$RSI_CTRL" checkout -q -B rsi/ceo-loop origin/main 2>/dev/null
  fi
  RSI_SYNCED=1 exec /bin/bash "$SELF" "$@"
fi

mkdir -p "$STATE/reports" "$STATE/outbox" "$STATE/briefs" "$RUNS"
[ -e "$STATE/STATUS.md" ] || cp "$RSI_DIR/STATUS.md" "$STATE/STATUS.md"
[ -e "$STATE/scorecard.md" ] || cp "$RSI_DIR/scorecard.md" "$STATE/scorecard.md"
[ -e "$STATE/PAUSE" ] && [ $FORCE -eq 0 ] && { echo "paused ($STATE/PAUSE)"; exit 0; }

LOCK="$STATE/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  OLD="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OLD" ] && ! kill -0 "$OLD" 2>/dev/null; then rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || { echo "skip: locked"; exit 0; }
  else echo "skip: another run holds the lock (pid ${OLD:-?})"; exit 0; fi
fi
echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT

TODAY="$(date +%F)"; HOUR="$(date +%F-%H)"; STAMP="$(date +%F-%H%M%S)"
case "$MODE" in
  pulse) [ $FORCE -eq 0 ] && ls "$RUNS"/${HOUR}*-pulse.jsonl >/dev/null 2>&1 && { echo "skip: pulse already ran this hour"; exit 0; }; MAXSECS=3300;;
  daily) [ $FORCE -eq 0 ] && ls "$RUNS"/${TODAY}*-daily.jsonl >/dev/null 2>&1 && { echo "skip: daily already ran today"; exit 0; }; MAXSECS=5400;;
  dream) [ $FORCE -eq 0 ] && [ -s "$STATE/reports/$TODAY-morning.md" ] && { echo "skip: report exists"; exit 0; }; MAXSECS=5400;;
esac
LOG="$RUNS/$STAMP-$MODE.jsonl"
# Flags the prompt must see.
FLAGS="NO_MERGE=$([ -e "$STATE/NO_MERGE" ] && echo yes || echo no) DRY_RUN=$DRY"
PROMPT="$(sed -e "s#{{MODE}}#$MODE#g" -e "s#{{NOW}}#$(date '+%F %H:%M %Z')#g" -e "s#{{CTRL}}#$RSI_CTRL#g" -e "s#{{STATE}}#$STATE#g" -e "s#{{WT_ROOT}}#$WT_ROOT#g" -e "s#{{FLAGS}}#$FLAGS#g" -e "s#{{GH_REPO}}#$GH_REPO#g" "$RSI_DIR/runtime/prompts/$MODE.md")"
if [ $DRY -eq 1 ]; then TOOLS=(Read Glob Grep); else TOOLS=(Read Write Edit Glob Grep Bash Agent Skill WebFetch WebSearch); fi

run_once() { # model
  ( cd "$RSI_CTRL" && "$CLAUDE" -p "$PROMPT" --model "$1" \
      --allowedTools "${TOOLS[@]}" --permission-mode bypassPermissions \
      --add-dir "$WT_ROOT" "$MAIN_CHECKOUT" \
      --max-budget-usd "$BUDGET_GUARD" \
      --output-format stream-json --verbose < /dev/null >> "$LOG" 2>&1 ) &
  local pid=$!
  ( sleep "$MAXSECS"; echo '{"type":"runner","note":"watchdog timeout, terminating"}' >> "$LOG"; kill -TERM "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid"; local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  return $rc
}
echo "run=$MODE start=$(date +%T) log=$LOG model=$M_DIRECTOR"
run_once "$M_DIRECTOR"; RC=$?
python3 "$RSI_DIR/runtime/parse_result.py" "$LOG" > "$LOG.result.txt" 2>&1; PR=$?
if { [ $RC -ne 0 ] || [ $PR -ne 0 ]; } && tail -c 4000 "$LOG" | grep -qiE '403|forbidden|quota|rate.?limit|overloaded|Failed to authenticate|credit'; then
  echo '{"type":"runner","note":"API error, retrying on fallback model"}' >> "$LOG"
  run_once "$M_ALT"; RC=$?
  python3 "$RSI_DIR/runtime/parse_result.py" "$LOG" > "$LOG.result.txt" 2>&1; PR=$?
fi
echo "run=$MODE exit=$RC result_ok=$([ $PR -eq 0 ] && echo yes || echo no) log=$LOG"

CF="$STATE/consec_fail"
if [ $RC -ne 0 ] || [ $PR -ne 0 ]; then
  n=$(( $(cat "$CF" 2>/dev/null || echo 0) + 1 )); echo $n > "$CF"
  notify "Kin RSI: $MODE failed ($n in a row)" "$(tail -c 200 "$LOG.result.txt" | tr '\n' ' ')  log: ${LOG##*/}"
  [ $n -ge 2 ] && [ ! -e "$STATE/NO_MERGE" ] && { echo "runner failed $n times in a row ($(date))" > "$STATE/NO_MERGE"; }
  [ $n -ge 6 ] && echo "6 consecutive runner failures $(date)" > "$STATE/PAUSE"
  exit 1
fi
echo 0 > "$CF"
[ "$MODE" = dream ] && notify "Kin RSI morning report ready" "$STATE/reports/$TODAY-morning.md"
exit 0
