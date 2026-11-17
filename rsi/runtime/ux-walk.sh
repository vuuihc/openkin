#!/bin/bash
# ux-walk.sh <worktree> <outdir> [journeys-or-@files]   Boots a THROWAWAY daemon from the worktree (temp state dir, free port, never :7777),
# seeds it when scripts/journeys_seed.py exists, walks the journeys with rsi/runtime/ux/walk.mjs, tears the daemon down.
# exit 0 walked | 2 could not run (reason in <outdir>/UNAVAILABLE). Heavy steps (go build, npm build) go through the heavy.sh shims.
#   UX_KIN_BIN=/path/to/kin   use a prebuilt binary instead of building the worktree (baseline / tests)
#   --walker-for <worktree>   print the walker that worktree would run and exit; build-free seam for
#                             rsi/runtime/tests/test-ux-walker.sh
set -u
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

# The walker must come from the same tree as the spec: a branch that adds a
# step op or a placeholder would otherwise feed its new spec to the control
# tree's older walker ("unknown step op", unsubstituted URLs in goto). The seam
# below and the real walk both print through this one function, so a later edit
# cannot reintroduce the control-tree walker for a branch that carries its own.
walker_for() {
  local wt="$1"
  if [ -f "$wt/rsi/runtime/ux/walk.mjs" ]; then
    printf '%s\n' "$wt/rsi/runtime/ux/walk.mjs"
  else
    printf '%s\n' "$RSI_DIR/runtime/ux/walk.mjs"
  fi
}
# Build-free seam: answer and exit before any build, daemon or output directory.
if [ "${1:-}" = "--walker-for" ]; then
  [ -n "${2:-}" ] || { echo "usage: ux-walk.sh --walker-for <worktree>" >&2; exit 2; }
  walker_for "$2"; exit 0
fi

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
  # J3 types a second message while the first round is open, so the fake's
  # `[seed] slow` hold must cover the follow-up steps. The fake clamps at 10s;
  # an explicit value from the caller (the mutant runner) still wins.
  export RSI_FAKE_SLOW_SECS="${RSI_FAKE_SLOW_SECS:-10}"
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
# RSI_UX_SPEC points at a variant of this tree's spec (walk-mutant-test.sh cuts
# J3 down to its hand-off half for the delayed walk). The default is the tree's
# own spec; either way the walker comes from the same tree.
SPEC="${RSI_UX_SPEC:-$WT/rsi/runtime/ux/journeys.json}"
[ -f "$SPEC" ] && ARGS+=(--spec "$SPEC")
case "$SEL" in @*) ARGS+=(--files "${SEL#@}");; ?*) ARGS+=(--journeys "$SEL");; esac
# The mutant proof needs the task-detail answer held: the message the draft
# showed must be on screen before the first detail GET lands. Unset (the gate)
# adds nothing, so the walker's default 0 installs no route.
[ -n "${RSI_UX_DELAY_TASKS_MS:-}" ] && ARGS+=(--delay-tasks "$RSI_UX_DELAY_TASKS_MS")
# Same selection as the seam above: one writer, so the walker and the spec
# cannot come from different trees.
WALKER="$(walker_for "$WT")"
node "$WALKER" "${ARGS[@]}" > "$OUT/walk.log" 2>&1; rc=$?
[ $rc -eq 2 ] && unavail "walker could not run: $(tail -c 300 "$OUT/walk.log")"
cat "$OUT/walk.log"; exit 0
