#!/bin/bash
# One command that proves the console still works as the seven product
# journeys at phone, Mac and wide-Mac widths, against real seeded content.
#
#   scripts/journeys-smoke.sh [--out DIR] [--journeys J1,J2] [--no-build]
#                             [--no-seed] [--dry-run]
#
# It builds the console when web/dist/assets is stale (so the screens describe
# this tree), boots the real daemon on a free port with a throwaway state dir
# (never :7777, never ~/.kin), seeds it through the public HTTP API, walks
# rsi/runtime/ux/journeys.json with rsi/runtime/ux/walk.mjs, and summarizes the
# walk as one row per declared journey x viewport. PNGs, walk.json and seed.log
# stay in DIR; the path is the last line of a run.
#
# Exit: 0 clean, 1 walked with hard failures, 2 could not run
# (reason printed and written to DIR/UNAVAILABLE).
#
# Environment:
#   UX_KIN_BIN=/path/to/kin           use a prebuilt daemon instead of go build
#   PW_CORE=/path/to/playwright-core  forwarded to walk.mjs
#   RSI_FAKE_SLOW_SECS=N              how long the fake agent holds (default 10,
#                                     clamped 0..10; J3 types a follow-up while
#                                     the first round is still open)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT/rsi/runtime/ux/journeys.json"
WALK="$ROOT/rsi/runtime/ux/walk.mjs"
SEED="$ROOT/scripts/journeys_seed.py"
SUMMARY="$ROOT/scripts/journeys_smoke.py"
FAKE_AGENT_DIR="$ROOT/scripts/journeys_fake_agent"

OUT=""
JOURNEYS=""
DO_BUILD=1
DO_SEED=1
DRY=0
TMP=""
PID=""

usage() {
  cat <<'EOF'
usage: scripts/journeys-smoke.sh [--out DIR] [--journeys J1,J2] [--no-build] [--no-seed] [--dry-run]

  --out DIR        where the PNGs, walk.json and seed.log go (default: mktemp -d under /tmp)
  --journeys LIST  walk only these journey ids
  --no-build       do not rebuild the console even when web/dist/assets is stale;
                   refuses a dist whose index.html names assets that are not on disk
  --no-seed        walk an empty daemon
  --dry-run        print the plan and exit; no build, daemon, Chrome or token

exit 0 clean, 1 walked with hard failures, 2 could not run (reason in DIR/UNAVAILABLE)
EOF
}

unavail() {
  local reason="$1"
  echo "unavailable: $reason" >&2
  if [ "$DRY" = 0 ] && [ -n "$OUT" ] && [ -d "$OUT" ]; then
    printf 'unavailable: %s\n' "$reason" > "$OUT/UNAVAILABLE" 2>/dev/null || true
  fi
  exit 2
}

cleanup() {
  if [ -n "$PID" ]; then
    kill -KILL "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
    PID=""
  fi
  [ -n "$TMP" ] && rm -rf "$TMP"
  true
}
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || unavail "--out needs a directory"; OUT="$2"; shift 2 ;;
    --journeys) [ $# -ge 2 ] || unavail "--journeys needs a comma-separated list"; JOURNEYS="$2"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    --no-seed) DO_SEED=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) unavail "unknown argument: $1 (try --help)" ;;
  esac
done

command -v python3 >/dev/null 2>&1 || unavail "python3 not found"

# --no-build must not walk a dist whose index.html and assets/ came from
# different builds: the console 404s its entry chunk and every journey fails
# like a product defect (#264, and two phantom walks on #251). Refuse before
# the out dir exists and before the plan, so a dry run reports it too.
if [ "$DO_BUILD" = 0 ]; then
  DIST_STATE="$(python3 - "$ROOT" 2>&1 <<'PY'
import os
import re
import sys

dist = os.path.join(sys.argv[1], "web", "dist")
index = os.path.join(dist, "index.html")
assets = os.path.join(dist, "assets")
if not os.path.isfile(index):
    print("web/dist/index.html is missing; rebuild")
    raise SystemExit
if not os.path.isdir(assets):
    print("web/dist/assets is missing; rebuild")
    raise SystemExit
try:
    with open(index, encoding="utf-8", errors="replace") as fh:
        html = fh.read()
except OSError as exc:
    print(f"cannot read web/dist/index.html: {exc}")
    raise SystemExit

# Only local asset references are files to require: CDN and data: URLs are
# not on disk by design. Vite writes absolute /assets/ paths; relative forms
# appear in hand-built fixtures. Quote characters are written as hex escapes
# because bash 3.2 misparses a bare apostrophe inside a heredoc in $(...).
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
    print("index.html and assets disagree; rebuild (missing: " + ", ".join(missing) + ")")
PY
)"
  [ -z "$DIST_STATE" ] || unavail "$DIST_STATE"
