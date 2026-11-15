#!/bin/bash
# dispatch.sh <role> <cwd> <prompt-file> [tag]
# role: worker|fixer|builder|dogfooder  -> DeepSeek flash --effort high, can write
#       planner|director                 -> DeepSeek flash --effort max, can write docs/state
#       reviewer                         -> DeepSeek flash --effort max, read-only; may escalate to Kimi
#       reviewer-alt                     -> codex/gpt-6.1-sol (read-only; different family, not Volcengine)
#       ux-reviewer / ux-reviewer-alt    -> gpt-6.1-sol via claude -p (vision/Read); Kimi only on escalation
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
  reviewer-alt)                   MODEL="$M_CODEX"; TOOLS=("${READ_TOOLS[@]}");;
  ux-reviewer|ux-reviewer-alt)    MODEL="$M_CODEX"; TOOLS=("${READ_TOOLS[@]}");;  # claude -p, not codex exec: needs images
  *) echo "unknown role $ROLE"; exit 2;;
esac

# Kimi escalation (first reviewer + UX vision reviewer only). Second code reviewer stays Codex.
if [ "$ROLE" = reviewer ] || [ "$ROLE" = ux-reviewer ] || [ "$ROLE" = ux-reviewer-alt ]; then
  ev="$(python3 "$RSI_DIR/runtime/escalate.py" --check --role "$ROLE" --tag "$TAG" --cwd "$CWD" 2>/dev/null)" || ev=""
  if [ -n "$ev" ]; then
    eval "$ev" 2>/dev/null || true
    if [ "${RSI_ESCALATE_MODEL:-}" = kimi ]; then
      MODEL="$M_KIMI"; EFFORT="$M_DIRECTOR_EFFORT"
      echo "[escalate $ROLE -> $MODEL reason=${RSI_ESCALATE_REASON:-?}]" >&2
    elif [ "${RSI_ESCALATE_MODEL:-}" = codex ] && [ "$ROLE" = reviewer ]; then
      # cap hit after a trigger: first reviewer falls back to Codex (still a different path than "just DeepSeek")
      MODEL="$M_CODEX"; EFFORT=""
      echo "[escalate $ROLE cap/fallback -> $MODEL reason=${RSI_ESCALATE_REASON:-?}]" >&2
    fi
  fi
fi

# Record the model actually used (merge.sh scorecard can pick this up when present).
case "$TAG" in
  merge-*-review) slug="${TAG#merge-}"; slug="${slug%-review}"; printf '%s\n' "$MODEL" > "$STATE/merge/$slug.review-model";;
  merge-*-ux)     slug="${TAG#merge-}"; slug="${slug%-ux}";     printf '%s\n' "$MODEL" > "$STATE/merge/$slug.ux-review-model";;
esac

run_claude() { # model [effort]
  local model="$1" effort="${2:-}"
  local args=( -p "$PROMPT" --model "$model" --allowedTools "${TOOLS[@]}" --permission-mode bypassPermissions
               --add-dir "$WT_ROOT" "$RSI_CTRL" --max-budget-usd "$BUDGET_GUARD"
               --output-format stream-json --verbose )
  [ -n "$effort" ] && args+=( --effort "$effort" )
  ( cd "$CWD" && "$CLAUDE" "${args[@]}" < /dev/null >> "$LOG" 2>&1 ) &
  local pid=$!
  ( sleep "${DISPATCH_MAX_SECS:-3000}"; kill -TERM "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid"; local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  return $rc
}

# Second code reviewer: native codex exec (no images). UX reviewers must not take this path.
if [ "$ROLE" = "reviewer-alt" ] && command -v codex >/dev/null 2>&1; then
  ( cd "$CWD" && codex exec -m gpt-6.1-sol -s read-only "$PROMPT" < /dev/null > "$LOG.txt" 2>&1 ) && { tail -c 6000 "$LOG.txt"; exit 0; }
  echo "[codex exec failed, falling back to claude -p on $M_CODEX]" >&2
  MODEL="$M_CODEX"; EFFORT=""
fi

run_claude "$MODEL" "$EFFORT"; rc=$?
if ! python3 "$(dirname "$0")/parse_result.py" "$LOG" >/dev/null 2>&1 || [ $rc -ne 0 ]; then
  if tail -c 4000 "$LOG" | grep -qiE '403|forbidden|quota|rate.?limit|overloaded|Failed to authenticate|credit'; then
    echo "[model $MODEL failed with an API error; retrying once on $M_CODEX]" >&2
    run_claude "$M_CODEX" ""; rc=$?
  fi
fi
python3 "$(dirname "$0")/parse_result.py" "$LOG"; exit $?
