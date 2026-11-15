#!/bin/bash
# dispatch.sh <role> <cwd> <prompt-file> [tag]
# role: worker|fixer|builder|dogfooder  -> DeepSeek flash --effort high, can write
#       planner|director                 -> DeepSeek flash --effort max, can write docs/state; may escalate per ROUTING.md
#       reviewer                         -> DeepSeek flash --effort max, read-only; may escalate per ROUTING.md
#       reviewer-alt                     -> gpt-6.1-sol (standing different family); Carbon if a necessity signal fires
#       ux-reviewer / ux-reviewer-alt    -> gpt-6.1-sol via claude -p; Carbon on necessity (vision / long context)
# Policy: rsi/ROUTING.md. Escalation is logged with reason + outcome.
# Prints the final result text (last ~6000 chars) and exits non-zero if the run errored.
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
ROLE="$1"; CWD="$2"; PF="$3"; TAG="${4:-$ROLE}"
mkdir -p "$RUNS" "$STATE/merge"
LOG="$RUNS/$(date +%F-%H%M%S)-dispatch-$TAG.jsonl"
PROMPT="$(cat "$PF")"
WRITE_TOOLS=(Read Write Edit Glob Grep Bash Skill WebFetch WebSearch)
READ_TOOLS=(Read Glob Grep Bash WebFetch)
EFFORT=""
RSI_ESCALATE_MODEL=; RSI_ESCALATE_FALLBACK=; RSI_ESCALATE_REASON=; RSI_ESCALATE_COST_SOURCE=; RSI_ESCALATE_ID=
case "$ROLE" in
  worker|fixer|builder|dogfooder) MODEL="$M_WORKER"; EFFORT="$M_WORKER_EFFORT"; TOOLS=("${WRITE_TOOLS[@]}");;
  planner|director)               MODEL="$M_DIRECTOR"; EFFORT="$M_DIRECTOR_EFFORT"; TOOLS=("${WRITE_TOOLS[@]}");;
  reviewer)                       MODEL="$M_DIRECTOR"; EFFORT="$M_DIRECTOR_EFFORT"; TOOLS=("${READ_TOOLS[@]}");;
  reviewer-alt)                   MODEL="$M_CODEX"; TOOLS=("${READ_TOOLS[@]}");;
  ux-reviewer|ux-reviewer-alt)    MODEL="$M_CODEX"; TOOLS=("${READ_TOOLS[@]}");;
  *) echo "unknown role $ROLE"; exit 2;;
esac

use_name() { # codex|carbon|kimi -> set MODEL/EFFORT
  case "$1" in
    carbon) MODEL="${M_CARBON:-agy/gemini-4-carbon-high}"; EFFORT="";;
    kimi)   MODEL="$M_KIMI"; EFFORT="$M_DIRECTOR_EFFORT";;
    codex)  MODEL="$M_CODEX"; EFFORT="";;
    *) return 1;;
  esac
}

# Necessity policy (not workers). See rsi/ROUTING.md.
if [ "$ROLE" != worker ] && [ "$ROLE" != fixer ] && [ "$ROLE" != builder ] && [ "$ROLE" != dogfooder ]; then
  ev="$(python3 "$RSI_DIR/runtime/escalate.py" --check --role "$ROLE" --tag "$TAG" --cwd "$CWD" 2>/dev/null)" || ev=""
  if [ -n "$ev" ]; then
    eval "$ev" 2>/dev/null || true
    if [ -n "${RSI_ESCALATE_MODEL:-}" ]; then
      use_name "$RSI_ESCALATE_MODEL"
      echo "[escalate $ROLE -> $MODEL cost=${RSI_ESCALATE_COST_SOURCE:-?} reason=${RSI_ESCALATE_REASON:-?} id=${RSI_ESCALATE_ID:-}]" >&2
    fi
  fi
fi

record_model() {
  case "$TAG" in
    merge-*-review) slug="${TAG#merge-}"; slug="${slug%-review}"; printf '%s\n' "$MODEL" > "$STATE/merge/$slug.review-model";;
    merge-*-ux)     slug="${TAG#merge-}"; slug="${slug%-ux}";     printf '%s\n' "$MODEL" > "$STATE/merge/$slug.ux-review-model";;
  esac
}
record_model

record_outcome() { # outcome note
  [ -n "${RSI_ESCALATE_ID:-}" ] || return 0
  python3 "$RSI_DIR/runtime/escalate.py" --outcome --id "$RSI_ESCALATE_ID" --outcome "$1" --model "$MODEL" --tag "$TAG" --note "${2:-}" >/dev/null 2>&1 || true
}

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

