#!/usr/bin/env bash
# Boot the real daemon in a throwaway state directory and check the surfaces a
# person hits first: health, the embedded console, the authenticated API, one
# write, and a restart on the same database.
#
# `go test ./...` never starts cmd/kin, so a bad flag, an embed that lost its
# entry chunk, or a migration that only fails against a real database would
# pass every unit test and still leave the product unable to boot. This is the
# gate for that.
#
# Usage:
#   ./scripts/smoke.sh
#   KIN_SMOKE_REQUIRE_ASSETS=1 ./scripts/smoke.sh
#
# KIN_SMOKE_REQUIRE_ASSETS=1 makes the entry-chunk check strict. CI builds the
# console first and sets it; a fresh clone's tracked placeholder index points
# at assets that are deliberately not committed, so the default stays lenient.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$(mktemp -d)"
BIN="$BUILD_DIR/kin"
STATE="$(mktemp -d)"
LOG="$(mktemp)"
PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
BASE="http://127.0.0.1:$PORT"
PID=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  rm -rf "$BUILD_DIR" "$STATE" "$LOG"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- daemon log ---" >&2
  tail -40 "$LOG" >&2
  exit 1
}

echo "building ./kin"
(cd "$ROOT" && go build -o "$BIN" ./cmd/kin) || fail "go build ./cmd/kin"

start() {
  KIN_STATE_DIR="$STATE" "$BIN" serve --port "$PORT" >>"$LOG" 2>&1 &
  PID=$!
  local i
  for i in $(seq 1 120); do
    if curl -fsS -o /dev/null "$BASE/api/health" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
      fail "the daemon exited before answering /api/health"
    fi
    sleep 0.25
  done
  fail "the daemon did not answer /api/health within 30s"
}

stop() {
  kill "$PID" 2>/dev/null
  local i
  for i in $(seq 1 40); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$PID" 2>/dev/null; then
    fail "the daemon did not exit within 10s of SIGTERM"
  fi
  wait "$PID" 2>/dev/null
  local code=$?
  PID=""
  [[ "$code" == "0" ]] || fail "the daemon exited $code on SIGTERM"
}

api() { # method path [body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -s -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d "$body" "$BASE$path"
  else
    curl -s -X "$method" -H "Authorization: Bearer $TOKEN" "$BASE$path"
  fi
}

status() { # method path
  curl -s -o /dev/null -w '%{http_code}' -X "$1" \
    -H "Authorization: Bearer $TOKEN" "$BASE$2"
}

check_status() { # want path
  local want="$1" path="$2" code
  code=$(status GET "$path")
  [[ "$code" == "$want" ]] || fail "GET $path = $code, want $want"
}

start
TOKEN="$(cat "$STATE/token" 2>/dev/null)" || fail "the daemon wrote no master token"
[[ ${#TOKEN} -ge 32 ]] || fail "the master token looks wrong (length ${#TOKEN})"

html="$(curl -s "$BASE/")" || fail "GET /"
grep -q 'id="root"' <<<"$html" || fail "GET / did not return the console shell"

if [[ "${KIN_SMOKE_REQUIRE_ASSETS:-0}" == "1" ]]; then
  asset="$(grep -oE '/assets/[a-zA-Z0-9._-]+\.js' <<<"$html" | head -1)"
  [[ -n "$asset" ]] || fail "the console HTML names no entry chunk"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$asset")
  [[ "$code" == "200" ]] || fail "the entry chunk $asset = $code"
fi

for path in /api/agents /api/tasks /api/routines /api/settings; do
  check_status 200 "$path"
done

# A write proves the database, the JSON contract and the authenticated path are
# wired together, not just that the process answers reads.
created="$(api POST /api/routines '{"title":"smoke","cwd":"/tmp","agent":"claude-code","prompt":"smoke","interval_secs":3600,"enabled":false}')"
routine_id="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])' <<<"$created" 2>/dev/null)" ||
  fail "POST /api/routines: $created"
code=$(status DELETE "/api/routines/$routine_id")
[[ "$code" == "200" || "$code" == "204" ]] || fail "DELETE /api/routines/$routine_id = $code"

# Restart on the same state directory: startup and migrations must be
# idempotent, which an empty-database boot alone does not prove.
stop
start
TOKEN="$(cat "$STATE/token")"
check_status 200 /api/tasks
stop

if grep -qE 'panic:|fatal error:' "$LOG"; then
  fail "the daemon log contains a panic"
fi

echo "ok smoke: health, console, API, write, restart"
