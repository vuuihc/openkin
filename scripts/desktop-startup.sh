#!/usr/bin/env bash
# Measure the desktop shell's startup in isolation: spawn -> Electron ready ->
# daemon ready -> window first paint.
#
# "The app takes seconds to open" has two halves. The daemon half is measured
# by scripts/startup-baseline.sh; this script measures the shell that boots it.
# It builds the console, ./kin (gitignored build output) and desktop/dist, then
# launches the real Electron shell against a throwaway daemon on a freshly
# reserved port.
#
# One run:
#   1. `npm --prefix ui run build` — the bundles the daemon embeds; a run with
#      missing entry assets is refused before any number is taken
#   2. `go build -o <repo>/kin ./cmd/kin` (the dev shell resolves this path)
#   3. `npm --prefix desktop run build`
#   4. mktemp state + userData dirs, a free port, and one Electron launch with
#      KIN_DESKTOP_DEV=1, KIN_DESKTOP_USER_DATA, KIN_STATE_DIR, KIN_PORT,
#      KIN_STARTUP_TRACE=1 and KIN_STARTUP_ORIGIN_MS=<epoch ms before spawn>.
#   5. Read `[kin-desktop] trace <name> <ms>` lines from the shell's stdout and
#      report each mark in arrival order, `first-paint` (window-ready-to-show)
#      and `shell-total` (window-first-load).
#
# Expected shape (since #418, b47032f1): the window paints a local boot surface
# before the daemon answers. main.ts calls `boot.start(...)` above
# `await sidecar.ensureRunning()`, so `window-created`, `window-ready-to-show`
# and `window-shown` all precede `sidecar-ready`; first paint contains the boot
# page, not the console. When health answers, `boot.settle("ready")` swaps the
# console in, and `window-first-load` is emitted only for that console load —
# exactly once per run, which the required-mark check below enforces (a second
# `window-first-load` would appear more than once and fail the run). The gap
# from `sidecar-start` to `sidecar-ready` is the daemon's own boot, not a
# window waiting on it. A daemon that never becomes healthy emits no
# `sidecar-ready`, and the run fails instead of reporting the remaining marks.
#
# Safety: never touches the live node on :7777, ~/.kin, or
# ~/Library/Application Support/Kin*. Every run uses mktemp directories and a
# reserved port; a state directory under $HOME/.kin is refused before anything
# is opened. Only processes this script started are killed — Electron's own
# process group, and the daemon supervisor pid the shell itself logged (never
# whatever happens to listen on the port) — and only on completion, timeout,
# or a TERM/HUP/INT trap. Nothing is killed by name.
#
# Usage:
#   ./scripts/desktop-startup.sh [--runs N] [--json]
#   ./scripts/desktop-startup.sh --selftest
#
# --selftest builds nothing, launches no Electron and opens no network: it
# proves the mark parser, the required-mark check, the $HOME/.kin refusal and
# the reserved-port check against a fixture. It is this script's own red/green
# and is deliberately NOT wired into check.sh, because timing is not a CI gate.
#
# If Electron cannot launch here (no GUI session, or it exits before any trace
# line), the script prints `SKIP: <reason>` with the exact command and exits 2.
# It never fabricates or extrapolates a number; the plan doc row stays
# unverified until a real run succeeds.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS=3
JSON=0
SELFTEST=0
TIMEOUT_MS=120000
POLL_S=0.2

# Marks the finding needs, in the order the shell emits them. Each must appear
# exactly once in a run; the first line of defence against a half-launched
# shell that would otherwise look like a very fast one.
REQUIRED="process app-ready sidecar-start sidecar-ready window-created window-ready-to-show window-shown window-first-load"

ELECTRON="$ROOT/desktop/node_modules/.bin/electron"

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)
      [[ $# -ge 2 ]] || { echo "FAIL: --runs needs a value" >&2; usage >&2; exit 2; }
      RUNS="$2"; shift 2 ;;
    --runs=*) RUNS="${1#*=}"; shift ;;
    --json) JSON=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || [[ "$RUNS" -lt 1 ]]; then
  echo "FAIL: --runs must be a positive integer, got '$RUNS'" >&2
  exit 2
fi

BUILD_DIR="$(mktemp -d)"
LOGDIR="$(mktemp -d)"
RESULTS="$BUILD_DIR/marks.tsv"
: >"$RESULTS"

