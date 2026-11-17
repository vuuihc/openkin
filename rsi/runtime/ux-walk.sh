#!/bin/bash
# ux-walk.sh <worktree> <outdir> [journeys-or-@files]   Boots a THROWAWAY daemon from the worktree (temp state dir, free port, never :7777),
# seeds it when scripts/journeys_seed.py exists, walks the journeys with rsi/runtime/ux/walk.mjs, tears the daemon down.
# exit 0 walked | 2 could not run (reason in <outdir>/UNAVAILABLE). Heavy steps (go build, npm build) go through the heavy.sh shims.
#   UX_KIN_BIN=/path/to/kin   use a prebuilt binary instead of building the worktree (baseline / tests)
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
WT="$1"; OUT="$2"; SEL="${3:-}"; mkdir -p "$OUT"
unavail() { echo "$*" > "$OUT/UNAVAILABLE"; echo "[ux-walk] unavailable: $*" >&2; exit 2; }
TMP="$(mktemp -d)"; PID=""; trap '[ -n "$PID" ] && kill -KILL "$PID" 2>/dev/null; rm -rf "$TMP"' EXIT
BIN="${UX_KIN_BIN:-}"
if [ -z "$BIN" ]; then
  [ -d "$WT/web/dist/assets" ] || { ( cd "$WT/ui" && npm run build >/dev/null 2>&1 ) || unavail "ui build failed in $WT"; }
  ( cd "$WT" && go build -o "$TMP/kin" ./cmd/kin ) >"$TMP/build.log" 2>&1 || unavail "go build failed: $(tail -c 300 "$TMP/build.log")"
  BIN="$TMP/kin"
fi
# Every conversation route starts the agent CLI the daemon resolves on PATH.
# Put the worktree's fake first so the seed's conversations cannot start a real
# model turn; the export reaches only this script's children, and
# KIN_CLAUDE_BIN would override PATH, so drop it. journeys-smoke.sh sets the
# same PATH for its own daemon and seed, but fails hard when the fake is
# missing: this runner still walks what exists and records the skips, while the
# gate must not report green on missing fixtures.
FAKE_AGENT_DIR="$WT/scripts/journeys_fake_agent"
if [ -x "$FAKE_AGENT_DIR/claude" ]; then
  PATH="$FAKE_AGENT_DIR:$PATH"; export PATH; unset KIN_CLAUDE_BIN
fi
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
mkdir -p "$TMP/state"
KIN_STATE_DIR="$TMP/state" "$BIN" serve --port "$PORT" >"$TMP/daemon.log" 2>&1 & PID=$!
for i in $(seq 1 120); do curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null && break; kill -0 "$PID" 2>/dev/null || unavail "daemon exited: $(tail -c 300 "$TMP/daemon.log")"; sleep 0.25; done
curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" || unavail "daemon did not answer /api/health"
TOKEN="$(cat "$TMP/state/token" 2>/dev/null)"; [ -n "$TOKEN" ] || unavail "no token written"
# Seed from the worktree when it has the script. A worktree cut before the seed
# landed does not, so run origin/main's copy through `python3 -`: the walk should
# describe the PR, not the age of the branch. A missing seed on both is not a
# failure — the walk records empty states and the journeys that need fixtures skip.
if [ -f "$WT/scripts/journeys_seed.py" ]; then
  echo "seed: $WT/scripts/journeys_seed.py" > "$OUT/seed.log"
  # Record which binary the daemon will start for a conversation. The seed
  # checks the same resolution again before it creates anything.
  RESOLVED="$(command -v claude || true)"
  case "$RESOLVED" in
    "$FAKE_AGENT_DIR"/*) echo "fake agent: claude -> scripts/journeys_fake_agent/claude" >> "$OUT/seed.log" ;;
    *) echo "fake agent: MISSING (claude resolves to ${RESOLVED:-nothing}); no conversations will be seeded" >> "$OUT/seed.log" ;;
  esac
  KIN_BASE="http://127.0.0.1:$PORT" KIN_TOKEN="$TOKEN" python3 "$WT/scripts/journeys_seed.py" >>"$OUT/seed.log" 2>&1 || echo "seed failed (walk continues on what exists)" >> "$OUT/seed.log"
elif git -C "$WT" cat-file -e origin/main:scripts/journeys_seed.py 2>/dev/null; then
  echo "seed: origin/main:scripts/journeys_seed.py (this worktree has none)" > "$OUT/seed.log"
  git -C "$WT" show origin/main:scripts/journeys_seed.py | KIN_BASE="http://127.0.0.1:$PORT" KIN_TOKEN="$TOKEN" python3 - >>"$OUT/seed.log" 2>&1 || echo "seed failed (walk continues on what exists)" >> "$OUT/seed.log"
else
  echo "no scripts/journeys_seed.py in the worktree or origin/main: walking an empty daemon (empty states only)" > "$OUT/seed.log"
fi
ARGS=(--base "http://127.0.0.1:$PORT" --token "$TOKEN" --out "$OUT")
[ -f "$WT/rsi/runtime/ux/journeys.json" ] && ARGS+=(--spec "$WT/rsi/runtime/ux/journeys.json")
case "$SEL" in @*) ARGS+=(--files "${SEL#@}");; ?*) ARGS+=(--journeys "$SEL");; esac
# The walker must come from the same tree as the spec above: a branch that adds
# a step op or a placeholder would otherwise feed its new spec to the control
# tree's older walker ("unknown step op", unsubstituted URLs in goto).
WALKER="$WT/rsi/runtime/ux/walk.mjs"
[ -f "$WALKER" ] || WALKER="$RSI_DIR/runtime/ux/walk.mjs"
node "$WALKER" "${ARGS[@]}" > "$OUT/walk.log" 2>&1; rc=$?
[ $rc -eq 2 ] && unavail "walker could not run: $(tail -c 300 "$OUT/walk.log")"
cat "$OUT/walk.log"; exit 0