fi

# A real run owns its out dir from here on, so every later exit 2 can leave
# DIR/UNAVAILABLE next to whatever was produced. A dry run creates nothing.
if [ "$DRY" = 0 ]; then
  if [ -z "$OUT" ]; then
    OUT="$(mktemp -d "${TMPDIR:-/tmp}/journeys-smoke.XXXXXX")" || unavail "cannot create an out dir"
  fi
  mkdir -p "$OUT" 2>/dev/null || unavail "cannot create out dir: $OUT"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/journeys-smoke-run.XXXXXX")" || unavail "cannot create a temp dir"
fi

# Resolve the requested journeys against the spec, so a typo is a usage error
# instead of a silently shortened walk, and print the declared matrix.
MATRIX="$(python3 - "$SPEC" "$ROOT/rsi/runtime/ux/spec.py" "$JOURNEYS" 2>&1 <<'PY'
import json
import subprocess
import sys

# The spec is an index with one file per journey; resolve it through its one
# reader (spec.py) so this matrix sees the same bodies the walker walks.
try:
    raw = subprocess.check_output(
        [sys.executable, sys.argv[2], "--resolve", sys.argv[1]],
        stderr=subprocess.PIPE,
    )
    spec = json.loads(raw)
except subprocess.CalledProcessError as exc:
    print(exc.stderr.decode("utf-8", "replace").strip() or f"cannot read {sys.argv[1]}")
    raise SystemExit(2)
except Exception as exc:  # noqa: BLE001 - any read/parse failure is one reason
    print(f"cannot read {sys.argv[1]}: {exc}")
    raise SystemExit(2)
known = list((spec.get("journeys") or {}).keys())
selected = [j for j in sys.argv[3].split(",") if j] or known
unknown = [j for j in selected if j not in known]
if unknown:
    print("unknown journey id: " + ", ".join(unknown) + " (known: " + ", ".join(known) + ")")
    raise SystemExit(2)
viewports = spec.get("viewports") or {}
for journey in selected:
    for viewport in spec["journeys"][journey].get("viewports") or []:
        print(f"{journey} {viewport} {viewports.get(viewport, '?')}")
PY
)"
MATRIX_RC=$?
[ "$MATRIX_RC" -eq 0 ] && [ -n "$MATRIX" ] || unavail "${MATRIX:-cannot read $SPEC}"

# The screens must describe this tree: rebuild when the bundle is older than
# the UI sources, unless the caller said not to.
NEED_BUILD=0
BUILD_REASON="--no-build"
if [ "$DO_BUILD" = 1 ]; then
  CONSOLE_STATE="$(python3 - "$ROOT" 2>/dev/null <<'PY'
import os
import sys

root = sys.argv[1]
assets = os.path.join(root, "web", "dist", "assets")
if not os.path.isdir(assets):
    print("stale: web/dist/assets is missing")
    raise SystemExit


def newest(path):
    if os.path.isfile(path):
        return os.path.getmtime(path)
    best = 0.0
    for dirpath, _, files in os.walk(path):
        for name in files:
            try:
                best = max(best, os.path.getmtime(os.path.join(dirpath, name)))
            except OSError:
                pass
    return best