ELECTRON_PID=""
DAEMON_PID=""
PORT=""
STATE_TMP=""
USER_DATA_TMP=""
SKIP_REASON=""
# Set per run; a skip before launch (e.g. Electron absent) still prints a command.
LAUNCH_COMMAND="(not launched)"

cleanup() {
  stop_group "$ELECTRON_PID"
  ELECTRON_PID=""
  stop_daemon
  DAEMON_PID=""
  [[ -n "$STATE_TMP" ]] && rm -rf "$STATE_TMP"
  [[ -n "$USER_DATA_TMP" ]] && rm -rf "$USER_DATA_TMP"
  rm -rf "$BUILD_DIR" "$LOGDIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

say() { if [[ "$JSON" == "1" ]]; then echo "$*" >&2; else echo "$*"; fi; }

fail() { # message [log]
  local msg="$1" log="${2:-}"
  echo "FAIL: $msg" >&2
  if [[ -n "$log" && -f "$log" ]]; then
    echo "--- desktop shell log (last 30 lines) ---" >&2
    tail -30 "$log" | sed -E 's/([?&]token=)[^ &]+/\1<redacted>/g' >&2
    echo "--- end log ---" >&2
  fi
  exit 1
}

skip() { # reason
  SKIP_REASON="$1"
  echo "SKIP: $1" >&2
  echo "command: $LAUNCH_COMMAND" >&2
  if [[ "$JSON" == "1" ]]; then
    python3 - "$1" "$LAUNCH_COMMAND" <<'PY'
import json, sys
print(json.dumps({"skipped": True, "reason": sys.argv[1], "command": sys.argv[2]}, indent=2))
PY
  fi
  exit 2
}

free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

# reserve_port never hands back the daemon's default port: this script exists
# to stay away from the live node, and a run that happened to land on 7777
# would bind it. The check is on the number, before anything listens.
reserve_port() {
  local port i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    port="$(free_port)" || return 1
    [[ "$port" == "7777" ]] && continue
    printf '%s' "$port"
    return 0
  done
  return 1
}

now_ms() {
  python3 -c 'import time; print(time.time_ns() // 1_000_000)'
}

# check_state_dir refuses anything under $HOME/.kin. It resolves the throwaway
# path (which may sit behind a symlinked /var) but never probes the home state
# directory itself: the comparison is against $HOME's real path plus ".kin".
check_state_dir() { # dir
  local real home_kin
  real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1")" || return 1
  home_kin="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$HOME")/.kin"
  case "$real" in
    "$home_kin"|"$home_kin"/*)
      echo "FAIL: refusing to use a state directory under $home_kin: $real" >&2
      return 1
      ;;
  esac
}

# trace_marks keeps only the shell's own mark lines, in arrival order.
trace_marks() { # log
  grep -oE '^\[kin-desktop\] trace [a-z-]+ [0-9]+$' "$1" 2>/dev/null |
    awk '{ print $3 "\t" $4 }'
}

# missing_marks prints " name:count" for every required mark that does not
# appear exactly once. Empty output means the run is complete.
missing_marks() { # marks file
  local phase n out=""
  for phase in $REQUIRED; do
    n="$(awk -F'\t' -v p="$phase" '$1 == p { n++ } END { print n + 0 }' "$1")"
    [[ "$n" == "1" ]] || out="$out $phase:$n"
  done
  printf '%s' "$out"
}

# kill_group sends a signal to the pid's process group only when that pid is
# the group leader (which the launcher below arranges with setsid). Otherwise
# it falls back to the single pid — never `kill -- -<script's own pgid>`.
kill_group() { # pid signal
  local pid="$1" sig="$2" pgid
  [[ -n "$pid" ]] || return 0
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [[ -n "$pgid" && "$pgid" == "$pid" ]]; then
    kill -"$sig" -- "-$pid" 2>/dev/null
  else
    kill -"$sig" "$pid" 2>/dev/null
  fi
}

stop_group() { # pid
  local pid="$1" i
  [[ -n "$pid" ]] || return 0
  kill_group "$pid" TERM || return 0
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  # The group can outlive its leader (a renderer helper that ignored TERM), so
  # the hard kill targets the group even when the leader pid is already gone.
  if kill -0 -- "-$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null
  fi
  kill -KILL "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

# daemon_pid_from_log prints the supervisor pid the shell logged, if any. The
# shell names it at spawn (`daemon spawned pid=`) and again once healthy
# (`daemon ready version=… pid=`); the last one wins.
daemon_pid_from_log() { # log
  sed -nE 's/.*\[kin-desktop\] daemon (spawned|ready)( .*)? pid=([0-9]+).*/\3/p' "$1" 2>/dev/null |
    tail -1
}