run_agy() {
  local bin="${AGY:-agy}"
  command -v "$bin" >/dev/null 2>&1 || { [ -x "$bin" ] || return 2; }
  local args=( -p "$PROMPT" --model "${M_CARBON_AGY:-gemini-4-carbon-high}"
               --output-format json --mode plan --sandbox --disable-slash-commands
               --print-timeout "${DISPATCH_MAX_SECS:-3000}s" --add-dir "$CWD" )
  [ -n "${WT_ROOT:-}" ] && args+=( --add-dir "$WT_ROOT" )
  [ -n "${RSI_CTRL:-}" ] && args+=( --add-dir "$RSI_CTRL" )
  ( cd "$CWD" && "$bin" "${args[@]}" < /dev/null > "$LOG.agy.json" 2>> "$LOG" ) &
  local pid=$!
  ( sleep "${DISPATCH_MAX_SECS:-3000}"; kill -TERM "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid"; local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  python3 - "$LOG.agy.json" "$LOG.txt" <<'PY'
import json,sys
src, dst = sys.argv[1], sys.argv[2]
try:
    d=json.load(open(src))
except Exception:
    sys.exit(1)
if str(d.get("status") or "").upper() not in ("SUCCESS","OK",""):
    # still extract text if any, but fail
    open(dst,"w").write(d.get("response") or d.get("text") or json.dumps(d)[:4000])
    sys.exit(2)
text = (d.get("response") or d.get("text") or "")
open(dst,"w").write(text)
sys.exit(0 if text.strip() else 1)
PY
  local pr=$?
  [ $rc -eq 0 ] && [ $pr -eq 0 ]
}

run_codex() {
  command -v codex >/dev/null 2>&1 || return 2
  ( cd "$CWD" && codex exec -m gpt-6.1-sol -s read-only "$PROMPT" < /dev/null > "$LOG.txt" 2>&1 )
}

emit_and_exit() { # rc  [file]
  local rc="$1" f="${2:-}"
  local oc=PASS note=""
  if [ -n "$f" ] && grep -qE 'VERDICT: *FAIL' "$f"; then oc=FAIL; note="VERDICT: FAIL"
  elif [ -n "$f" ] && grep -qE 'VERDICT: *PASS' "$f"; then oc=PASS; note="VERDICT: PASS"
  elif [ $rc -ne 0 ]; then oc=error; note="exit $rc"
  fi
  record_outcome "$oc" "$note"
  if [ -n "$f" ] && [ -s "$f" ]; then tail -c 6000 "$f"; exit $rc; fi
  exit $rc
}

run_named() { # carbon|codex|kimi|or a raw model id
  local name="$1"
  case "$name" in
    carbon)
      use_name carbon; record_model
      if run_agy; then return 0; fi
      return 1;;
    codex)
      use_name codex; record_model
      # native codex exec is text-only: fine for reviewer-alt, not for UX (images)
      if [ "$ROLE" != "ux-reviewer" ] && [ "$ROLE" != "ux-reviewer-alt" ] && run_codex; then return 0; fi
      run_claude "$M_CODEX" ""; return $?;;
    kimi)
      use_name kimi; record_model
      run_claude "$M_KIMI" "$M_DIRECTOR_EFFORT"; return $?;;
    *)
      run_claude "$MODEL" "$EFFORT"; return $?;;
  esac
}

needs_verdict() {
  case "$ROLE" in reviewer|reviewer-alt|ux-reviewer|ux-reviewer-alt) return 0;; *) return 1;; esac
}
usable_result() {
  if [ -s "$LOG.txt" ]; then
    if needs_verdict; then grep -qE "VERDICT: *(PASS|FAIL)" "$LOG.txt"; else return 0; fi
  elif needs_verdict; then
    return 1
  else
    return 0
  fi
}

# If we already escalated to a named strong model, run that (then fallbacks). Otherwise the role default.
rc=1
if [ -n "${RSI_ESCALATE_MODEL:-}" ]; then
  if run_named "$RSI_ESCALATE_MODEL" && usable_result; then
    rc=0
  else
    echo "[$RSI_ESCALATE_MODEL failed or returned no verdict; trying fallbacks: ${RSI_ESCALATE_FALLBACK:-none}]" >&2
    IFS=',' read -r -a FBs <<< "${RSI_ESCALATE_FALLBACK:-}"
    rc=1
    for fb in "${FBs[@]+"${FBs[@]}"}"; do
      [ -n "$fb" ] || continue
      echo "[fallback -> $fb]" >&2
      if run_named "$fb" && usable_result; then rc=0; break; fi
    done
  fi
  if [ $rc -eq 0 ] && [ -s "$LOG.txt" ]; then emit_and_exit 0 "$LOG.txt"; fi
  if [ $rc -eq 0 ]; then
    python3 "$(dirname "$0")/parse_result.py" "$LOG"; pr=$?
    # parse_result prints the text; stitch outcome
    if grep -qE 'VERDICT: *FAIL' "$LOG" 2>/dev/null; then record_outcome FAIL "VERDICT: FAIL"
    elif grep -qE 'VERDICT: *PASS' "$LOG" 2>/dev/null; then record_outcome PASS "VERDICT: PASS"
    elif [ $pr -ne 0 ]; then record_outcome error "parse_result $pr"
    else record_outcome PASS "ok"
    fi
    exit $pr
  fi
  record_outcome error "all escalated models failed"
  python3 "$(dirname "$0")/parse_result.py" "$LOG"; exit $?
fi

# Default path (no necessity signal).
if [ "$ROLE" = "reviewer-alt" ] && command -v codex >/dev/null 2>&1; then
  if run_codex; then emit_and_exit 0 "$LOG.txt"; fi
  echo "[codex exec failed, falling back to claude -p on $M_CODEX]" >&2
  MODEL="$M_CODEX"; EFFORT=""; record_model
fi
run_claude "$MODEL" "$EFFORT"; rc=$?
if ! python3 "$(dirname "$0")/parse_result.py" "$LOG" >/dev/null 2>&1 || [ $rc -ne 0 ]; then
  if tail -c 4000 "$LOG" | grep -qiE '403|forbidden|quota|rate.?limit|overloaded|Failed to authenticate|credit'; then
    echo "[model $MODEL failed with an API error; retrying once on $M_CODEX]" >&2
    MODEL="$M_CODEX"; EFFORT=""; record_model
    run_claude "$M_CODEX" ""; rc=$?
  fi
fi
python3 "$(dirname "$0")/parse_result.py" "$LOG"; exit $?
