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
BUDGET_GUARD=15

notify() { # title body
  local t="$1" b="${2:-}"
  /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' -e 'end run' "$b" "$t" >/dev/null 2>&1 || true
  [ -x "$KIN_BIN" ] && "$KIN_BIN" notify "$t" "$b" >/dev/null 2>&1 || true
  mkdir -p "$STATE/outbox"; printf '%s\n%s\n' "$t" "$b" > "$STATE/outbox/$(date +%F-%H%M%S)-notification.txt"
}