# stop_daemon kills only the daemon supervisor this run's shell logged. The pid
# is captured from the shell's own line as soon as it appears — including while
# run_one is still waiting for marks — so a trap needs no port lookup. The
# supervisor is spawned detached, so it leads its own process group and the
# group also holds `kin serve`. A port with no recorded owner is never
# signalled: by cleanup time another process may have taken it.
stop_daemon() {
  [[ -n "$DAEMON_PID" ]] || return 0
  kill_group "$DAEMON_PID" TERM
  sleep 0.5
  # Same reasoning as stop_group: `kin serve` can outlive the supervisor it was
  # started under, so kill the group rather than only the leader pid.
  if kill -0 -- "-$DAEMON_PID" 2>/dev/null; then
    kill -KILL -- "-$DAEMON_PID" 2>/dev/null
  fi
  kill -KILL "$DAEMON_PID" 2>/dev/null
}

# run_one launches one isolated shell. Returns 0 measured, 1 failed, 2 skipped.
run_one() { # index
  local run="$1" origin log marks_file deadline now exited=0 timed_out=0 failed=0
  local daemon_pid name ms idx=0 lines
  PORT="$(reserve_port)" || fail "could not reserve a free port"
  STATE_TMP="$(mktemp -d)" || fail "could not create a temp state directory"
  USER_DATA_TMP="$(mktemp -d)" || fail "could not create a temp userData directory"
  check_state_dir "$STATE_TMP" || fail "refusing state directory $STATE_TMP"
  log="$LOGDIR/run-$run.log"
  marks_file="$LOGDIR/run-$run.marks"
  : >"$log"
  : >"$marks_file"

  origin="$(now_ms)"
  LAUNCH_COMMAND="KIN_DESKTOP_DEV=1 KIN_DESKTOP_USER_DATA=$USER_DATA_TMP KIN_STATE_DIR=$STATE_TMP KIN_PORT=$PORT KIN_STARTUP_TRACE=1 KIN_STARTUP_ORIGIN_MS=$origin desktop/node_modules/.bin/electron desktop"

  # setsid via python: macOS ships no setsid(1), and the Electron tree must be
  # one process group this script can stop without touching anything else.
  (
    # The shell resolves ./kin from its working directory before the app path,
    # so a caller sitting in another checkout would otherwise measure that
    # checkout's binary even though this script built this worktree's.
    cd "$ROOT/desktop" || exit 1
    unset ELECTRON_RUN_AS_NODE
    export KIN_DESKTOP_DEV=1 \
      KIN_DESKTOP_USER_DATA="$USER_DATA_TMP" \
      KIN_STATE_DIR="$STATE_TMP" \
      KIN_PORT="$PORT" \
      KIN_STARTUP_TRACE=1 \
      KIN_STARTUP_ORIGIN_MS="$origin"
    exec python3 -c 'import os,sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])' \
      "$ELECTRON" "$ROOT/desktop"
  ) >>"$log" 2>&1 &
  ELECTRON_PID=$!

  deadline=$((origin + TIMEOUT_MS))
  while :; do
    trace_marks "$log" >"$marks_file"
    # Record the supervisor as soon as the shell names it, so a trap during
    # this wait kills the daemon this run started rather than inferring one
    # from the port.
    if [[ -z "$DAEMON_PID" ]]; then
      DAEMON_PID="$(daemon_pid_from_log "$log")"
    fi
    # An unavailable daemon is a failed start; stop waiting for a readiness
    # mark that will never come.
    if grep -qF '[kin-desktop] daemon unavailable' "$log"; then
      failed=1
      break
    fi
    if [[ -z "$(missing_marks "$marks_file")" ]]; then break; fi
    if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then exited=1; break; fi
    now="$(now_ms)"
    if [[ "$now" -ge "$deadline" ]]; then timed_out=1; break; fi
    sleep "$POLL_S"
  done
  # One short settle so a final buffered line lands before the log is frozen.
  sleep 0.3
  trace_marks "$log" >"$marks_file"

  daemon_pid="$(daemon_pid_from_log "$log")"
  [[ -n "$daemon_pid" ]] && DAEMON_PID="$daemon_pid"

  stop_group "$ELECTRON_PID"
  ELECTRON_PID=""
  stop_daemon
  DAEMON_PID=""

  if [[ "$failed" == "1" ]]; then
    echo "FAIL: run $run: the shell reported the daemon unavailable; startup never reached readiness" >&2
    tail -30 "$log" >&2
    return 1
  fi

  lines="$(wc -l <"$marks_file" | tr -d ' ')"

  if [[ "$lines" == "0" ]]; then
    rm -rf "$STATE_TMP" "$USER_DATA_TMP"
    STATE_TMP=""
    USER_DATA_TMP=""
    if [[ "$timed_out" == "1" ]]; then
      SKIP_REASON="no trace line within $((TIMEOUT_MS / 1000))s"
    elif [[ "$exited" == "1" ]]; then
      SKIP_REASON="Electron exited before emitting a trace line (no GUI session, or launch failure)"
    else
      SKIP_REASON="no trace line"
    fi
    return 2
  fi

  local missing
  missing="$(missing_marks "$marks_file")"
  if [[ -n "$missing" ]]; then
    echo "FAIL: run $run missing mark(s):$missing" >&2
    tail -30 "$log" >&2
    return 1
  fi
  if [[ "$timed_out" == "1" ]]; then
    echo "FAIL: run $run timed out before all marks arrived" >&2
    tail -30 "$log" >&2
    return 1
  fi

  while IFS=$'\t' read -r name ms; do
    [[ -z "$name" ]] && continue
    idx=$((idx + 1))
    printf '%s\t%s\t%s\t%s\n' "$run" "$idx" "$name" "$ms" >>"$RESULTS"
  done <"$marks_file"

  rm -rf "$STATE_TMP" "$USER_DATA_TMP"
  STATE_TMP=""
  USER_DATA_TMP=""
  PORT=""
  return 0
}

