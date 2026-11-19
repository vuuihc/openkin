#!/bin/bash
# ux-walk.sh <worktree> <outdir> [journeys-or-@files]   Boots a THROWAWAY daemon from the worktree (temp state dir, free port, never :7777),
# seeds it when scripts/journeys_seed.py exists, walks the journeys with rsi/runtime/ux/walk.mjs, tears the daemon down.
# exit 0 walked | 2 could not run (reason in <outdir>/UNAVAILABLE). The walk itself holds the machine-wide
# heavy slot (heavy.sh), like the go build and npm build shims it uses; the seed and daemon are light.
#   UX_KIN_BIN=/path/to/kin   use a prebuilt binary instead of building the worktree (baseline / tests)
#   --walker-for <worktree>   print the walker that worktree would run and exit; build-free seam for
#                             rsi/runtime/tests/test-ux-walker.sh
#   --dist-state <worktree>   print "skip" or "build: <why>" for the worktree's web/dist and exit;
#                             build-free seam for the same suite
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
# The console build is skipped only when web/dist is coherent: an index.html
# from one build can name a chunk another build replaced (a second build, an
# interrupted one, a branch cut mid-build), and the console then 404s its entry
# chunk — every journey fails and the gate reds a PR for a reason that is not
# in the PR (measured 2026-11-18/19). The walk can build, so an inconsistent
# dist means build; journeys-smoke.sh --no-build cannot build and must refuse.
# Reference rules match that script: only local /assets/ files are required
# (CDN and data: URLs are not on disk by design). Prints one line: "skip" or
# "build: <why>"; an unreadable index is not consistent, so it builds.
dist_state() {
  local state
  state="$(python3 - "$1" 2>&1 <<'PY'
import os
import re
import sys

dist = os.path.join(sys.argv[1], "web", "dist")
index = os.path.join(dist, "index.html")
assets = os.path.join(dist, "assets")
if not os.path.isfile(index):
    print("build: web/dist/index.html is missing")
    raise SystemExit
if not os.path.isdir(assets):
    print("build: web/dist/assets is missing")
    raise SystemExit
try:
    with open(index, encoding="utf-8", errors="replace") as fh:
        html = fh.read()
except OSError as exc:
    print("build: cannot read web/dist/index.html: %s" % exc)
    raise SystemExit

# Quote characters are written as hex escapes: bash 3.2 misparses a bare
# apostrophe inside a heredoc in $(...).
missing = []
for ref in re.findall(r"(?:src|href)\s*=\s*[\x22\x27]([^\x22\x27]+)[\x22\x27]", html, re.I):
    if ref.startswith(("http://", "https://", "//", "data:")):
        continue
    path = ref.split("?", 1)[0].split("#", 1)[0]
    if path.startswith("/assets/"):
        rel = path[len("/"):]
    elif path.startswith("./assets/"):
        rel = path[len("./"):]
    elif path.startswith("assets/"):
        rel = path
    else:
        continue
    if not os.path.isfile(os.path.join(dist, rel)) and path not in missing:
        missing.append(path)
if missing:
    print("build: index.html names missing chunks: " + ", ".join(missing))
else:
    print("skip")
PY
)"
  # Any other answer (python missing, a traceback) must build, one line.
  state="$(printf '%s\n' "$state" | tail -n 1)"
  case "$state" in
    skip) printf 'skip\n' ;;
    build:\ *) printf '%s\n' "$state" ;;
    *) printf 'build: dist state unreadable: %s\n' "${state:-no answer}" ;;
  esac
}
# Same answer the seam prints, as a predicate: 0 = serve the dist as it is.
dist_ready() { [ "$(dist_state "$1")" = "skip" ]; }

# Build-free seam: answer and exit before any build, daemon or output directory.
if [ "${1:-}" = "--walker-for" ]; then
  [ -n "${2:-}" ] || { echo "usage: ux-walk.sh --walker-for <worktree>" >&2; exit 2; }
  walker_for "$2"; exit 0
fi
if [ "${1:-}" = "--dist-state" ]; then
  [ -n "${2:-}" ] || { echo "usage: ux-walk.sh --dist-state <worktree>" >&2; exit 2; }
  dist_state "$2"; exit 0