ui = os.path.join(root, "ui")
inputs = [os.path.join(ui, "src"), os.path.join(ui, "index.html"), os.path.join(ui, "package.json")]
for name in ("tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs",
             "postcss.config.js", "postcss.config.mjs", "vite.config.ts",
             "vite.config.js", "tsconfig.json"):
    inputs.append(os.path.join(ui, name))
if max((newest(p) for p in inputs if os.path.exists(p)), default=0.0) > newest(assets):
    print("stale: ui sources are newer than web/dist/assets")
else:
    print("fresh")
PY
)"
  case "$CONSOLE_STATE" in
    fresh) NEED_BUILD=0; BUILD_REASON="web/dist/assets is newer than ui sources" ;;
    stale*) NEED_BUILD=1; BUILD_REASON="$CONSOLE_STATE" ;;
    *) NEED_BUILD=1; BUILD_REASON="stale: cannot compare ui sources with web/dist/assets" ;;
  esac
fi

if [ "$DRY" = 1 ]; then
  echo "journeys-smoke plan"
  if [ "$NEED_BUILD" = 1 ]; then
    echo "build console: yes ($BUILD_REASON)"
  else
    echo "build console: no ($BUILD_REASON)"
  fi
  if [ -n "${UX_KIN_BIN:-}" ]; then
    echo "daemon: UX_KIN_BIN=$UX_KIN_BIN"
  else
    echo "daemon: go build ./cmd/kin -> <tmp>/kin"
  fi
  echo "seed: $([ "$DO_SEED" = 1 ] && echo yes || echo no)"
  echo "out: ${OUT:-<mktemp -d under /tmp>}"
  echo "matrix:"
  printf '%s\n' "$MATRIX" | sed 's/^/  /'
  WALK_CMD="node rsi/runtime/ux/walk.mjs --base http://127.0.0.1:<port> --token <token> --out <out>"
  [ -n "$JOURNEYS" ] && WALK_CMD="$WALK_CMD --journeys $JOURNEYS"
  echo "walk: $WALK_CMD"
  SUM_CMD="python3 scripts/journeys_smoke.py --walk-json <out>/walk.json"
  [ -n "$JOURNEYS" ] && SUM_CMD="$SUM_CMD --journeys $JOURNEYS"
  echo "summarize: $SUM_CMD"
  exit 0
fi

command -v node >/dev/null 2>&1 || unavail "node not found (the journey walker needs node)"
command -v curl >/dev/null 2>&1 || unavail "curl not found"

# Every conversation route starts the agent CLI the daemon resolves on PATH.
# Put the fake first so the seeded conversations cannot start a real model
# turn; the export reaches only this script's children (the daemon, the seed),
# never the caller's shell, and KIN_CLAUDE_BIN would override PATH, so drop it.
if [ -x "$FAKE_AGENT_DIR/claude" ]; then
  PATH="$FAKE_AGENT_DIR:$PATH"
  export PATH
  unset KIN_CLAUDE_BIN
  # J3 types a second message while the first round is open, so the fake's
  # default 3s hold ends before the follow-up steps. Mirror ux-walk.sh: hold
  # 10s unless the caller (the mutant runner) already chose a value.
  export RSI_FAKE_SLOW_SECS="${RSI_FAKE_SLOW_SECS:-10}"
elif [ "$DO_SEED" = 1 ]; then
  unavail "fake agent missing: scripts/journeys_fake_agent/claude"
fi

if [ "$NEED_BUILD" = 1 ]; then
  echo "build: console ($BUILD_REASON)"
  if ! ( cd "$ROOT/ui" && npm run build ) >"$TMP/ui-build.log" 2>&1; then
    unavail "console build failed: $(tail -c 300 "$TMP/ui-build.log" | tr '\n' ' ')"
  fi
else
  echo "build: console skipped ($BUILD_REASON)"
fi