selftest() {
  local fixture marks broken port
  fixture="$BUILD_DIR/selftest.log"
  marks="$BUILD_DIR/selftest.marks"
  broken="$BUILD_DIR/selftest-broken.marks"
  cat >"$fixture" <<'EOF'
[kin-desktop] main process starting {"electron":"33.2.1","packaged":false}
noise that must be ignored
[kin-desktop] trace process 118
[kin-desktop] trace app-ready 402
[kin-desktop] trace sidecar-start 404
[kin-desktop] trace sidecar-ready 1101
[kin-desktop] trace window-created 1106
[kin-desktop] trace window-ready-to-show 1460
[kin-desktop] trace window-shown 1462
[kin-desktop] trace window-first-load 1603
[kin-desktop] trace this line is not a mark
EOF

  trace_marks "$fixture" >"$marks"
  [[ "$(wc -l <"$marks" | tr -d ' ')" == "8" ]] ||
    fail "selftest: expected 8 parsed marks, got $(wc -l <"$marks" | tr -d ' ')"
  [[ -z "$(missing_marks "$marks")" ]] || fail "selftest: a complete fixture reported missing:$(missing_marks "$marks")"
  [[ "$(awk -F'\t' '$1 == "window-first-load" { print $2 }' "$marks")" == "1603" ]] ||
    fail "selftest: window-first-load did not parse to 1603ms"

  # A run with one required mark absent must be rejected.
  awk -F'\t' '$1 != "window-shown"' "$marks" >"$broken"
  case "$(missing_marks "$broken")" in
    *window-shown:0*) ;;
    *) fail "selftest: a missing window-shown mark was not detected" ;;
  esac

  # The containment check must refuse a state directory under $HOME/.kin.
  if check_state_dir "$HOME/.kin/desktop-startup-selftest" 2>/dev/null; then
    fail "selftest: check_state_dir accepted a path under \$HOME/.kin"
  fi

  # A freshly reserved port must not already be listening.
  port="$(reserve_port)" || fail "selftest: could not reserve a port"
  python3 - "$port" <<'PY' || fail "selftest: the reserved port is already listening"
import socket
import sys
port = int(sys.argv[1])
s = socket.socket()
s.settimeout(0.5)
try:
    s.connect(("127.0.0.1", port))
except OSError:
    print("ok: reserved port %d is not listening" % port)
    sys.exit(0)
finally:
    s.close()
print("FAIL: port %d is already listening" % port, file=sys.stderr)
sys.exit(1)
PY

  echo "ok desktop-startup selftest: 8 mark lines parsed, required-mark check rejects a gap, \$HOME/.kin refused, reserved port free"
  exit 0
}

if [[ "$SELFTEST" == "1" ]]; then
  selftest
fi

[[ -x "$ELECTRON" ]] ||
  skip "electron is not installed at desktop/node_modules/.bin/electron (run npm --prefix desktop install)"

