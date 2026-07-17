#!/usr/bin/env bash
# One-shot: rebuild UI + kin binary, kill old daemon/desktop, relaunch Electron.
#
# Usage:
#   ./scripts/desktop-rebuild.sh
#   make desktop-rebuild
#
# Unlike `make desktop-dev` (backend only + Electron), this always:
#   1. builds the Vite UI into web/dist (embedded by Go)
#   2. builds ./kin with the new embed
#   3. stops any daemon on :7777 (desktop otherwise attaches to the old one)
#   4. stops previous Kin Electron for this repo
#   5. launches desktop (npm run dev)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${KIN_PORT:-7777}"
BIN="${KIN_BIN:-$ROOT/kin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing required command: $1" >&2
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

echo "==> [1/4] build UI (ui → web/dist)"
(
  cd "$ROOT/ui"
  if [[ ! -d node_modules ]]; then
    echo "    npm install (first run)..."
    npm install
  fi
  npm run build
)

echo "==> [2/4] go build → $BIN"
go build -o "$BIN" ./cmd/kin
chmod +x "$BIN"

echo "==> [3/4] stop old daemon + desktop"
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

echo "==> [4/4] launch desktop app"
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
