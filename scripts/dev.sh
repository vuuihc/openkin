#!/usr/bin/env bash
# Full-stack dev: Vite HMR (frontend) + auto-rebuild/restart (backend).
#
# Usage:
#   ./scripts/dev.sh                 # backend :7777, vite :5173
#   ./scripts/dev.sh --lan           # extra flags → `kin serve`
#   make dev
#   make dev ARGS='--lan'
#   KIN_PORT=8888 ./scripts/dev.sh
#
# Open: http://127.0.0.1:5173  (/api and /api/ws proxied to backend)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${KIN_PORT:-7777}"
VITE_PORT="${KIN_VITE_PORT:-5173}"
BIN="${KIN_DEV_BIN:-$ROOT/.kin-dev/kin}"
POLL_SEC="${KIN_WATCH_INTERVAL:-1}"

SERVE_ARGS=()
if [[ -n "${KIN_SERVE_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  SERVE_ARGS=($KIN_SERVE_ARGS)
fi
while [[ $# -gt 0 ]]; do
  SERVE_ARGS+=("$1")
  shift
done

mkdir -p "$(dirname "$BIN")"

PIDS=()
BACKEND_PID=""

cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "==> shutting down dev stack..."
  if [[ -n "${BACKEND_PID}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # kill whole process group if vite spawned children
      kill -- -"$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if command -v lsof >/dev/null 2>&1; then
    for p in "$PORT" "$VITE_PORT"; do
      # shellcheck disable=SC2046
      kill $(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null) 2>/dev/null || true
    done
  fi
  echo "==> done"
}
trap cleanup EXIT INT TERM

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing required command: $1" >&2
    exit 1
  fi
}

need_cmd go
need_cmd npm

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

# Stop leftover stack from a previous run (ports + this checkout's kin binary).
echo "==> stopping existing processes (if any)"
kill_port_listeners "$PORT"
kill_port_listeners "$VITE_PORT"
if command -v pgrep >/dev/null 2>&1; then
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
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

# --- Frontend: Vite HMR (proxies /api → backend; see ui/vite.config.ts) ---
echo "==> starting Vite on http://127.0.0.1:${VITE_PORT}"
(
  cd "$ROOT/ui"
  if [[ ! -d node_modules ]]; then
    echo "    npm install (first run)..."
    npm install
  fi
  export KIN_PORT="$PORT"
  exec npx vite --port "$VITE_PORT" --strictPort --host 127.0.0.1
) &
PIDS+=($!)

build_backend() {
  echo "==> go build → $BIN"
  go build -o "$BIN" ./cmd/kin
}

start_backend() {
  if [[ -n "${BACKEND_PID}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "==> stopping backend (pid $BACKEND_PID)"
    kill "$BACKEND_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$BACKEND_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    BACKEND_PID=""
  fi
  if command -v lsof >/dev/null 2>&1; then
    # shellcheck disable=SC2046
    kill $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null) 2>/dev/null || true
    sleep 0.15
  fi

  echo "==> kin serve --port $PORT ${SERVE_ARGS[*]:-}"
  # Avoid word-splitting issues when SERVE_ARGS is empty under set -u
  if ((${#SERVE_ARGS[@]})); then
    KIN_PORT="$PORT" "$BIN" serve --port "$PORT" "${SERVE_ARGS[@]}" &
  else
    KIN_PORT="$PORT" "$BIN" serve --port "$PORT" &
  fi
  BACKEND_PID=$!
  echo "    backend pid $BACKEND_PID"
}

# Content fingerprint of Go sources (poll-based; no extra deps like air/fswatch).
go_fingerprint() {
  if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    {
      git -C "$ROOT" ls-files -z -- \
        'cmd/**/*.go' 'internal/**/*.go' 'web/**/*.go' 'go.mod' 'go.sum' 2>/dev/null
      git -C "$ROOT" ls-files -z --others --exclude-standard -- \
        'cmd/**/*.go' 'internal/**/*.go' 'web/**/*.go' 2>/dev/null
    } | sort -z | xargs -0 shasum 2>/dev/null | shasum | awk '{print $1}'
    return
  fi
  find "$ROOT/cmd" "$ROOT/internal" "$ROOT/web" \
    \( -name '*.go' \) -type f 2>/dev/null \
    | sort \
    | xargs shasum 2>/dev/null \
    | cat - "$ROOT/go.mod" "$ROOT/go.sum" 2>/dev/null \
    | shasum \
    | awk '{print $1}'
}

build_backend
start_backend

echo ""
echo "┌──────────────────────────────────────────────────────────┐"
echo "│  Kin dev stack                                           │"
printf "│  UI  (HMR):  http://127.0.0.1:%-5s                       │\n" "$VITE_PORT"
printf "│  API       :  http://127.0.0.1:%-5s                       │\n" "$PORT"
echo "│  Backend rebuilds on Go / go.mod changes                 │"
echo "│  Frontend hot-reloads via Vite                           │"
echo "│  Ctrl+C to stop                                          │"
echo "└──────────────────────────────────────────────────────────┘"
echo ""

LAST_FP="$(go_fingerprint || true)"

while true; do
  if ! kill -0 "${PIDS[0]}" 2>/dev/null; then
    echo "error: Vite exited unexpectedly" >&2
    exit 1
  fi

  if [[ -n "${BACKEND_PID}" ]] && ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "==> backend exited; rebuilding..."
    wait "$BACKEND_PID" 2>/dev/null || true
    BACKEND_PID=""
    if build_backend; then
      start_backend
      LAST_FP="$(go_fingerprint || true)"
    else
      echo "    build failed; will retry on next change"
    fi
  fi

  FP="$(go_fingerprint || true)"
  if [[ -n "$FP" && "$FP" != "$LAST_FP" ]]; then
    echo "==> change detected"
    if build_backend; then
      start_backend
    else
      echo "    build failed; keeping previous process if still running"
    fi
    LAST_FP="$FP"
  fi
  sleep "$POLL_SEC"
done
