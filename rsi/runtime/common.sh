# shellcheck shell=bash
# Shared environment for the Kin RSI loop. Sourced by run.sh, dispatch.sh, gate.sh.
export TZ=Asia/Singapore
export HOME="${HOME:-/Users/$(id -un)}"
RSI_CTRL="${RSI_CTRL:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RSI_DIR="$RSI_CTRL/rsi"
STATE="$RSI_DIR/state"
RUNS="$RSI_DIR/runtime/runs"
GH_REPO="vuuihc/openkin"
WT_ROOT="$HOME/.kin/worktrees"
MAIN_CHECKOUT="$HOME/Workspace/study/kin-multidevice"   # read-only for the loop

NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="$HOME/.local/bin:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/go/bin:$HOME/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

CLAUDE="$HOME/.local/bin/claude"
GIT=/usr/bin/git
GH=/opt/homebrew/bin/gh
KIN_BIN="$HOME/.kin/node/kin"

# Public repo: commit as the noreply identity everywhere.
export GIT_AUTHOR_NAME=vuuihc GIT_AUTHOR_EMAIL=vuuihc@users.noreply.github.com
export GIT_COMMITTER_NAME=vuuihc GIT_COMMITTER_EMAIL=vuuihc@users.noreply.github.com
export GIT_TERMINAL_PROMPT=0
# Let the Bash tool wait for long builds/tests inside a claude -p run.
export BASH_DEFAULT_TIMEOUT_MS=3300000 BASH_MAX_TIMEOUT_MS=3600000

# Model routing (Ethan, 2026-11-15). Edit here to change roles.
M_WORKER='volcengine-gw/volcengine/deepseek-v4.1-flash[1m]'
M_DIRECTOR='volcengine-gw/kimi-k3.1-pro[1m]'
M_ALT='codex/gpt-6.1-sol'
BUDGET_GUARD="${BUDGET_GUARD:-15}"

# --- Parallel lanes (CEO 2026-11-15) ---
export RSI_STATE="$STATE"
export RSI_MAX_LANES="${RSI_MAX_LANES:-3}"        # worker lanes; the merge lane is separate. Drop to 2 if the Mac overloads.
export RSI_LOAD_MAX="${RSI_LOAD_MAX:-28}"          # 1-min loadavg above which no new lane is started
export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-2}"  # three lanes of default-parallel vitest overload 8 cores
LANE_WORKER_SECS="${LANE_WORKER_SECS:-2400}"       # worker watchdog (~40 min); director slices to ~25 min / <= $5
LANE_BUDGET_USD="${LANE_BUDGET_USD:-6}"            # runaway guard per worker run (target spend <= $5)
FILL_SECS="${FILL_SECS:-1200}"
LANES_PY="$RSI_DIR/runtime/lanes.py"
mkdir -p "$STATE/lanes" "$STATE/sendback" "$STATE/merge"

with_timeout() { # secs cmd...   (macOS has no `timeout`)
  local s="$1"; shift
  "$@" & local p=$!
  ( sleep "$s"; kill -TERM "$p" 2>/dev/null; sleep 5; kill -KILL "$p" 2>/dev/null ) >/dev/null 2>&1 & local w=$!
  wait "$p"; local rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}
count_timeout() { # a watchdog kill: counted apart from failures; 6 in a row pauses the loop
  local t=$(( $(cat "$STATE/consec_timeout" 2>/dev/null || echo 0) + 1 )); echo $t > "$STATE/consec_timeout"
  notify "Kin RSI: $1 hit watchdog timeout ($t in a row)" "${2:-}"
  [ $t -ge 6 ] && echo "6 consecutive watchdog timeouts $(date)" > "$STATE/PAUSE"
  return 0
}
count_fail() { # real runner failure (not a gate verdict): 6 in a row pauses the loop. Never trips NO_MERGE.
  local n=$(( $(cat "$STATE/consec_fail" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/consec_fail"
  notify "Kin RSI: $1 failed ($n in a row)" "${2:-}"
  [ $n -ge 6 ] && echo "6 consecutive runner failures $(date)" > "$STATE/PAUSE"
  return 0
}
count_ok() { echo 0 > "$STATE/consec_fail"; echo 0 > "$STATE/consec_timeout"; }
scorecard_row() { # item worker reviewer result pr fpy note   (inserted above "## Weekly fold")
  python3 - "$STATE/scorecard.md" "$(date '+%F %H:%M')" "$@" <<'PY'
import sys
p, ts, item, w, r, res, pr, fpy = sys.argv[1:9]; note = sys.argv[9] if len(sys.argv) > 9 else "-"
row = f"| {ts} | {item} | `{w}` | `{r}` | {res} | {pr} | {fpy} | {note} |\n"
try: lines = open(p).read().splitlines(True)
except Exception: lines = []
idx = next((i for i, l in enumerate(lines) if l.startswith("## Weekly fold")), None)
if idx is None: lines.append(row)
else: lines.insert(idx - 1 if idx > 0 and lines[idx-1].strip() == "" else idx, row)
open(p, "w").write("".join(lines))
PY
}

notify() { # title body
  local t="$1" b="${2:-}"
  /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' -e 'end run' "$b" "$t" >/dev/null 2>&1 || true
  [ -x "$KIN_BIN" ] && "$KIN_BIN" notify "$t" "$b" >/dev/null 2>&1 || true
  mkdir -p "$STATE/outbox"; printf '%s\n%s\n' "$t" "$b" > "$STATE/outbox/$(date +%F-%H%M%S)-notification.txt"
}
