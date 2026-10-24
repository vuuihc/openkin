#!/usr/bin/env bash
# One-shot: rebuild UI + kin binary, kill old daemon/desktop, relaunch Electron.
#
# Usage:
#   ./scripts/desktop-rebuild.sh
#   make desktop-rebuild
#
# Unlike `make desktop-dev` (backend only + Electron), this always:
#   1. installs ui dependencies when they changed, then builds the Vite UI
#      into web/dist (embedded by Go)
#   2. builds ./kin with the new embed
#   3. refreshes the launchd node's own copy of kin, when one is installed
#   4. stops any daemon on :7777 (desktop otherwise attaches to the old one)
#   5. stops previous Kin Electron for this repo
#   6. launches desktop (npm run dev)
#
# Step 3 exists because the desktop shell loads the console from :7777, and on
# a machine set up with `scripts/install-node-service.sh` that port belongs to
# the *installed* copy at ~/.kin/node/kin — not to the $BIN built here. Skip it
# with KIN_SKIP_NODE_REFRESH=1.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${KIN_PORT:-7777}"
BIN="${KIN_BIN:-$ROOT/kin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing required command: $1" >&2
    echo "hint: run ./scripts/setup-dev.sh first" >&2
    exit 1
  fi
}

need_cmd go
need_cmd npm
need_cmd node

kill_port_listeners() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  echo "==> stopping process(es) listening on :$port → $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 0.3
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

# Unique numeric PIDs from stdin → stdout (bash 3.2 compatible; no `local -n`).
_unique_pids() {
  # awk is always available on macOS; avoids bash 4+ namerefs.
  awk 'NF {
    gsub(/[ \t\r\n]/, "", $1)
    if ($1 ~ /^[0-9]+$/ && !seen[$1]++) print $1
  }'
}

