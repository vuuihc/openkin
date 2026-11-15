#!/bin/bash
# dispatch.sh <role> <cwd> <prompt-file> [tag]
# role: worker|fixer|builder|dogfooder  -> DeepSeek flash --effort high, can write
#       planner|director                 -> DeepSeek flash --effort max, can write docs/state
#       reviewer                         -> DeepSeek flash --effort max, read-only tools
#       reviewer-alt                     -> codex gpt-6.1-sol (read-only), falls back to claude -p on M_ALT
#       ux-reviewer / ux-reviewer-alt    -> gpt-6.1-sol through claude -p (image-capable Read), read-only
# The merge lane selects reviewer-alt so a review never runs on the worker's model (MANDATE 2).
# Prints the final result text (last ~6000 chars) and exits non-zero if the run errored.
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
ROLE="$1"; CWD="$2"; PF="$3"; TAG="${4:-$ROLE}"
mkdir -p "$RUNS"
LOG="$RUNS/$(date +%F-%H%M%S)-dispatch-$TAG.jsonl"
PROMPT="$(cat "$PF")"
WRITE_TOOLS=(Read Write Edit Glob Grep Bash Skill WebFetch WebSearch)
READ_TOOLS=(Read Glob Grep Bash WebFetch)
EFFORT=""
case "$ROLE" in
  worker|fixer|builder|dogfooder) MODEL="$M_WORKER"; EFFORT="$M_WORKER_EFFORT"; TOOLS=("${WRITE_TOOLS[@]}");;
  planner|director)               MODEL="$M_DIRECTOR"; EFFORT="$M_DIRECTOR_EFFORT"; TOOLS=("${WRITE_TOOLS[@]}");;
  reviewer)                       MODEL="$M_DIRECTOR"; EFFORT="$M_DIRECTOR_EFFORT"; TOOLS=("${READ_TOOLS[@]}");;
  reviewer-alt)                   MODEL="$M_ALT"; TOOLS=("${READ_TOOLS[@]}");;
  ux-reviewer)                    MODEL="$M_ALT"; TOOLS=("${READ_TOOLS[@]}");;         # gpt-6.1-sol via claude -p (images)
  ux-reviewer-alt)                MODEL="$M_ALT"; TOOLS=("${READ_TOOLS[@]}");;        # claude -p on M_ALT (no codex exec: it cannot view images)
  *) echo "unknown role $ROLE"; exit 2;;
esac

run_claude() { # model [effort]
  local model="$1" effort="${2:-}"
  local args=( -p "$PROMPT" --model "$model"
      --allowedTools "${TOOLS[@]}" --permission-mode bypassPermissions
      --add-dir "$WT_ROOT" "$RSI_CTRL"
      --max-budget-usd "$BUDGET_GUARD"
      --output-format stream-json --verbose )
  [ -n "$effort" ] && args+=( --effort "$effort" )
  ( cd "$CWD" && "$CLAUDE" "${args[@]}" < /dev/null >> "$LOG" 2>&1 ) &
  local pid=$!
  ( sleep "${DISPATCH_MAX_SECS:-3000}"; kill -TERM "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid"; local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  return $rc
}

if [ "$ROLE" = "reviewer-alt" ] && command -v codex >/dev/null 2>&1; then
  ( cd "$CWD" && codex exec -m gpt-6.1-sol -s read-only "$PROMPT" < /dev/null > "$LOG.txt" 2>&1 ) && { tail -c 6000 "$LOG.txt"; exit 0; }
  echo "[codex exec failed, falling back to claude -p on $M_ALT]" >&2
fi

run_claude "$MODEL" "$EFFORT"; rc=$?
if ! python3 "$(dirname "$0")/parse_result.py" "$LOG" >/dev/null 2>&1 || [ $rc -ne 0 ]; then
  if tail -c 4000 "$LOG" | grep -qiE '403|forbidden|quota|rate.?limit|overloaded|Failed to authenticate|credit'; then
    echo "[model $MODEL failed with an API error; retrying once on $M_ALT]" >&2
    run_claude "$M_ALT"; rc=$?
  fi
fi
python3 "$(dirname "$0")/parse_result.py" "$LOG"; exit $?