fi

WT="$1"; OUT="$2"; SEL="${3:-}"; mkdir -p "$OUT"
unavail() { echo "$*" > "$OUT/UNAVAILABLE"; echo "[ux-walk] unavailable: $*" >&2; exit 2; }
# The walker is the one call in the merge lane that could wait forever; on
# 2026-11-19 a walk ran 40 minutes and from outside nobody could tell slow from
# dead. The ceiling turns that into an explicit "no verdict" (exit 2, never a
# PASS and never a red against the PR's code). RSI_WALK_MAX_S is the test/ops
# knob; the default (30 min) is ~4x the longest observed walk.
WALK_MAX_S="${RSI_WALK_MAX_S:-1800}"; case "$WALK_MAX_S" in ''|*[!0-9]*) WALK_MAX_S=1800;; esac
# Build-free seam for the timeout proof: --timeout-probe <outdir> <cmd...>.
if [ "${1:-}" = "--timeout-probe" ]; then
  [ -n "${2:-}" ] && [ "$#" -ge 3 ] || { echo "usage: ux-walk.sh --timeout-probe <outdir> <cmd...>" >&2; exit 2; }
  shift 2
  bounded_run "$WALK_MAX_S" "$@"; rc=$?
  [ "$rc" -eq 124 ] && unavail "walker exceeded ${WALK_MAX_S}s (RSI_WALK_MAX_S)"
  exit "$rc"
fi
TMP="$(mktemp -d)"; PID=""; trap '[ -n "$PID" ] && kill -KILL "$PID" 2>/dev/null; rm -rf "$TMP"' EXIT
# RSI_NO_HEAVY=1 means "read code, do not build/test" (reviewers). The walk is
# a heavy step: running it next to the gate's own build is exactly what starved
# the transcript on 2026-11-18, so fail closed and never green.
[ -n "${RSI_NO_HEAVY:-}" ] && unavail "the walk is a heavy step and needs the machine-wide slot; unset RSI_NO_HEAVY"
BIN="${UX_KIN_BIN:-}"
if [ -z "$BIN" ]; then
  dist_ready "$WT" || { ( cd "$WT/ui" && npm run build >/dev/null 2>&1 ) || unavail "ui build failed in $WT"; }
  ( cd "$WT" && go build -o "$TMP/kin" ./cmd/kin ) >"$TMP/build.log" 2>&1 || unavail "go build failed: $(tail -c 300 "$TMP/build.log")"
  BIN="$TMP/kin"
fi
# Every conversation route starts the agent CLI the daemon resolves.
# Put the worktree's fake first in PATH and pin it, so the seed's conversations
# cannot start a real model turn; journeys-smoke.sh sets the same PATH for its own
# daemon and seed, but fails hard when the fake is missing: this runner still walks
# what exists and records the skips, while the gate must not report green on
# missing fixtures.
#
# PATH order alone is not enough, and on 2026-11-19 it silently stopped being
# enough: with the fake first on PATH the daemon still answered /api/agents with
# ~/.local/bin/claude (a config under the real $HOME outranks PATH for this
# agent), so journeys_seed.py refused every conversation ("the daemon would start
# a real claude CLI") and every list/detail journey failed against an empty
# daemon; PR #366 was billed a UX-gate sendback for it. The pin below is the
# documented override and the daemon honours it ahead of PATH.
FAKE_AGENT_DIR="$WT/scripts/journeys_fake_agent"
if [ -x "$FAKE_AGENT_DIR/claude" ]; then
  PATH="$FAKE_AGENT_DIR:$PATH"; export PATH
  KIN_CLAUDE_BIN="$FAKE_AGENT_DIR/claude"; export KIN_CLAUDE_BIN
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
bounded_run "$WALK_MAX_S" bash "$RSI_DIR/runtime/heavy.sh" node "$WALKER" "${ARGS[@]}" > "$OUT/walk.log" 2>&1; rc=$?
[ $rc -eq 124 ] && unavail "walker exceeded ${WALK_MAX_S}s (RSI_WALK_MAX_S)"
[ $rc -eq 2 ] && unavail "walker could not run: $(tail -c 300 "$OUT/walk.log")"
cat "$OUT/walk.log"; exit 0