# Kill repo-local Electron / branded Kin.app used by desktop dev.
#
# Important (macOS): after brand-electron-app renames the binary to "Kin",
# the main process argv is just "Kin" — no full path. `pgrep -f .../MacOS/Kin`
# therefore misses the main process and only finds helpers. Use `lsof -t` on
# the executable path (open txt file) plus cwd checks for processes named Kin.
#
# NOTE: macOS ships Bash 3.2 — do not use `local -n` / nameref.
kill_desktop_dev() {
  local markers=(
    "$ROOT/desktop/node_modules/electron/dist/Kin.app/Contents/MacOS/Kin"
    "$ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    "$ROOT/desktop/.dev-app/Kin.app/Contents/MacOS/Kin"
  )
  local pids_raw="" pids="" p leftovers

  # 1) lsof on the executable — finds main process even when argv is just "Kin".
  if command -v lsof >/dev/null 2>&1; then
    local m
    for m in "${markers[@]}"; do
      if [[ -e "$m" ]]; then
        pids_raw+="$(lsof -t "$m" 2>/dev/null || true)"$'\n'
      fi
    done

    # 2) Processes named "Kin" whose cwd is this repo's desktop/ (covers orphans).
    local pid cwd
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
      case "$cwd" in
        "$ROOT/desktop"|"$ROOT/desktop"/*)
          pids_raw+="$pid"$'\n'
          ;;
      esac
    done < <(pgrep -x Kin 2>/dev/null || true)
  fi

  # 3) Helpers / anything still advertising our electron dist path in argv.
  if command -v pgrep >/dev/null 2>&1; then
    local m
    for m in "${markers[@]}"; do
      pids_raw+="$(pgrep -f "$m" 2>/dev/null || true)"$'\n'
    done
    pids_raw+="$(pgrep -f "$ROOT/desktop/node_modules/electron/dist/" 2>/dev/null || true)"$'\n'
    pids_raw+="$(pgrep -f "$ROOT/desktop/.*run-electron\.mjs" 2>/dev/null || true)"$'\n'
    pids_raw+="$(pgrep -f "app-path=$ROOT/desktop" 2>/dev/null || true)"$'\n'
  fi

  pids="$(printf '%s' "$pids_raw" | _unique_pids | tr '\n' ' ')"
  pids="${pids%% }"
  pids="${pids## }"

  if [[ -z "$pids" ]]; then
    echo "    (no previous desktop instance found)"
    return 0
  fi

  echo "==> stopping previous desktop instance(s): $pids"
  # shellcheck disable=SC2086
  for p in $pids; do
    kill "$p" 2>/dev/null || true
  done
  sleep 0.5
  # shellcheck disable=SC2086
  for p in $pids; do
    if kill -0 "$p" 2>/dev/null; then
      kill -9 "$p" 2>/dev/null || true
    fi
  done
  # Reap any helpers that survived main-process kill.
  sleep 0.2
  if command -v pgrep >/dev/null 2>&1; then
    leftovers="$(pgrep -f "$ROOT/desktop/node_modules/electron/dist/" 2>/dev/null | _unique_pids | tr '\n' ' ' || true)"
    leftovers="${leftovers%% }"
    if [[ -n "$leftovers" ]]; then
      echo "    force-kill leftover helpers: $leftovers"
      # shellcheck disable=SC2086
      for p in $leftovers; do
        kill -9 "$p" 2>/dev/null || true
      done
    fi
  fi
}

echo "==> [1/5] build UI (ui → web/dist)"
(
  cd "$ROOT/ui"
  # Install when there is no tree at all, or when the declared dependencies are
  # newer than the tree installed from them. The second check earns its keep: a
  # checkout whose node_modules predates a `package.json` change fails in
  # `tsc --noEmit` below, and it reads as a type error in whatever file first
  # needs the missing package rather than as a stale install. (Seen for real:
  # `@types/node` added by the design-system work, reported as
  # `Cannot find module 'node:fs'` in a test file.)
  stamp=node_modules/.package-lock.json
  if [[ ! -d node_modules ]] || [[ ! -f "$stamp" ]] \
    || [[ package.json -nt "$stamp" ]] || [[ package-lock.json -nt "$stamp" ]]; then
    echo "    npm install (dependencies changed)..."
    npm install
  fi
  npm run build
)

echo "==> [2/5] go build → $BIN"
go build -o "$BIN" ./cmd/kin
chmod +x "$BIN"
./scripts/dev-sign.sh "$BIN"

echo "==> [3/5] refresh the launchd node's copy of kin"
# Only when this machine is actually set up as a node. Without the refresh the
# node keeps serving the UI embedded in the *previous* build, and the desktop
# shell — which loads the console from :7777 — looks like the rebuild did
# nothing. See the header comment.
NODE_PLIST="$HOME/Library/LaunchAgents/dev.openkin.node.plist"
NODE_BIN="$HOME/.kin/node/kin"
NODE_LABEL="dev.openkin.node"
if [[ ! -f "$NODE_PLIST" ]]; then
  echo "    (no $NODE_LABEL installed — skipping)"
elif [[ "${KIN_SKIP_NODE_REFRESH:-0}" == "1" ]]; then
  echo "    (KIN_SKIP_NODE_REFRESH=1 — skipping)"
elif [[ ! -f "$NODE_BIN" ]]; then
  echo "    ($NODE_BIN missing — run ./scripts/install-node-service.sh)"
else
  install -m 755 "$BIN" "$NODE_BIN.new"
  ./scripts/dev-sign.sh "$NODE_BIN.new" >/dev/null 2>&1 || true
  # Rename rather than overwrite: a running child keeps its old inode, so this
  # is safe whether or not the node happens to be up, and the next start picks
  # up the new file.
  mv -f "$NODE_BIN.new" "$NODE_BIN"
  # -k restarts the job so the supervisor itself is the new binary too; the
  # kill on :7777 below then bounces only the child.
  launchctl kickstart -k "gui/$(id -u)/$NODE_LABEL" >/dev/null 2>&1 || true
  echo "    refreshed $NODE_BIN and restarted $NODE_LABEL"
fi

echo "==> [4/5] stop old daemon + desktop"
# Desktop attaches to any healthy daemon on :7777 without replacing it —
# must kill first so the new binary is spawned as sidecar.
kill_port_listeners "$PORT"
# Also stop any ./kin we may have left running (even if port already freed).
if command -v pgrep >/dev/null 2>&1; then
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    # Only kill binaries from this checkout (repo-root kin or .kin-dev/kin).
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$cmd" in
      *"$ROOT/kin"*|*"$ROOT/.kin-dev/kin"*)
        echo "    kill kin pid $pid"
        kill "$pid" 2>/dev/null || true
        ;;
    esac
  done < <(pgrep -f "$ROOT/(kin|\.kin-dev/kin)" 2>/dev/null || true)
  sleep 0.2
fi
kill_desktop_dev

# Clear Chromium singleton locks for Kin-dev so relaunch doesn't bounce.
if [[ "$(uname -s)" == "Darwin" ]]; then
  for dir in \
    "$HOME/Library/Application Support/Kin-dev" \
    "$HOME/Library/Application Support/Kin"; do
    for name in SingletonLock SingletonSocket SingletonCookie; do
      rm -f "$dir/$name" 2>/dev/null || true
    done
  done
fi

echo "==> [5/5] launch desktop app"
# Icons are cheap; keep tray assets fresh like `make desktop-dev`.
if [[ -f "$ROOT/desktop/scripts/gen-icons.mjs" ]]; then
  (cd "$ROOT/desktop" && node scripts/gen-icons.mjs) || true
fi

(
  cd "$ROOT/desktop"
  if [[ ! -d node_modules ]]; then
    echo "    npm install (first run)..."
    npm install
  fi
  # `npm run dev` bundles main/preload then spawns Electron (kills prior instances).
  exec npm run dev
)