BIN="${UX_KIN_BIN:-}"
if [ -z "$BIN" ]; then
  command -v go >/dev/null 2>&1 || unavail "go not found (set UX_KIN_BIN to a prebuilt kin)"
  if ! ( cd "$ROOT" && go build -o "$TMP/kin" ./cmd/kin ) >"$TMP/go-build.log" 2>&1; then
    unavail "go build failed: $(tail -c 300 "$TMP/go-build.log" | tr '\n' ' ')"
  fi
  BIN="$TMP/kin"
fi
[ -x "$BIN" ] || unavail "kin binary is not executable: $BIN"

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()' 2>/dev/null)" \
  || unavail "cannot pick a free port"
[ -n "$PORT" ] || unavail "cannot pick a free port"

mkdir -p "$TMP/state"
KIN_STATE_DIR="$TMP/state" "$BIN" serve --port "$PORT" >"$TMP/daemon.log" 2>&1 &
PID=$!
READY=0
for _ in $(seq 1 120); do
  if curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    READY=1
    break
  fi
  kill -0 "$PID" 2>/dev/null || unavail "daemon exited: $(tail -c 300 "$TMP/daemon.log" | tr '\n' ' ')"
  sleep 0.25
done
[ "$READY" = 1 ] || unavail "daemon did not answer /api/health on 127.0.0.1:$PORT"

TOKEN="$(cat "$TMP/state/token" 2>/dev/null || true)"
[ -n "$TOKEN" ] || unavail "daemon wrote no token in its throwaway state dir"

if [ "$DO_SEED" = 1 ]; then
  echo "seed: $SEED"
  # Say in the seed log which binary the daemon will start for a conversation.
  RESOLVED="$(command -v claude || true)"
  case "$RESOLVED" in
    "$FAKE_AGENT_DIR"/*) echo "fake agent: claude -> scripts/journeys_fake_agent/claude" >"$OUT/seed.log" ;;
    *) unavail "seed would start a real agent: claude resolves to ${RESOLVED:-nothing}" ;;
  esac
  if ! KIN_BASE="http://127.0.0.1:$PORT" KIN_TOKEN="$TOKEN" python3 "$SEED" >>"$OUT/seed.log" 2>&1; then
    echo "seed: failed (walk continues on what exists); see $OUT/seed.log" >&2
  fi
else
  echo "seed: skipped (--no-seed), walking an empty daemon" | tee "$OUT/seed.log"
fi

WALK_ARGS=(--base "http://127.0.0.1:$PORT" --token "$TOKEN" --out "$OUT")
[ -n "$JOURNEYS" ] && WALK_ARGS+=(--journeys "$JOURNEYS")
node "$WALK" "${WALK_ARGS[@]}" >"$OUT/walk.log" 2>&1
WALK_RC=$?
cat "$OUT/walk.log"
case "$WALK_RC" in
  0) ;;
  2) unavail "walker could not run: $(tail -c 300 "$OUT/walk.log" | tr '\n' ' ')" ;;
  *) unavail "walker exited $WALK_RC: $(tail -c 300 "$OUT/walk.log" | tr '\n' ' ')" ;;
esac
[ -f "$OUT/walk.json" ] || unavail "walker wrote no walk.json (see $OUT/walk.log)"

SUMMARY_ARGS=(--walk-json "$OUT/walk.json")
[ -n "$JOURNEYS" ] && SUMMARY_ARGS+=(--journeys "$JOURNEYS")
SUMMARY_OUT="$(python3 "$SUMMARY" "${SUMMARY_ARGS[@]}" 2>&1)"
SUMMARY_RC=$?
printf '%s\n' "$SUMMARY_OUT"
if [ "$SUMMARY_RC" -eq 2 ]; then
  REASON="$(printf '%s\n' "$SUMMARY_OUT" | grep -m1 '^unavailable:' | sed 's/^unavailable: //')"
  unavail "${REASON:-summary could not read walk.json}"
fi
echo "out: $OUT"
[ "$SUMMARY_RC" -eq 0 ] && exit 0
exit 1