say "building the console (the daemon embeds web/dist)"
npm --prefix "$ROOT/ui" run build >>"$LOGDIR/build.log" 2>&1 ||
  fail "npm --prefix ui run build" "$LOGDIR/build.log"

# web/dist/index.html is tracked and can be the placeholder a fresh checkout
# has; the hashed bundles beside it are ignored build output. Without them
# Electron still paints its boot screen and every mark still arrives, so the
# run would report a fast boot for a console that cannot load. Refuse to
# measure that.
if ! ls "$ROOT/web/dist/assets/"*.js >/dev/null 2>&1; then
  fail "no console entry bundle under web/dist/assets — nothing usable to embed"
fi

say "building ./kin (gitignored build output)"
(cd "$ROOT" && go build -o "$ROOT/kin" ./cmd/kin) || fail "go build ./cmd/kin"

say "building the desktop shell"
npm --prefix "$ROOT/desktop" run build >>"$LOGDIR/build.log" 2>&1 ||
  fail "npm --prefix desktop run build" "$LOGDIR/build.log"

say "desktop startup, $RUNS run(s), throwaway state + userData, reserved ports"

run=1
while [[ "$run" -le "$RUNS" ]]; do
  say "run $run/$RUNS"
  run_one "$run"
  rc=$?
  if [[ "$rc" == "2" ]]; then
    skip "${SKIP_REASON:-Electron produced no startup trace}"
  fi
  [[ "$rc" == "0" ]] || exit 1
  run=$((run + 1))
done

python3 - "$RESULTS" "$JSON" "$RUNS" "$REQUIRED" <<'PY'
import json
import statistics
import sys

results_path, want_json, runs, required = sys.argv[1:5]
required = required.split()

rows = [line.rstrip("\n").split("\t") for line in open(results_path) if line.strip()]
order = []
per_run = {}
for run, idx, name, ms in rows:
    if name not in order:
        order.append(name)
    per_run.setdefault(int(run), []).append((int(idx), name, int(ms)))

def summary(marks):
    by_name = {name: ms for _idx, name, ms in marks}
    return {
        "marks": by_name,
        "first_paint_ms": by_name.get("window-ready-to-show"),
        # The last mark that arrived. did-finish-load can precede ready-to-show
        # by a millisecond or two, so naming one specific mark here would make
        # the total smaller than first paint in some runs.
        "shell_total_ms": max(ms for _idx, _name, ms in marks),
    }

runs_out = []
for run in sorted(per_run):
    marks = sorted(per_run[run])
    entry = {"run": run}
    entry.update(summary(marks))
    runs_out.append(entry)

def median(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values)) if values else None

medians = {}
for name in order:
    medians[name] = median([entry["marks"].get(name) for entry in runs_out])
medians["first-paint"] = median([entry["first_paint_ms"] for entry in runs_out])
medians["shell-total"] = median([entry["shell_total_ms"] for entry in runs_out])

if want_json == "1":
    print(json.dumps({
        "runs": int(runs),
        "required": required,
        "mark_names": order,
        "per_run": runs_out,
        "median_ms": medians,
    }, indent=2))
    sys.exit(0)

for entry in runs_out:
    print()
    print("run %d: marks (ms since spawn)" % entry["run"])
    for _idx, name, ms in sorted(per_run[entry["run"]]):
        print("  %-24s %6d" % (name, ms))
    print("  first-paint=%sms shell-total=%sms"
          % (entry["first_paint_ms"], entry["shell_total_ms"]))

width = max([len("mark")] + [len(name) for name in order] + [len("first-paint"), len("shell-total")]) + 2
print()
print("%-*s %8s" % (width, "mark", "median"))
print("%s %s" % ("-" * width, "-" * 8))
for name in order:
    print("%-*s %8s" % (width, name, medians.get(name)))
print("%s %s" % ("-" * width, "-" * 8))
print("%-*s %8s" % (width, "first-paint", medians.get("first-paint")))
print("%-*s %8s" % (width, "shell-total", medians.get("shell-total")))
print()
print("first-paint is window-ready-to-show; shell-total is the last mark.")
print("did-finish-load can arrive a millisecond before ready-to-show.")
print("Since #418 the boot is not daemon-gated: window-ready-to-show precedes")
print("sidecar-ready (the boot surface paints first); the sidecar-start ->")
print("sidecar-ready gap is the daemon's own boot, and window-first-load fires")
print("once, for the console load that replaces the boot surface.")
PY
